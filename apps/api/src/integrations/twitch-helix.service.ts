import {
  BadGatewayException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser, WorkspaceRequestContext } from '../identity/http.types.js';
import { getTwitchAppConfig } from '../identity/twitch-app-config.js';
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

@Injectable()
export class TwitchHelixService {
  constructor(
    @Inject(TwitchIntegrationService)
    private readonly integration: TwitchIntegrationService,
  ) {}

  listCustomRewards(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
  ): Promise<TwitchCustomReward[]> {
    return this.request('GET', workspace, actor);
  }

  async createCustomReward(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    input: CreateTwitchCustomReward,
  ): Promise<TwitchCustomReward> {
    const rewards = await this.request<TwitchCustomReward[]>(
      'POST',
      workspace,
      actor,
      undefined,
      input,
    );
    const reward = rewards[0];
    if (!reward?.id) throw new BadGatewayException('Twitch did not return the created reward.');
    return reward;
  }

  async updateCustomReward(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    rewardId: string,
    input: UpdateTwitchCustomReward,
  ): Promise<TwitchCustomReward> {
    const rewards = await this.request<TwitchCustomReward[]>(
      'PATCH',
      workspace,
      actor,
      rewardId,
      input,
    );
    const reward = rewards[0];
    if (!reward?.id) throw new BadGatewayException('Twitch did not return the updated reward.');
    return reward;
  }

  async deleteCustomReward(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    rewardId: string,
  ): Promise<void> {
    await this.request<void>('DELETE', workspace, actor, rewardId);
  }

  private async request<T>(
    method: HelixMethod,
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    rewardId?: string,
    body?: CreateTwitchCustomReward | UpdateTwitchCustomReward,
  ): Promise<T> {
    const accessToken = await this.integration.getAccessToken(workspace, actor);
    const { clientId } = getTwitchAppConfig();
    const url = new URL('https://api.twitch.tv/helix/channel_points/custom_rewards');
    url.searchParams.set('broadcaster_id', actor.twitchUserId);
    if (rewardId) url.searchParams.set('id', rewardId);

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
      throw new UnauthorizedException('Twitch rejected the workspace broadcaster authorization.');
    }
    if (response.status === 403) {
      throw new ForbiddenException('The Twitch broadcaster is not permitted to manage these rewards.');
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
    if (method === 'DELETE' || response.status === 204) return undefined as T;

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
    return payload.data as T;
  }
}
