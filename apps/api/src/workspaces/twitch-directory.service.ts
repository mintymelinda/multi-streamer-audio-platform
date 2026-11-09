import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { getTwitchAppConfig } from '../identity/twitch-app-config.js';

interface AppTokenResponse {
  access_token?: string;
  expires_in?: number;
}
interface HelixUsersResponse {
  data?: Array<{ id?: string; login?: string }>;
}

@Injectable()
export class TwitchDirectoryService {
  private cachedToken: string | undefined;
  private tokenExpiresAt = 0;
  private pendingToken: Promise<string> | undefined;

  async resolveUsername(usernameInput: string): Promise<string> {
    const username = usernameInput.trim().toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(username)) {
      throw new BadRequestException('Enter a valid Twitch username.');
    }
    const config = getTwitchAppConfig();
    const token = await this.getAppToken(config.clientId, config.clientSecret);
    const url = new URL('https://api.twitch.tv/helix/users');
    url.searchParams.set('login', username);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': config.clientId },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Twitch user lookup failed');
      const payload = (await response.json()) as HelixUsersResponse;
      const id = payload.data?.[0]?.id;
      if (!id || !/^[0-9]{1,32}$/.test(id)) {
        throw new BadRequestException('That Twitch username could not be found.');
      }
      return id;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('Twitch username lookup is temporarily unavailable.');
    }
  }

  private async getAppToken(clientId: string, clientSecret: string): Promise<string> {
    if (this.cachedToken && this.tokenExpiresAt > Date.now() + 60_000) return this.cachedToken;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = (async () => {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      });
      const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Twitch application token request failed');
      const payload = (await response.json()) as AppTokenResponse;
      if (!payload.access_token || !payload.expires_in) {
        throw new Error('Twitch application token response was incomplete');
      }
      this.cachedToken = payload.access_token;
      this.tokenExpiresAt = Date.now() + payload.expires_in * 1_000;
      return payload.access_token;
    })();
    try {
      return await this.pendingToken;
    } catch {
      throw new ServiceUnavailableException('Twitch user lookup is temporarily unavailable.');
    } finally {
      this.pendingToken = undefined;
    }
  }
}
