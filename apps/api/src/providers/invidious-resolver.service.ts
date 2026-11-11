import { Injectable } from '@nestjs/common';

export interface InvidiousResolvedMedia {
  providerId: 'youtube';
  mediaId: string;
  title: string;
  author: string | null;
  durationSeconds: number;
  mimeType: string;
  bitrate: number;
  streamUrl: string;
  instanceUrl: string;
}

interface InvidiousFormat {
  type?: unknown;
  url?: unknown;
  bitrate?: unknown;
}

interface InvidiousVideo {
  title?: unknown;
  author?: unknown;
  lengthSeconds?: unknown;
  adaptiveFormats?: unknown;
}

export interface InvidiousResolverOptions {
  instanceUrl?: string;
  request?: typeof fetch;
  timeoutMs?: number;
}

export class InvidiousResolutionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'InvidiousResolutionError';
  }
}

export function extractYouTubeVideoId(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvidiousResolutionError('Media URL is invalid.', 'INVALID_MEDIA_URL');
  }

  const host = url.hostname.toLowerCase().replace(/^www\\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (/^\\/(shorts|embed|live)\\//.test(url.pathname)) {
      id = url.pathname.split('/')[2] ?? null;
    }
  }

  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new InvidiousResolutionError('Media URL must identify one YouTube video.', 'INVALID_YOUTUBE_VIDEO');
  }
  return id;
}

@Injectable()
export class InvidiousResolverService {
  private readonly request: typeof fetch;
  private readonly instanceUrl: URL;
  private readonly timeoutMs: number;

  constructor(options: InvidiousResolverOptions = {}) {
    const configured = options.instanceUrl ?? process.env.INVIDIOUS_INSTANCE_URL;
    if (!configured) throw new Error('INVIDIOUS_INSTANCE_URL must identify the configured Invidious instance.');
    this.instanceUrl = new URL(configured);
    if (
      !['https:', ...(process.env.NODE_ENV === 'production' ? [] : ['http:'])].includes(this.instanceUrl.protocol) ||
      this.instanceUrl.username ||
      this.instanceUrl.password ||
      this.instanceUrl.search ||
      this.instanceUrl.hash
    ) {
      throw new Error('Invidious instance URL must be a credential-free HTTPS URL.');
    }
    this.instanceUrl.pathname = this.instanceUrl.pathname.replace(/\\/$/, '');
    this.request = options.request ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) {
      throw new TypeError('Invidious timeout must be between 1000 and 30000 milliseconds.');
    }
  }

  async resolve(mediaUrl: string): Promise<InvidiousResolvedMedia> {
    const mediaId = extractYouTubeVideoId(mediaUrl);
    const endpoint = new URL(
      `${this.instanceUrl.pathname}/api/v1/videos/${encodeURIComponent(mediaId)}`,
      this.instanceUrl.origin,
    );

    let response: Response;
    try {
      response = await this.request(endpoint, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new InvidiousResolutionError('The Invidious instance could not be reached.', 'INVIDIOUS_UNAVAILABLE');
    }
    if (!response.ok) {
      throw new InvidiousResolutionError(
        `The Invidious instance returned HTTP ${response.status}.`,
        response.status === 404 ? 'MEDIA_NOT_FOUND' : 'INVIDIOUS_HTTP_ERROR',
      );
    }

    let video: InvidiousVideo;
    try {
      video = (await response.json()) as InvidiousVideo;
    } catch {
      throw new InvidiousResolutionError('The Invidious response was not valid JSON.', 'INVALID_INVIDIOUS_RESPONSE');
    }
    if (
      typeof video.title !== 'string' ||
      typeof video.lengthSeconds !== 'number' ||
      !Number.isSafeInteger(video.lengthSeconds) ||
      video.lengthSeconds < 0 ||
      !Array.isArray(video.adaptiveFormats)
    ) {
      throw new InvidiousResolutionError('The Invidious response omitted required video metadata.', 'INVALID_INVIDIOUS_RESPONSE');
    }

    const formats = (video.adaptiveFormats as InvidiousFormat[])
      .filter((format) =>
        typeof format.type === 'string' &&
        /^audio\\//i.test(format.type) &&
        typeof format.url === 'string' &&
        Number.isFinite(Number(format.bitrate)) &&
        Number(format.bitrate) > 0,
      )
      .map((format) => {
        const streamUrl = new URL(format.url as string);
        if (streamUrl.protocol !== 'https:' || streamUrl.username || streamUrl.password) return null;
        return {
          mimeType: (format.type as string).split(';', 1)[0]!.trim().toLowerCase(),
          bitrate: Number(format.bitrate),
          streamUrl: streamUrl.toString(),
        };
      })
      .filter((format): format is NonNullable<typeof format> => format !== null)
      .sort((left, right) => right.bitrate - left.bitrate);

    const selected = formats[0];
    if (!selected) {
      throw new InvidiousResolutionError('No usable audio stream was returned for this video.', 'AUDIO_STREAM_UNAVAILABLE');
    }

    return {
      providerId: 'youtube',
      mediaId,
      title: video.title,
      author: typeof video.author === 'string' ? video.author : null,
      durationSeconds: video.lengthSeconds,
      ...selected,
      instanceUrl: this.instanceUrl.origin,
    };
  }
}
