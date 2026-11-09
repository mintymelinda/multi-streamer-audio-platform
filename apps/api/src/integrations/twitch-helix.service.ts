import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser, WorkspaceRequestContext } from '../identity/http.types.js';
import { getTwitchAppConfig, getTwitchEventSubCallbackUrl } from '../identity/twitch-app-config.js';
import { TwitchIntegrationService } from './twitch-integration.service.js';

export interface TwitchCustomReward {
  id: string;
  title: string;
  prompt: string;
  cost: number;
  is_enabled: boolean;
  is_user_input_required: boolean;
  is_paused: boolean;
  is_in_stock: boolean;
  background_color: string;
  cooldown_expires_at: string | null;
}

export interface CreateTwitchCustomReward {
  title: string;
  cost: number;
  prompt?: string;
  is_enabled?: boolean;
  is_user_input_required?: boolean;
}

export interface UpdateTwitchCustomReward {
  title?: string;
  cost?: number;
  prompt?: string;
  is_enabled?: boolean;
  is_user_input_required?: boolean;
}

type HelixMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface TwitchEventSubSubscription {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, unknown>;
}

interface TwitchAppTokenResponse {
  access_token?: string;
  expires_in?: number;
}

@Injectable()
export class TwitchHelixService {
  private appToken: { value: string; expiresAt: number } | undefined;

  constructor(
    @Inject(TwitchIntegrationService)
    private readonly integration: TwitchIntegrationService,
  ) {}

