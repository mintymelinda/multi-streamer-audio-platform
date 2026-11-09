import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

export interface SpotifyConnectDevice {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  isPrivateSession: boolean;
  isRestricted: boolean;
  volumePercent: number | null;
}

export interface SpotifyConnectPlayback {
  isPlaying: boolean;
  progressMs: number | null;
  item: {
    id: string;
    name: string;
    uri: string;
    durationMs: number;
    artists: string[];
    album: string | null;
    imageUrl: string | null;
  } | null;
  device: SpotifyConnectDevice | null;
}

interface SpotifyDeviceResponse {
  id?: string | null;
  name?: string;
  type?: string;
  is_active?: boolean;
  is_private_session?: boolean;
  is_restricted?: boolean;
  volume_percent?: number | null;
}

interface SpotifyPlaybackResponse {
  is_playing?: boolean;
  progress_ms?: number | null;
  device?: SpotifyDeviceResponse | null;
  item?: {
    id?: string;
    name?: string;
    uri?: string;
    duration_ms?: number;
    artists?: Array<{ name?: string }>;
    album?: { name?: string; images?: Array<{ url?: string }> };
  } | null;
}

export class SpotifyConnectApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'SpotifyConnectApiError';
  }
}

/**
 * Controls the user's personal Spotify Connect session through Spotify's Web API.
 * This client never retrieves or transports audio and is not a request-queue provider.
 */
@Injectable()
export class SpotifyConnectClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly apiBaseUrl = 'https://api.spotify.com/v1',
  ) {}

  async getDevices(accessToken: string): Promise<SpotifyConnectDevice[]> {
    const response = await this.call<{ devices?: SpotifyDeviceResponse[] }>(
      accessToken,
      '/me/player/devices',
    );
    return (response.devices ?? []).map(mapDevice);
  }

  async getPlayback(accessToken: string): Promise<SpotifyConnectPlayback | null> {
    const response = await this.call<SpotifyPlaybackResponse | null>(accessToken, '/me/player', {
      allowNoContent: true,
    });
    if (!response) return null;
    const item = response.item;
    return {
      isPlaying: response.is_playing === true,
      progressMs: finiteNonNegative(response.progress_ms),
      item:
        item?.id && item.name && item.uri
          ? {
              id: item.id,
              name: item.name,
              uri: item.uri,
              durationMs: finiteNonNegative(item.duration_ms) ?? 0,
              artists: (item.artists ?? [])
                .map((artist) => artist.name)
                .filter((name): name is string => typeof name === 'string'),
              album: item.album?.name ?? null,
              imageUrl: item.album?.images?.find((image) => image.url)?.url ?? null,
            }
          : null,
      device: response.device ? mapDevice(response.device) : null,
    };
  }

  async play(accessToken: string, input: { deviceId?: string; uri?: string } = {}): Promise<void> {
    const url = new URL(`${this.apiBaseUrl}/me/player/play`);
    if (input.deviceId) url.searchParams.set('device_id', input.deviceId);
    const body = input.uri ? { uris: [input.uri] } : undefined;
    await this.call(accessToken, url, { method: 'PUT', ...(body ? { body } : {}) });
  }

  async pause(accessToken: string, deviceId?: string): Promise<void> {
    await this.playerCommand(accessToken, 'pause', deviceId);
  }

  async next(accessToken: string, deviceId?: string): Promise<void> {
    await this.playerCommand(accessToken, 'next', deviceId);
  }

  async previous(accessToken: string, deviceId?: string): Promise<void> {
    await this.playerCommand(accessToken, 'previous', deviceId);
  }

  async seek(accessToken: string, positionMs: number, deviceId?: string): Promise<void> {
    if (!Number.isInteger(positionMs) || positionMs < 0) {
      throw new TypeError('Spotify seek position must be a non-negative integer in milliseconds.');
    }
    const url = new URL(`${this.apiBaseUrl}/me/player/seek`);
    url.searchParams.set('position_ms', String(positionMs));
    if (deviceId) url.searchParams.set('device_id', deviceId);
    await this.call(accessToken, url, { method: 'PUT' });
  }

  async transferPlayback(
    accessToken: string,
    deviceId: string,
    play = false,
  ): Promise<void> {
    if (!deviceId.trim()) throw new TypeError('A Spotify Connect device ID is required.');
    await this.call(accessToken, '/me/player', {
      method: 'PUT',
      body: { device_ids: [deviceId], play },
    });
  }

  private async playerCommand(
    accessToken: string,
    command: 'pause' | 'next' | 'previous',
    deviceId?: string,
  ): Promise<void> {
    const url = new URL(`${this.apiBaseUrl}/me/player/${command}`);
    if (deviceId) url.searchParams.set('device_id', deviceId);
    await this.call(accessToken, url, { method: 'POST' });
  }

  private async call<T>(
    accessToken: string,
    path: string | URL,
    options: {
      method?: 'GET' | 'POST' | 'PUT';
      body?: unknown;
      allowNoContent?: boolean;
    } = {},
  ): Promise<T> {
    if (!accessToken.trim()) throw new TypeError('Spotify access token is required.');
    let response: Response;
    try {
      response = await this.request(path instanceof URL ? path : `${this.apiBaseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException('Spotify Connect is temporarily unavailable.');
    }
    if (response.status === 204 && options.allowNoContent) return null as T;
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const error = new SpotifyConnectApiError(
        'Spotify Connect request failed.',
        response.status,
        Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
      );
      if (response.status === 401) {
        throw new UnauthorizedException('Spotify authorization expired. Reconnect your account.');
      }
      if (response.status === 429 || response.status >= 500) {
        throw new ServiceUnavailableException(
          response.status === 429
            ? 'Spotify rate limit reached. Try again shortly.'
            : 'Spotify Connect is temporarily unavailable.',
        );
      }
      throw error;
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function mapDevice(device: SpotifyDeviceResponse): SpotifyConnectDevice {
  return {
    id: device.id ?? null,
    name: device.name ?? 'Unknown device',
    type: device.type ?? 'unknown',
    isActive: device.is_active === true,
    isPrivateSession: device.is_private_session === true,
    isRestricted: device.is_restricted === true,
    volumePercent: finiteNonNegative(device.volume_percent),
  };
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
