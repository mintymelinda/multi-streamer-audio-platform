import type { VerifiedWorkspaceId } from '@platform/contracts';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedUser, WorkspaceRequestContext } from '../identity/http.types.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type {
  TwitchRewardFeatureKey,
  TwitchRewardFeatureSettings,
} from './twitch-reward-features.js';
import {
  TwitchHelixService,
  type CreateTwitchCustomReward,
  type TwitchCustomReward,
  type UpdateTwitchCustomReward,
} from './twitch-helix.service.js';

export type TwitchRewardSyncState =
  | 'pending_verification'
  | 'synced'
  | 'attention_required'
  | 'deleted_on_twitch'
  | 'sync_unknown';

export interface TwitchRewardMapping {
  id: string;
  workspace_id: string;
  twitch_reward_id: string;
  reward_title: string;
  reward_prompt: string | null;
  reward_cost: number;
  feature_key: TwitchRewardFeatureKey;
  feature_settings: TwitchRewardFeatureSettings;
  enabled: boolean;
  sync_state: TwitchRewardSyncState;
  last_synced_at: Date | null;
  last_sync_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NewTwitchRewardMapping {
  rewardId: string;
  featureKey: TwitchRewardFeatureKey;
  featureSettings: TwitchRewardFeatureSettings;
}

export interface UpdateTwitchRewardMapping {
  featureKey?: TwitchRewardFeatureKey;
  featureSettings?: TwitchRewardFeatureSettings;
  enabled?: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

@Injectable()
export class TwitchRewardsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TwitchHelixService) private readonly helix: TwitchHelixService,
  ) {}


  async listRemoteRewards(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
  ): Promise<TwitchCustomReward[]> {
    try {
      const rewards = await this.helix.listCustomRewards(workspace, actor);
      await this.reconcileMappings(workspace, actor, rewards);
      return rewards;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        await this.markSyncUnknown(workspace, actor);
      }
      throw error;
    }
  }

  async createReward(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    reward: CreateTwitchCustomReward,
    featureKey: TwitchRewardFeatureKey,
    featureSettings: TwitchRewardFeatureSettings,
  ): Promise<TwitchRewardMapping> {
    const created = await this.helix.createCustomReward(workspace, actor, reward);
    try {
      return await this.linkExistingReward(workspace, actor, {
        rewardId: created.id,
        featureKey,
        featureSettings,
      });
    } catch (error) {
      try {
        await this.helix.deleteCustomReward(workspace, actor, created.id);
      } catch {
        throw new ServiceUnavailableException(
          'The Twitch reward was created, but its platform mapping could not be saved or compensated. Reconcile rewards before retrying.',
        );
      }
      throw error;
    }
  }

  async updateRemoteReward(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    rewardId: string,
    input: UpdateTwitchCustomReward,
  ): Promise<TwitchCustomReward> {
    const reward = await this.helix.updateCustomReward(workspace, actor, rewardId, input);
    try {
      await this.database.transaction(
        { userId: actor.id, verifiedWorkspaceId: workspace.id },
        (client) =>
          client.query(
            `UPDATE twitch_reward_mappings
                SET reward_title = $3, reward_prompt = $4, reward_cost = $5,
                    sync_state = 'synced', last_synced_at = now(),
                    last_sync_error_code = NULL, updated_at = now()
              WHERE workspace_id = $1 AND twitch_reward_id = $2`,
            [workspace.id, reward.id, reward.title, reward.prompt || null, reward.cost],
          ),
      );
    } catch {
      await this.markRewardSyncUnknown(workspace, actor, rewardId);
      throw new ServiceUnavailableException(
        'Twitch updated the reward, but the local mapping could not be synchronized.',
      );
    }
    return reward;
  }

  async deleteRemoteReward(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    rewardId: string,
  ): Promise<void> {
    await this.helix.deleteCustomReward(workspace, actor, rewardId);
    await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      (client) =>
        client.query(
          `UPDATE twitch_reward_mappings
              SET enabled = false, sync_state = 'deleted_on_twitch',
                  last_synced_at = now(), last_sync_error_code = NULL, updated_at = now()
            WHERE workspace_id = $1 AND twitch_reward_id = $2`,
          [workspace.id, rewardId],
        ),
    );
  }

  private async reconcileMappings(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    rewards: TwitchCustomReward[],
  ): Promise<void> {
    const remoteById = new Map(rewards.map((reward) => [reward.id, reward]));
    await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const result = await client.query<Pick<
          TwitchRewardMapping,
          'id' | 'twitch_reward_id' | 'reward_title' | 'reward_prompt' | 'reward_cost'
        >>(
          `SELECT id, twitch_reward_id, reward_title, reward_prompt, reward_cost
             FROM twitch_reward_mappings
            WHERE workspace_id = $1
            FOR UPDATE`,
          [workspace.id],
        );
        for (const mapping of result.rows) {
          const remote = remoteById.get(mapping.twitch_reward_id);
          if (!remote) {
            await client.query(
              `UPDATE twitch_reward_mappings
                  SET enabled = false, sync_state = 'deleted_on_twitch',
                      last_synced_at = now(), last_sync_error_code = 'reward_missing_on_twitch',
                      updated_at = now()
                WHERE workspace_id = $1 AND id = $2`,
              [workspace.id, mapping.id],
            );
            continue;
          }
          const metadataMatches =
            mapping.reward_title === remote.title &&
            (mapping.reward_prompt ?? '') === (remote.prompt ?? '') &&
            mapping.reward_cost === remote.cost;
          await client.query(
            `UPDATE twitch_reward_mappings
                SET sync_state = $3, last_synced_at = now(),
                    last_sync_error_code = $4, updated_at = now()
              WHERE workspace_id = $1 AND id = $2`,
            [
              workspace.id,
              mapping.id,
              metadataMatches ? 'synced' : 'attention_required',
              metadataMatches ? null : 'reward_metadata_changed',
            ],
          );
        }
      },
    );
  }

  private async markSyncUnknown(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
  ): Promise<void> {
    await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      (client) =>
        client.query(
          `UPDATE twitch_reward_mappings
              SET sync_state = 'sync_unknown', last_sync_error_code = 'twitch_unavailable',
                  updated_at = now()
            WHERE workspace_id = $1 AND sync_state <> 'deleted_on_twitch'`,
          [workspace.id],
        ),
    );
  }

  private async markRewardSyncUnknown(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    rewardId: string,
  ): Promise<void> {
    await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      (client) =>
        client.query(
          `UPDATE twitch_reward_mappings
              SET sync_state = 'sync_unknown', last_sync_error_code = 'local_sync_failed',
                  updated_at = now()
            WHERE workspace_id = $1 AND twitch_reward_id = $2`,
          [workspace.id, rewardId],
        ),
    );
  }

  async listMappings(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
  ): Promise<TwitchRewardMapping[]> {
    const result = await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      (client) =>
        client.query<TwitchRewardMapping>(
          'SELECT id, workspace_id, twitch_reward_id, reward_title, reward_prompt, reward_cost, feature_key, feature_settings, enabled, sync_state, last_synced_at, last_sync_error_code, created_at, updated_at FROM twitch_reward_mappings WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC',
          [workspace.id],
        ),
    );
    return result.rows;
  }

  async linkExistingReward(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    input: NewTwitchRewardMapping,
  ): Promise<TwitchRewardMapping> {
    const remote = (await this.helix.listCustomRewards(workspace, actor)).find(
      (reward) => reward.id === input.rewardId,
    );
    if (!remote) throw new NotFoundException('The Twitch reward does not exist for this broadcaster.');
    try {
      return await this.database.transaction(
        { userId: actor.id, verifiedWorkspaceId: workspace.id },
        async (client) => {
          const inserted = await client.query<TwitchRewardMapping>(
            `INSERT INTO twitch_reward_mappings
              (workspace_id, twitch_reward_id, reward_title, reward_prompt, reward_cost,
               feature_key, feature_settings, enabled, sync_state, created_by_user_id, updated_by_user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,true,'synced',$8,$8)
             RETURNING id, workspace_id, twitch_reward_id, reward_title, reward_prompt, reward_cost,
               feature_key, feature_settings, enabled, sync_state, last_synced_at,
               last_sync_error_code, created_at, updated_at`,
            [
              workspace.id,
              input.rewardId,
              remote.title,
              remote.prompt || null,
              remote.cost,
              input.featureKey,
              JSON.stringify(input.featureSettings),
              actor.id,
            ],
          );
          const mapping = inserted.rows[0];
          if (!mapping) throw new Error('Twitch reward mapping insert did not return a row.');
          await this.recordChange(
            client,
            workspace.id,
            actor.id,
            mapping.id,
            'created',
            null,
            mapping,
          );
          await this.outbox.append(client, {
            workspaceId: workspace.id as VerifiedWorkspaceId,
            eventType: 'twitch.reward_mapping.created',
            aggregateType: 'twitch_reward_mapping',
            aggregateId: mapping.id,
            idempotencyKey: `twitch.reward_mapping.created:${mapping.id}`,
            payload: {
              mappingId: mapping.id,
              rewardId: mapping.twitch_reward_id,
              featureKey: mapping.feature_key,
              syncState: mapping.sync_state,
            },
          });
          return mapping;
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This Twitch reward is already linked in this workspace.');
      }
      throw error;
    }
  }

  async updateMapping(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    mappingId: string,
    input: UpdateTwitchRewardMapping,
  ): Promise<TwitchRewardMapping> {
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const currentResult = await client.query<TwitchRewardMapping>(
          'SELECT id, workspace_id, twitch_reward_id, reward_title, reward_prompt, reward_cost, feature_key, feature_settings, enabled, sync_state, last_synced_at, last_sync_error_code, created_at, updated_at FROM twitch_reward_mappings WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
          [workspace.id, mappingId],
        );
        const current = currentResult.rows[0];
        if (!current) throw new NotFoundException('Twitch reward mapping not found.');

        const nextFeature = input.featureKey ?? current.feature_key;
        const nextSettings = input.featureSettings ?? current.feature_settings;
        const nextEnabled = input.enabled ?? current.enabled;
        const updatedResult = await client.query<TwitchRewardMapping>(
          `UPDATE twitch_reward_mappings
              SET feature_key = $3, feature_settings = $4::jsonb, enabled = $5,
                  updated_by_user_id = $6, updated_at = now()
            WHERE workspace_id = $1 AND id = $2
            RETURNING id, workspace_id, twitch_reward_id, reward_title, reward_prompt, reward_cost,
              feature_key, feature_settings, enabled, sync_state, last_synced_at,
              last_sync_error_code, created_at, updated_at`,
          [
            workspace.id,
            mappingId,
            nextFeature,
            JSON.stringify(nextSettings),
            nextEnabled,
            actor.id,
          ],
        );
        const updated = updatedResult.rows[0];
        if (!updated) throw new Error('Twitch reward mapping update did not return a row.');
        await this.recordChange(
          client,
          workspace.id,
          actor.id,
          mappingId,
          'updated',
          current,
          updated,
        );
        await this.outbox.append(client, {
          workspaceId: workspace.id as VerifiedWorkspaceId,
          eventType: 'twitch.reward_mapping.updated',
          aggregateType: 'twitch_reward_mapping',
          aggregateId: mappingId,
          idempotencyKey: `twitch.reward_mapping.updated:${mappingId}:${randomUUID()}`,
          payload: {
            mappingId,
            rewardId: updated.twitch_reward_id,
            featureKey: updated.feature_key,
            enabled: updated.enabled,
            syncState: updated.sync_state,
          },
        });
        return updated;
      },
    );
  }

  private async recordChange(
    client: PoolClient,
    workspaceId: VerifiedWorkspaceId,
    actorId: string,
    mappingId: string,
    action: 'created' | 'updated',
    before: TwitchRewardMapping | null,
    after: TwitchRewardMapping,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
        (workspace_id, actor_user_id, event_type, target_type, target_id, details)
       VALUES ($1,$2,$3,'twitch_reward_mapping',$4,$5::jsonb)`,
      [
        workspaceId,
        actorId,
        `twitch.reward_mapping.${action}`,
        mappingId,
        JSON.stringify({
          rewardId: after.twitch_reward_id,
          before: before
            ? {
                featureKey: before.feature_key,
                featureSettings: before.feature_settings,
                enabled: before.enabled,
              }
            : null,
          after: {
            featureKey: after.feature_key,
            featureSettings: after.feature_settings,
            enabled: after.enabled,
            syncState: after.sync_state,
          },
        }),
      ],
    );
  }
}
