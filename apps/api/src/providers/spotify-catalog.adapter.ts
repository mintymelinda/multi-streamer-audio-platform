export interface SpotifyTransportResponse {
  status: number;
  data: unknown;
}

export interface SpotifyTransport {
  request(input: {
    path: string;
    query?: Record<string, string>;
    accessToken: string;
    timeoutMs: number;
  }): Promise<SpotifyTransportResponse>;
}

export interface SpotifyTrack {
  mediaId: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  canonicalUrl: string;
  spotifyUri: string;
}

export interface SpotifyAdapterOptions {
  accessToken?: string;
  getAccessToken?: () => Promise<string | null>;
  market?: string;
  transport?: SpotifyTransport;
  timeoutMs?: number;
}

export class SpotifyProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SpotifyProviderError';
  }
}

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const DEFAULT_TIMEOUT_MS = 8_000;
const API_BASE_URL = 'https://api.spotify.com/v1';

export class SpotifyCatalogAdapter {
  readonly providerId = 'spotify';
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
    mediaTypes: ['audio'] as const,
  };

  private readonly accessToken: string | undefined;
  private readonly getAccessToken: (() => Promise<string | null>) | undefined;
  private readonly market: string | undefined;
  private readonly transport: SpotifyTransport;
  private readonly timeoutMs: number;

  constructor(options: SpotifyAdapterOptions = {}) {
    this.accessToken = options.accessToken;
    this.getAccessToken = options.getAccessToken;
    this.market = options.market?.toUpperCase();
    this.transport = options.transport ?? createFetchTransport();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new TypeError('Spotify timeoutMs must be between 100 and 60000.');
    }
    if (this.market && !/^[A-Z]{2}$/.test(this.market)) {
      throw new TypeError('Spotify market must be a two-letter country code.');
    }
    if (!this.accessToken && !this.getAccessToken) {
      // An unconfigured adapter is valid and reports its state through healthCheck.
    }
  }

  async healthCheck(): Promise<{
    status: 'healthy' | 'unavailable' | 'authorization_expired' | 'unconfigured';
  }> {
    const token = await this.resolveAccessToken();
    if (!token) return { status: 'unconfigured' };
    try {
      const response = await this.transport.request({
        path: '/search',
        query: { q: 'healthcheck', type: 'track', limit: '1', ...this.marketQuery() },
        accessToken: token,
        timeoutMs: this.timeoutMs,
      });
      if (response.status >= 200 && response.status < 300) return { status: 'healthy' };
      if (response.status === 401) return { status: 'authorization_expired' };
      return { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async search(input: { query: string; limit?: number }): Promise<SpotifyTrack[]> {
    const query = requiredText(input.query, 'query', 200);
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new TypeError('Spotify search limit must be between 1 and 10.');
    }
    const response = await this.request('/search', {
      q: query,
      type: 'track',
      limit: String(limit),
      ...this.marketQuery(),
    });
    if (!isRecord(response.data) || !isRecord(response.data.tracks)) {
      throw new SpotifyProviderError(
        'Spotify returned an invalid search response.',
        'INVALID_RESPONSE',
      );
    }
    const items = response.data.tracks.items;
    if (!Array.isArray(items)) {
      throw new SpotifyProviderError(
        'Spotify returned an invalid track collection.',
        'INVALID_RESPONSE',
      );
    }
    return items.map(mapTrack).filter((track): track is SpotifyTrack => track !== null);
  }

  async resolve(input: { mediaId: string }): Promise<SpotifyTrack> {
    const mediaId = normalizeTrackId(requiredText(input.mediaId, 'mediaId', 200));
    if (!SPOTIFY_ID.test(mediaId)) {
      throw new SpotifyProviderError('Spotify track ID is invalid.', 'INVALID_MEDIA_ID', 400);
    }
    const response = await this.request(
      `/tracks/${encodeURIComponent(mediaId)}`,
      this.marketQuery(),
    );
    if (!isRecord(response.data)) {
      throw new SpotifyProviderError(
        'Spotify returned invalid track metadata.',
        'INVALID_RESPONSE',
      );
    }
    const track = mapTrack(response.data);
    if (!track) {
      throw new SpotifyProviderError('Spotify track metadata is incomplete.', 'INVALID_RESPONSE');
    }
    return track;
  }

  async play(): Promise<never> {
    throw new SpotifyProviderError(
      'Spotify playback is disabled: Spotify content cannot be used for non-interactive broadcasts or synchronized with visual media.',
      'PLAYBACK_NOT_SUPPORTED',
    );
  }

  async disconnect(): Promise<{ disconnected: true }> {
    return { disconnected: true };
  }

  private async request(
    path: string,
    query?: Record<string, string>,
  ): Promise<SpotifyTransportResponse> {
    const accessToken = await this.resolveAccessToken();
    if (!accessToken) {
      throw new SpotifyProviderError('Spotify access token is not configured.', 'NOT_CONFIGURED');
    }
    let response: SpotifyTransportResponse;
    try {
      response = await this.transport.request({
        path,
        ...(query ? { query } : {}),
        accessToken,
        timeoutMs: this.timeoutMs,
      });
    } catch {
      throw new SpotifyProviderError('Spotify request failed.', 'PROVIDER_UNAVAILABLE');
    }
    if (response.status === 401) {
      throw new SpotifyProviderError(
        'Spotify authorization has expired.',
        'AUTHORIZATION_EXPIRED',
        401,
      );
    }
    if (response.status === 403) {
      throw new SpotifyProviderError('Spotify denied this API operation.', 'FORBIDDEN', 403);
    }
    if (response.status === 404) {
      throw new SpotifyProviderError('Spotify track was not found.', 'MEDIA_NOT_FOUND', 404);
    }
    if (response.status === 429) {
      throw new SpotifyProviderError('Spotify rate limit was reached.', 'RATE_LIMITED', 429);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SpotifyProviderError(
        'Spotify API request failed.',
        'UPSTREAM_ERROR',
        response.status,
      );
    }
    return response;
  }

  private async resolveAccessToken(): Promise<string | null> {
    const token = this.getAccessToken ? await this.getAccessToken() : this.accessToken;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  }

  private marketQuery(): Record<string, string> {
    return this.market ? { market: this.market } : {};
  }
}

function mapTrack(value: unknown): SpotifyTrack | null {
  if (!isRecord(value)) return null;
  const mediaId = typeof value.id === 'string' ? value.id : '';
  const title = typeof value.name === 'string' ? value.name.trim() : '';
  const artists = Array.isArray(value.artists) ? value.artists : [];
  const artist = artists
    .filter((item) => isRecord(item) && typeof item.name === 'string')
    .map((item) => (item as Record<string, unknown>).name as string)
    .join(', ');
  const albumValue = value.album;
  const album = isRecord(albumValue) && typeof albumValue.name === 'string' ? albumValue.name : '';
  const durationMs = value.duration_ms;
  if (!SPOTIFY_ID.test(mediaId) || !title || !artist || !album) return null;
  if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
    return null;
  }
  const images = isRecord(albumValue) && Array.isArray(albumValue.images) ? albumValue.images : [];
  const image = images.find(
    (item) => isRecord(item) && typeof item.url === 'string' && item.url.startsWith('https://'),
  );
  return {
    mediaId,
    title,
    artist,
    album,
    durationSeconds: Math.round(durationMs / 1000),
    thumbnailUrl: isRecord(image) ? (image.url as string) : null,
    canonicalUrl: `https://open.spotify.com/track/${mediaId}`,
    spotifyUri: `spotify:track:${mediaId}`,
  };
}

function normalizeTrackId(value: string): string {
  const uriMatch = /^spotify:track:([A-Za-z0-9]{22})$/.exec(value);
  if (uriMatch?.[1]) return uriMatch[1];
  try {
    const url = new URL(value);
    if (url.hostname === 'open.spotify.com') {
      const match = /^\/track\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
      if (match?.[1]) return match[1];
    }
  } catch {
    // Treat the input as a raw Spotify ID below.
  }
  return value;
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

function createFetchTransport(): SpotifyTransport {
  return {
    request: async ({ path, query, accessToken, timeoutMs }) => {
      const url = new URL(path, API_BASE_URL);
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new SpotifyProviderError('Spotify request failed.', 'PROVIDER_UNAVAILABLE');
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
