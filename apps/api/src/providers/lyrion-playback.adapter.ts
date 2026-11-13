import { ProviderCommandRejectedError, type PlaybackAdapter, type PlaybackCommandInput, type PlaybackState, type ProviderCommandResult } from '../playback/playback-coordinator.service.js';
import type { PlaybackMediaSourceResolver, ResolvedPlaybackMedia } from './playback-media-source.resolver.js';

export interface LyrionPlaybackAdapterOptions {
  baseUrl: string;
  playerId: string;
  username?: string;
  password?: string;
  mediaResolver: PlaybackMediaSourceResolver;
  request?: typeof fetch;
  timeoutMs?: number;
  allowedHosts?: string[];
}

type LyrionResponse = {
  result?: Record<string, unknown>;
  error?: unknown;
};

export class LyrionPlaybackAdapter implements PlaybackAdapter {
  private readonly endpoint: URL;
  private readonly authorization: string | null;
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: LyrionPlaybackAdapterOptions) {
    this.endpoint = validateEndpoint(options.baseUrl, options.allowedHosts ?? []);
    if (!options.playerId.trim() || options.playerId.length > 200) {
      throw new TypeError('A valid Lyrion player ID is required.');
    }
    if (Boolean(options.username) !== Boolean(options.password)) {
      throw new TypeError('Lyrion username and password must be supplied together.');
    }
    this.authorization = options.username && options.password
      ? `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`
      : null;
    this.request = options.request ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) {
      throw new TypeError('Lyrion timeout must be between 1000 and 30000 milliseconds.');
    }
  }

  async play(input: PlaybackCommandInput): Promise<ProviderCommandResult> {
    const media = await this.resolveSource(input);
    await this.command(['power', '1']);
    await this.command(['playlist', 'clear']);
    await this.command(['playlist', 'add', media.streamUrl]);
    await this.command(['play']);
    const state = await this.getPlaybackState(input);
    return {
      outcome: state.status === 'playing' ? 'started' : 'unknown',
      ...(state.providerPlaybackId ? { providerPlaybackId: state.providerPlaybackId } : {}),
    };
  }

  async pause(): Promise<ProviderCommandResult> {
    await this.command(['pause', '1']);
    return { outcome: 'paused' };
  }

  async resume(): Promise<ProviderCommandResult> {
    await this.command(['pause', '0']);
    return { outcome: 'resumed' };
  }

  async skip(): Promise<ProviderCommandResult> {
    await this.command(['playlist', 'index', '+1']);
    return { outcome: 'skipped' };
  }

  async seek(input: PlaybackCommandInput): Promise<ProviderCommandResult> {
    const positionMs = input.payload?.positionMs;
    if (typeof positionMs !== 'number' || !Number.isSafeInteger(positionMs) || positionMs < 0) {
      throw new TypeError('Lyrion seek requires a non-negative positionMs integer.');
    }
    await this.command(['time', String(positionMs / 1000)]);
    return { outcome: 'completed' };
  }

  async getPlaybackState(_input: PlaybackCommandInput): Promise<PlaybackState> {
    const response = await this.command(['status', '-', '1', 'tags:adKlur']);
    const result = response.result ?? {};
    const rawMode = result.mode ?? result._mode;
    const mode = typeof rawMode === 'string' ? rawMode : 'stop';
    const status = mode === 'play' ? 'playing' : mode === 'pause' ? 'paused' : 'stopped';
    // playlist_timestamp changes when LMS mutates the current playlist. It is a
    // provider session marker, not a logical request ID; never infer request
    // identity from the playlist index or media URL.
    const providerPlaybackId = parseProviderPlaybackId(result.playlist_timestamp);
    const progressMs = parseSecondsToMilliseconds(result.time);
    const durationMs = parseSecondsToMilliseconds(result.duration);
    return {
      status,
      ...(providerPlaybackId ? { providerPlaybackId } : {}),
      ...(progressMs !== undefined ? { progressMs } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'unavailable' }> {
    try {
      const response = await this.command(['mode', '?']);
      const mode = response.result?.mode ?? response.result?._mode;
      if (typeof mode !== 'string') return { status: 'unavailable' };
      return { status: 'healthy' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private async resolveSource(input: PlaybackCommandInput): Promise<ResolvedPlaybackMedia> {
    const sourceProviderId = input.payload?.sourceProviderId;
    if (sourceProviderId !== 'youtube') {
      throw new ProviderCommandRejectedError('Lyrion output currently supports YouTube/Invidious source media only.', 'UNSUPPORTED_MEDIA_SOURCE');
    }
    try {
      return await this.options.mediaResolver.resolve({
        providerId: sourceProviderId,
        mediaId: typeof input.payload?.mediaId === 'string' ? input.payload.mediaId : null,
        mediaUrl: typeof input.payload?.mediaUrl === 'string' ? input.payload.mediaUrl : null,
      });
    } catch {
      throw new ProviderCommandRejectedError('The requested media source could not be resolved.', 'MEDIA_RESOLUTION_FAILED');
    }
  }

  private async command(command: string[]): Promise<LyrionResponse> {
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.authorization ? { authorization: this.authorization } : {}),
        },
        body: JSON.stringify({
          id: 1,
          method: 'slim.request',
          params: [this.options.playerId, command],
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error('Lyrion command transport failed; the command outcome may be unknown.');
    }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        throw new ProviderCommandRejectedError('Lyrion rejected the command.', 'LYRION_COMMAND_REJECTED');
      }
      throw new Error('Lyrion command transport failed; the command outcome may be unknown.');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Lyrion returned an invalid response; the command outcome may be unknown.');
    }
    if (!isRecord(payload) || !isRecord(payload.result)) {
      throw new Error('Lyrion returned an invalid response; the command outcome may be unknown.');
    }
    if (payload.error || (payload.result as Record<string, unknown>).error) {
      throw new ProviderCommandRejectedError('Lyrion rejected the command.', 'LYRION_COMMAND_REJECTED');
    }
    return payload as LyrionResponse;
  }
}


function parseProviderPlaybackId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function parseSecondsToMilliseconds(value: unknown): number | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function validateEndpoint(value: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Lyrion base URL must be an absolute HTTP(S) URL.');
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized.startsWith('*.')
      ? hostname.endsWith(normalized.slice(1)) && hostname !== normalized.slice(2)
      : hostname === normalized;
  });
  const localDevelopmentHost = process.env.NODE_ENV !== 'production' &&
    (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!allowed && !localDevelopmentHost) ||
    (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
  ) {
    throw new TypeError('Lyrion endpoint must use an operator-approved host and secure transport.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/jsonrpc.js`;
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
