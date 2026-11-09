import { isIP } from 'node:net';

export interface InvidiousTransportResponse {
  status: number;
  data: unknown;
}

export interface InvidiousTransport {
  request(input: {
    baseUrl: string;
    path: string;
    query?: Record<string, string>;
    timeoutMs: number;
  }): Promise<InvidiousTransportResponse>;
}

export interface InvidiousVideo {
  mediaId: string;
  title: string;
  artist: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  canonicalUrl: string;
  instanceUrl: string;
}

export interface YouTubeInvidiousAdapterOptions {
  instances?: string[];
  transport?: InvidiousTransport;
  timeoutMs?: number;
}

export class InvidiousProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'InvidiousProviderError';
  }
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_INSTANCES = 5;

export class YouTubeInvidiousAdapter {
  readonly providerId = 'youtube';
  readonly contractVersion = 1;
  readonly capabilities = {
    search: true,
    resolve: true,
    playback: false,
    pause: false,
    resume: false,
    seek: false,
    queue: false,
    maxDurationSeconds: null,
    mediaTypes: ['audio', 'video'] as const,
  };

  private readonly instances: string[];
  private readonly transport: InvidiousTransport;
  private readonly timeoutMs: number;

  constructor(options: YouTubeInvidiousAdapterOptions = {}) {
    this.instances = (options.instances ?? []).map(validateInstanceUrl).slice(0, MAX_INSTANCES);
    this.transport = options.transport ?? createFetchTransport();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new TypeError('Invidious timeoutMs must be between 100 and 60000.');
    }
  }

  async healthCheck(): Promise<{
    status: 'healthy' | 'unavailable' | 'unconfigured';
    instanceUrl?: string;
  }> {
    if (this.instances.length === 0) return { status: 'unconfigured' };
    for (const instanceUrl of this.instances) {
      try {
        const response = await this.transport.request({
          baseUrl: instanceUrl,
          path: '/api/v1/stats',
          timeoutMs: this.timeoutMs,
        });
        if (response.status >= 200 && response.status < 300 && isRecord(response.data)) {
          return { status: 'healthy', instanceUrl };
        }
      } catch {
        // Try the next operator-configured instance.
      }
    }
    return { status: 'unavailable' };
  }

  async search(input: { query: string }): Promise<InvidiousVideo[]> {
    const query = requiredText(input.query, 'query', 200);
    const response = await this.requestWithFallback('/api/v1/search', { q: query, type: 'video', page: '1' });
    if (!Array.isArray(response.data)) {
      throw new InvidiousProviderError('Invidious returned an invalid search response.', 'INVALID_RESPONSE');
    }
    return response.data
      .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'video')
      .map((item) => mapVideo(item, response.instanceUrl))
      .filter((item): item is InvidiousVideo => item !== null);
  }

  async resolve(input: { mediaId: string }): Promise<InvidiousVideo> {
    const mediaId = requiredText(input.mediaId, 'mediaId', 11);
    if (!VIDEO_ID.test(mediaId)) {
      throw new InvidiousProviderError('YouTube video ID is invalid.', 'INVALID_MEDIA_ID', 400);
    }
    const response = await this.requestWithFallback(
      `/api/v1/videos/${encodeURIComponent(mediaId)}`,
    );
    if (!isRecord(response.data)) {
      throw new InvidiousProviderError('Invidious returned invalid video metadata.', 'INVALID_RESPONSE');
    }
    const video = mapVideo(response.data, response.instanceUrl);
    if (!video) {
      throw new InvidiousProviderError('Invidious video metadata is incomplete.', 'INVALID_RESPONSE');
    }
    return video;
  }

  async play(): Promise<never> {
    throw new InvidiousProviderError(
      'Direct playback is not enabled for the Invidious adapter. Use an approved playback path.',
      'PLAYBACK_NOT_SUPPORTED',
    );
  }

  async disconnect(): Promise<{ disconnected: true }> {
    return { disconnected: true };
  }

  private async requestWithFallback(
    path: string,
    query?: Record<string, string>,
  ): Promise<InvidiousTransportResponse & { instanceUrl: string }> {
    if (this.instances.length === 0) {
      throw new InvidiousProviderError('No Invidious instances are configured.', 'NOT_CONFIGURED');
    }
    let lastError: unknown;
    for (const instanceUrl of this.instances) {
      try {
        const response = await this.transport.request({
          baseUrl: instanceUrl,
          path,
          ...(query ? { query } : {}),
          timeoutMs: this.timeoutMs,
        });
        if (response.status >= 200 && response.status < 300) {
          return { ...response, instanceUrl };
        }
        lastError = new InvidiousProviderError(
          'Configured Invidious instance rejected the request.',
          response.status === 404 ? 'MEDIA_NOT_FOUND' : 'UPSTREAM_ERROR',
          response.status,
        );
        if (response.status >= 400 && response.status < 500 && response.status !== 404) {
          throw lastError;
        }
      } catch (error) {
        if (error instanceof InvidiousProviderError && error.code !== 'MEDIA_NOT_FOUND') {
          throw error;
        }
        lastError = error;
      }
    }
    if (lastError instanceof InvidiousProviderError) throw lastError;
    throw new InvidiousProviderError(
      'All configured Invidious instances are unavailable.',
      'PROVIDER_UNAVAILABLE',
    );
  }
}

function mapVideo(value: Record<string, unknown>, instanceUrl: string): InvidiousVideo | null {
  const mediaId = typeof value.videoId === 'string' ? value.videoId : '';
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!VIDEO_ID.test(mediaId) || !title) return null;
  const thumbnail = Array.isArray(value.videoThumbnails)
    ? value.videoThumbnails.find(
        (item) => isRecord(item) && typeof item.url === 'string' && item.url.startsWith('https://'),
      )
    : undefined;
  const duration = value.lengthSeconds;
  return {
    mediaId,
    title,
    artist: typeof value.author === 'string' ? value.author : '',
    durationSeconds:
      typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null,
    thumbnailUrl: isRecord(thumbnail) ? (thumbnail.url as string) : null,
    canonicalUrl: `https://www.youtube.com/watch?v=${mediaId}`,
    instanceUrl,
  };
}

function validateInstanceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Invidious instance URL must be an absolute HTTP(S) URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('Invidious instance URL contains unsupported URL components.');
  }
  if (url.protocol === 'http:' && !isTrustedLocalHost(url.hostname)) {
    throw new TypeError('Non-local Invidious instances must use HTTPS.');
  }
  return url.toString().replace(/\/$/, '');
}

function isTrustedLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split('.').map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function requiredText(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createFetchTransport(): InvidiousTransport {
  return {
    request: async ({ baseUrl, path, query, timeoutMs }) => {
      const url = new URL(path, `${baseUrl}/`);
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new InvidiousProviderError('Invidious request failed.', 'PROVIDER_UNAVAILABLE');
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return { status: response.status, data };
    },
  };
}
