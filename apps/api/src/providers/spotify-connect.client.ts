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

/** Personal Spotify Connect control only; this class never handles audio bytes. */
@Injectable()
export class SpotifyConnectClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly apiBaseUrl = 'https://api.spotify.com/v1',
  ) {}

  async getDevices(accessToken: string): Promise<SpotifyConnectDevice[]> {
    const result = await this.call<{ devices?: SpotifyDeviceResponse[] }>(
      accessToken,
      '/me/player/devices',
    );
    return (result.devices ?? []).map(mapDevice);
  }

  async getPlayback(accessToken: string): Promise<SpotifyConnectPlayback | null> {
    const result = await this.call<SpotifyPlaybackResponse | null>(accessToken, '/me/player', {
      allowNoContent: true,
    });
    if (!result) return null;
    const item = result.item;
    return {
      isPlaying: result.is_playing === true,
      progressMs: finiteNonNegative(result.progress_ms),
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
      device: result.device ? mapDevice(result.device) : null,
    };
  }

  async play(accessToken: string, input: { deviceId?: string; uri?: string } = {}): Promise<void> {
    const url = new URL(`${this.apiBaseUrl}/me/player/play`);
    if (input.deviceId) url.searchParams.set('device_id', input.deviceId);
    await this.call(accessToken, url, {
      method: 'PUT',
      ...(input.uri ? { body: { uris: [input.uri] } } : {}),
    });
  }

  async pause(accessToken: string, deviceId?: string): Promise<void> {
    await this.command(accessToken, 'pause', deviceId);
  }

  async next(accessToken: string, deviceId?: string): Promise<void> {
    await this.command(accessToken, 'next', deviceId);
  }

  async previous(accessToken: string, deviceId?: string): Promise<void> {
    await this.command(accessToken, 'previous', deviceId);
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

  async transferPlayback(accessToken: string, deviceId: string, play = false): Promise<void> {
    if (!deviceId.trim()) throw new TypeError('A Spotify Connect device ID is required.');
    await this.call(accessToken, '/me/player', {
      method: 'PUT',
      body: { device_ids: [deviceId], play },
    });
  }

  private async command(
    accessToken: string,
    commandName: 'pause' | 'next' | 'previous',
    deviceId?: string,
  ): Promise<void> {
    const url = new URL(`${this.apiBaseUrl}/me/player/${commandName}`);
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
      throw new Error(`Spotify Connect request failed with status ${response.status}.`);
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
