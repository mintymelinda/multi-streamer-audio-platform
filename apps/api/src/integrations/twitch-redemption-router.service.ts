import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { VerifiedWorkspaceId } from '@platform/contracts';
import { DatabaseService } from '../database/database.service.js';
import type { WorkspaceRequestContext } from '../identity/http.types.js';
import { RequestsService } from '../requests/requests.service.js';
import { buildTwitchRedemptionRequest } from './twitch-redemption-routing.js';

interface IntakeRow {
  id: string;
  workspace_id: VerifiedWorkspaceId;
  service_actor_user_id: string | null;
  event_type: string;
  event_id: string;
  message_id: string;
  event_payload: Record<string, unknown>;
  routing_attempts: number;
  routing_lock_token: string;
}

interface RewardMappingRow {
  id: string;
  twitch_reward_id: string;
  feature_key: string;
  feature_settings: {
    inputMode?: 'url_or_search' | 'url_only' | 'text_only';
    priority?: number;
  };
  enabled: boolean;
  sync_state: string;
}

const REDEMPTION_EVENT = 'channel.channel_points_custom_reward_redemption.add';

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('getStatus' in error)) {
    return undefined;
  }
  const getStatus = (error as { getStatus?: unknown }).getStatus;
  return typeof getStatus === 'function' ? (getStatus as () => number).call(error) : undefined;
}

@Injectable()
export class TwitchRedemptionRouterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TwitchRedemptionRouterService.name);
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.routeBatch().catch((error: unknown) => {
        this.logger.error(
          'Twitch redemption routing cycle failed',
          error instanceof Error ? error.stack : undefined,
        );
      });
    }, 1_000);
    void this.routeBatch();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async routeBatch(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const rows = await this.claimBatch();
      for (const row of rows) await this.routeOne(row);
    } finally {
      this.inFlight = false;
    }
  }

  private async claimBatch(): Promise<IntakeRow[]> {
    return this.database.transaction({}, async (client) => {
      const result = await client.query<IntakeRow>(
        `WITH candidates AS (
           SELECT id
             FROM twitch_eventsub_intake
            WHERE (routing_status = 'pending' AND routing_next_attempt_at <= now())
               OR (routing_status = 'processing'
                   AND routing_locked_at < now() - interval '60 seconds')
            ORDER BY received_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 10
         )
         UPDATE twitch_eventsub_intake AS intake
            SET routing_status = 'processing',
                routing_attempts = intake.routing_attempts + 1,
                routing_locked_at = now(),
                routing_lock_token = gen_random_uuid()
           FROM candidates
          WHERE intake.id = candidates.id
         RETURNING intake.id, intake.workspace_id, intake.service_actor_user_id,
                   intake.event_type, intake.event_id, intake.message_id,
                   intake.event_payload, intake.routing_attempts, intake.routing_lock_token`,
      );
      return result.rows;
    });
  }

  private async routeOne(row: IntakeRow): Promise<void> {
    try {
      if (row.event_type !== REDEMPTION_EVENT || !row.service_actor_user_id) {
        await this.finish(row, 'ignored', null, 'unsupported_event_or_missing_service_actor');
        return;
      }

      const event = row.event_payload;
      const reward = event.reward as Record<string, unknown> | undefined;
      const rewardId = typeof reward?.id === 'string' ? reward.id : '';
      if (!rewardId) {
        await this.finish(row, 'ignored', null, 'redemption_reward_id_missing');
        return;
      }

      const mappingResult = await this.database.transaction(
        { userId: row.service_actor_user_id, verifiedWorkspaceId: row.workspace_id },
        (client) =>
          client.query<RewardMappingRow>(
            `SELECT mapping.id, mapping.twitch_reward_id, mapping.feature_key,
                    mapping.feature_settings, mapping.enabled, mapping.sync_state
               FROM twitch_reward_mappings AS mapping
               JOIN workspaces AS workspace ON workspace.id = mapping.workspace_id
               JOIN platform_users AS owner ON owner.id = $3
              WHERE mapping.workspace_id = $1 AND mapping.twitch_reward_id = $2
                AND workspace.owner_user_id = owner.id
                AND workspace.status = 'active' AND owner.status = 'active'
              LIMIT 1`,
            [row.workspace_id, rewardId, row.service_actor_user_id],
          ),
      );
      const mapping = mappingResult.rows[0];
      if (
        !mapping ||
        !mapping.enabled ||
        mapping.sync_state !== 'synced' ||
        mapping.feature_key !== 'media_request'
      ) {
        await this.finish(row, 'ignored', null, 'reward_mapping_not_enabled_and_synced');
        return;
      }

      const requestInput = buildTwitchRedemptionRequest(
        event,
        mapping.feature_settings.inputMode ?? 'url_or_search',
        row.event_id,
        mapping.id,
        rewardId,
      );
      if (!requestInput) {
        await this.finish(row, 'ignored', null, 'redemption_input_rejected');
        return;
      }

      const workspace: WorkspaceRequestContext = {
        id: row.workspace_id,
        role: 'owner',
        status: 'active',
      };
      const request = await this.requests.submit({
        workspace,
        serviceActorUserId: row.service_actor_user_id,
        source: 'twitch_reward',
        ...requestInput,
        priority: mapping.feature_settings.priority ?? 0,
        metadata: {
          ...requestInput.metadata,
          eventSubMessageId: row.message_id,
          priority: mapping.feature_settings.priority ?? 0,
        },
      });
      await this.finish(
        row,
        'processed',
        typeof request.id === 'string' ? request.id : null,
        null,
      );
    } catch (error) {
      const terminal = row.routing_attempts >= 8;
      const statusCode = httpStatus(error);
      const code =
        statusCode === 400 || statusCode === 409
          ? 'request_policy_rejected'
          : 'redemption_routing_failed';
      await this.finish(
        row,
        terminal || code === 'request_policy_rejected' ? 'failed' : 'pending',
        null,
        code,
      );
      if (code === 'redemption_routing_failed') {
        this.logger.warn(`Twitch redemption intake ${row.id} will be retried.`);
      }
    }
  }

  private async finish(
    row: IntakeRow,
    status: 'processed' | 'ignored' | 'failed' | 'pending',
    requestId: string | null,
    errorCode: string | null,
  ): Promise<void> {
    await this.database.transaction({}, (client) =>
      client.query(
        `UPDATE twitch_eventsub_intake
            SET routing_status = $2,
                routed_request_id = $3,
                routing_error_code = $4,
                routing_next_attempt_at = CASE WHEN $2 = 'pending'
                  THEN now() + make_interval(secs => LEAST(300, power(2, LEAST(routing_attempts, 8))::integer))
                  ELSE routing_next_attempt_at END,
                routing_locked_at = NULL,
                routing_lock_token = NULL
          WHERE id = $1 AND routing_lock_token = $5`,
        [row.id, status, requestId, errorCode, row.routing_lock_token],
      ),
    );
  }
}