  async createRedemptionEventSubSubscription(
    broadcasterUserId: string,
    signingSecret: string,
  ): Promise<TwitchEventSubSubscription> {
    const config = getTwitchAppConfig();
    const appToken = await this.getAppAccessToken(config.clientId, config.clientSecret);
    const body = {
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: broadcasterUserId },
      transport: {
        method: 'webhook',
        callback: getTwitchEventSubCallbackUrl(),
        secret: signingSecret,
      },
    };
    let response: Response;
    try {
      response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appToken}`,
          'Client-Id': config.clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException('Twitch EventSub subscription creation is temporarily unavailable.');
    }
    if (response.status === 401) {
      this.appToken = undefined;
      throw new UnauthorizedException('Twitch app authorization was rejected.');
    }
    if (response.status === 409) {
      throw new ConflictException('A matching Twitch EventSub subscription already exists and must be reconciled.');
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ServiceUnavailableException(
          'Twitch EventSub subscription creation is temporarily unavailable.',
        );
    }
    if (!response.ok) {
      throw new BadGatewayException('Twitch rejected the EventSub subscription request.');
    }
    const payload = (await response.json()) as { data?: TwitchEventSubSubscription[] };
    const subscription = payload.data?.[0];
    if (!subscription?.id) {
      throw new BadGatewayException('Twitch did not return the created EventSub subscription.');
    }
    return subscription;
  }

  async deleteEventSubSubscription(subscriptionId: string): Promise<void> {
    const config = getTwitchAppConfig();
    const appToken = await this.getAppAccessToken(config.clientId, config.clientSecret);
    const url = new URL('https://api.twitch.tv/helix/eventsub/subscriptions');
    url.searchParams.set('id', subscriptionId);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${appToken}`,
          'Client-Id': config.clientId,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException('Twitch EventSub subscription deletion is temporarily unavailable.');
    }
    if (response.status === 401) {
      this.appToken = undefined;
      throw new UnauthorizedException('Twitch app authorization was rejected.');
    }
    if (response.status === 404 || response.status === 204) return;
    if (response.status === 429 || response.status >= 500) {
      throw new ServiceUnavailableException(
          'Twitch EventSub subscription deletion is temporarily unavailable.',
        );
    }
    if (!response.ok) {
      throw new BadGatewayException('Twitch rejected the EventSub subscription deletion.');
    }
  }

  async listEventSubSubscriptions(
    broadcasterUserId: string,
  ): Promise<TwitchEventSubSubscription[]> {
    const config = getTwitchAppConfig();
    const appToken = await this.getAppAccessToken(config.clientId, config.clientSecret);
    const subscriptions: TwitchEventSubSubscription[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const url = new URL('https://api.twitch.tv/helix/eventsub/subscriptions');
      url.searchParams.set('user_id', broadcasterUserId);
      if (cursor) url.searchParams.set('after', cursor);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${appToken}`,
            'Client-Id': config.clientId,
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new ServiceUnavailableException('Twitch EventSub reconciliation is temporarily unavailable.');
      }
      if (response.status === 401) {
        this.appToken = undefined;
        throw new UnauthorizedException('Twitch app authorization was rejected.');
      }
      if (response.status === 429 || response.status >= 500) {
        throw new ServiceUnavailableException(
            'Twitch EventSub reconciliation is temporarily unavailable.',
          );
      }
      if (!response.ok) {
        throw new BadGatewayException('Twitch EventSub subscriptions could not be reconciled.');
      }
      const payload = (await response.json()) as {
        data?: TwitchEventSubSubscription[];
        pagination?: { cursor?: string };
      };
      if (!Array.isArray(payload.data)) {
        throw new BadGatewayException('Twitch returned an invalid EventSub subscription response.');
      }
      subscriptions.push(...payload.data);
      cursor = payload.pagination?.cursor;
      if (cursor && cursors.has(cursor)) {
        throw new BadGatewayException('Twitch returned a repeated EventSub pagination cursor.');
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return subscriptions;
  }

  private async getAppAccessToken(clientId: string, clientSecret: string): Promise<string> {
    if (this.appToken && this.appToken.expiresAt > Date.now() + 60_000) {
      return this.appToken.value;
    }
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    });
    let response: Response;
    try {
      response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException('Twitch app authorization is temporarily unavailable.');
    }
    if (!response.ok) {
      throw new ServiceUnavailableException('Twitch app authorization is temporarily unavailable.');
    }
    const token = (await response.json()) as TwitchAppTokenResponse;
    if (
      !token.access_token ||
      typeof token.expires_in !== 'number' ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0
    ) {
      throw new BadGatewayException('Twitch did not return a valid app access token.');
    }
    this.appToken = {
      value: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1_000,
    };
    return token.access_token;
  }

  async listCustomRewards(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
  ): Promise<TwitchCustomReward[]> {
    const rewards: TwitchCustomReward[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.request<TwitchCustomReward>(
        'GET',
        workspace,
        actor,
        undefined,
        undefined,
        cursor,
      );
      rewards.push(...page.data);
      cursor = page.cursor;
      if (cursor && cursors.has(cursor)) {
        throw new BadGatewayException('Twitch returned a repeated reward pagination cursor.');
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return rewards;
  }

  async createCustomReward(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    input: CreateTwitchCustomReward,
  ): Promise<TwitchCustomReward> {
    const response = await this.request<TwitchCustomReward>(
      'POST',
      workspace,
      actor,
      undefined,
      input,
    );
    const reward = response.data[0];
    if (!reward?.id) throw new BadGatewayException('Twitch did not return the created reward.');
    return reward;
  }

  async updateCustomReward(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    rewardId: string,
    input: UpdateTwitchCustomReward,
  ): Promise<TwitchCustomReward> {
    const response = await this.request<TwitchCustomReward>(
      'PATCH',
      workspace,
      actor,
      rewardId,
      input,
    );
    const reward = response.data[0];
    if (!reward?.id) throw new BadGatewayException('Twitch did not return the updated reward.');
    return reward;
  }

  async deleteCustomReward(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    rewardId: string,
  ): Promise<void> {
    await this.request<TwitchCustomReward>('DELETE', workspace, actor, rewardId);
  }

  private async request<T>(
    method: HelixMethod,
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    rewardId?: string,
    body?: CreateTwitchCustomReward | UpdateTwitchCustomReward,
    cursor?: string,
  ): Promise<{ data: T[]; cursor?: string }> {
    const status = await this.integration.getStatus(workspace, actor);
    if (status.status !== 'connected' || !status.externalAccountId) {
      throw new UnauthorizedException('The workspace Twitch broadcaster is not connected.');
    }
    if (method !== 'GET' && status.recoveryState !== 'ready') {
      throw new ConflictException(
        'Twitch write operations are paused until workspace recovery is complete.',
      );
    }
    const accessToken = await this.integration.getAccessToken(workspace, actor);
    const { clientId } = getTwitchAppConfig();
    const url = new URL('https://api.twitch.tv/helix/channel_points/custom_rewards');
    url.searchParams.set('broadcaster_id', status.externalAccountId);
    if (method === 'GET') url.searchParams.set('first', '50');
    if (rewardId) url.searchParams.set('id', rewardId);
    if (cursor) url.searchParams.set('after', cursor);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': clientId,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException('Twitch reward service is temporarily unavailable.');
    }

    if (response.status === 401) {
      await this.integration.markAuthorizationLost(workspace, actor, 'twitch_api_unauthorized');
      throw new UnauthorizedException('Twitch rejected the workspace broadcaster authorization.');
    }
    if (response.status === 403) {
      await this.integration.markAuthorizationLost(workspace, actor, 'twitch_api_forbidden');
      throw new ForbiddenException(
        'The Twitch broadcaster is not permitted to manage these rewards.',
      );
    }
    if (response.status === 404) {
      throw new NotFoundException('The Twitch reward was not found.');
    }
    if (response.status === 400 || response.status === 409) {
      throw new BadGatewayException('Twitch rejected the reward operation.');
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ServiceUnavailableException('Twitch reward service is temporarily unavailable.');
    }
    if (!response.ok) {
      throw new BadGatewayException('Twitch reward operation could not be completed.');
    }
    if (method === 'DELETE' || response.status === 204) return { data: [] };

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BadGatewayException('Twitch returned an invalid reward response.');
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('data' in payload) ||
      !Array.isArray(payload.data)
    ) {
      throw new BadGatewayException('Twitch returned an invalid reward response.');
    }
    const pagination =
      'pagination' in payload &&
      typeof payload.pagination === 'object' &&
      payload.pagination !== null
        ? payload.pagination
        : undefined;
    const nextCursor =
      pagination && 'cursor' in pagination && typeof pagination.cursor === 'string'
        ? pagination.cursor
        : undefined;
    return { data: payload.data as T[], ...(nextCursor ? { cursor: nextCursor } : {}) };
  }
}
