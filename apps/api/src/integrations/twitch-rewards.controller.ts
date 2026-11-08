import {
  BadRequestException,
  Body,
  Delete,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthenticatedUser,
  HttpRequest,
  WorkspaceRequestContext,
} from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import {
  RequireWorkspacePermission,
  WorkspacePermissionGuard,
} from '../workspaces/workspace-permission.guard.js';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard.js';
import {
  isTwitchRewardFeatureKey,
  normalizeTwitchRewardFeatureSettings,
} from './twitch-reward-features.js';
import { TwitchRewardsService } from './twitch-rewards.service.js';
import type { CreateTwitchCustomReward, UpdateTwitchCustomReward } from './twitch-helix.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function user(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new UnauthorizedException('Sign-in is required.');
  return request.user;
}

function workspace(request: HttpRequest): WorkspaceRequestContext {
  if (!request.workspace) throw new NotFoundException('Workspace not found.');
  return request.workspace;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new BadRequestException(
      `${field} must be a non-empty string no longer than ${max} characters.`,
    );
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new BadRequestException(`${field} must be a string no longer than ${max} characters.`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function featureKey(value: unknown) {
  if (!isTwitchRewardFeatureKey(value)) {
    throw new BadRequestException('featureKey must identify a supported Twitch reward feature.');
  }
  return value;
}

function featureSettings(feature: ReturnType<typeof featureKey>, value: unknown) {
  try {
    return normalizeTwitchRewardFeatureSettings(feature, value);
  } catch (error) {
    throw new BadRequestException(
      error instanceof Error ? error.message : 'Feature settings are invalid.',
    );
  }
}

@Controller('workspaces/:workspaceId/twitch/rewards')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
export class TwitchRewardsController {
  constructor(@Inject(TwitchRewardsService) private readonly rewards: TwitchRewardsService) {}


  @Get()
  @RequireWorkspacePermission('workspace:read')
  listRemoteRewards(@Req() request: HttpRequest) {
    return this.rewards.listRemoteRewards(workspace(request), user(request));
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  createReward(@Req() request: HttpRequest, @Body() body: unknown) {
    const data = record(body);
    const key = featureKey(data.featureKey);
    const settings = featureSettings(key, data.featureSettings ?? {});
    const title = requiredString(data.title, 'title', 45);
    const prompt = optionalString(data.prompt, 'prompt', 200);
    const cost = data.cost;
    if (typeof cost !== 'number' || !Number.isInteger(cost) || cost < 1 || cost > 1_000_000) {
      throw new BadRequestException('cost must be an integer between 1 and 1000000.');
    }
    if (data.isEnabled !== undefined && typeof data.isEnabled !== 'boolean') {
      throw new BadRequestException('isEnabled must be a boolean.');
    }
    if (
      data.isUserInputRequired !== undefined &&
      typeof data.isUserInputRequired !== 'boolean'
    ) {
      throw new BadRequestException('isUserInputRequired must be a boolean.');
    }
    const reward: CreateTwitchCustomReward = {
      title,
      cost,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(data.isEnabled !== undefined ? { is_enabled: data.isEnabled } : {}),
      ...(data.isUserInputRequired !== undefined
        ? { is_user_input_required: data.isUserInputRequired }
        : {}),
    };
    return this.rewards.createReward(workspace(request), user(request), reward, key, settings);
  }

  @Patch(':rewardId')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  updateRemoteReward(
    @Req() request: HttpRequest,
    @Param('rewardId') rewardId: string,
    @Body() body: unknown,
  ) {
    const id = requiredString(rewardId, 'rewardId', 128);
    const data = record(body);
    const input: UpdateTwitchCustomReward = {};
    if (data.title !== undefined) input.title = requiredString(data.title, 'title', 45);
    if (data.prompt !== undefined) {
      const prompt = optionalString(data.prompt, 'prompt', 200);
      input.prompt = prompt ?? '';
    }
    if (data.cost !== undefined) {
      if (
        typeof data.cost !== 'number' ||
        !Number.isInteger(data.cost) ||
        data.cost < 1 ||
        data.cost > 1_000_000
      ) {
        throw new BadRequestException('cost must be an integer between 1 and 1000000.');
      }
      input.cost = data.cost;
    }
    if (data.isEnabled !== undefined) {
      if (typeof data.isEnabled !== 'boolean') {
        throw new BadRequestException('isEnabled must be a boolean.');
      }
      input.is_enabled = data.isEnabled;
    }
    if (data.isUserInputRequired !== undefined) {
      if (typeof data.isUserInputRequired !== 'boolean') {
        throw new BadRequestException('isUserInputRequired must be a boolean.');
      }
      input.is_user_input_required = data.isUserInputRequired;
    }
    if (Object.keys(input).length === 0) {
      throw new BadRequestException('At least one Twitch reward field must be supplied.');
    }
    return this.rewards.updateRemoteReward(workspace(request), user(request), id, input);
  }

  @Delete(':rewardId')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  async deleteRemoteReward(
    @Req() request: HttpRequest,
    @Param('rewardId') rewardId: string,
  ) {
    const id = requiredString(rewardId, 'rewardId', 128);
    await this.rewards.deleteRemoteReward(workspace(request), user(request), id);
    return { deleted: true, rewardId: id };
  }

  @Get('mappings')
  @RequireWorkspacePermission('workspace:read')
  listMappings(@Req() request: HttpRequest) {
    return this.rewards.listMappings(workspace(request), user(request));
  }

  @Post('mappings')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  linkExistingReward(@Req() request: HttpRequest, @Body() body: unknown) {
    const data = record(body);
    const key = featureKey(data.featureKey);
    const settings = featureSettings(key, data.featureSettings ?? {});
    return this.rewards.linkExistingReward(workspace(request), user(request), {
      rewardId: requiredString(data.rewardId, 'rewardId', 128),
      featureKey: key,
      featureSettings: settings,
    });
  }

  @Patch('mappings/:mappingId')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  updateMapping(
    @Req() request: HttpRequest,
    @Param('mappingId') mappingId: string,
    @Body() body: unknown,
  ) {
    if (!UUID_PATTERN.test(mappingId)) throw new BadRequestException('mappingId must be a UUID.');
    const data = record(body);
    const input: {
      featureKey?: ReturnType<typeof featureKey>;
      featureSettings?: ReturnType<typeof featureSettings>;
      enabled?: boolean;
    } = {};
    if (data.featureKey !== undefined) input.featureKey = featureKey(data.featureKey);
    if (data.featureSettings !== undefined) {
      const key = input.featureKey ?? 'media_request';
      input.featureSettings = featureSettings(key, data.featureSettings);
    }
    if (data.enabled !== undefined) {
      if (typeof data.enabled !== 'boolean')
        throw new BadRequestException('enabled must be a boolean.');
      input.enabled = data.enabled;
    }
    if (Object.keys(input).length === 0) {
      throw new BadRequestException('At least one mapping setting must be supplied.');
    }
    return this.rewards.updateMapping(workspace(request), user(request), mappingId, input);
  }
}
