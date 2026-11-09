import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ProviderExecutionQueueModule } from '../providers/provider-execution-queue.module.js';
import { ProviderExecutionQueueService } from '../providers/provider-execution-queue.service.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { PlaybackRecoveryController } from './playback-recovery.controller.js';
import {
  PlaybackRecoveryService,
  type RecoverablePlaybackRequest,
} from './playback-recovery.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule, WorkspacesModule, ProviderExecutionQueueModule],
  controllers: [PlaybackRecoveryController, PlaybackRecoveryPolicyController],
  providers: [
    {
      provide: PlaybackRecoveryService,
      inject: [DatabaseService, ProviderExecutionQueueService],
      useFactory: (database: DatabaseService, executionQueue: ProviderExecutionQueueService) =>
        new PlaybackRecoveryService({
          getPolicy: async (workspaceId, actorId) => {
            const result = await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              async (client) => {
                await client.query(
                  'INSERT INTO workspace_provider_recovery_policies (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING',
                  [workspaceId],
                );
                return client.query<{
                  automatic_retry_enabled: boolean;
                  failover_enabled: boolean;
                  failover_on_permanent_failure: boolean;
                  max_attempts: number;
                  base_delay_ms: number;
                  max_delay_ms: number;
                }>(
                  `SELECT automatic_retry_enabled, failover_enabled, failover_on_permanent_failure,
                          max_attempts, base_delay_ms, max_delay_ms
                     FROM workspace_provider_recovery_policies WHERE workspace_id = $1`,
                  [workspaceId],
                );
              },
            );
            return mapRecoveryPolicy(result.rows[0]);
          },
          updatePolicy: async (workspaceId, actorId, policy, reason) =>
            database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              async (client) => {
                const result = await client.query<{
                  automatic_retry_enabled: boolean;
                  failover_enabled: boolean;
                  failover_on_permanent_failure: boolean;
                  max_attempts: number;
                  base_delay_ms: number;
                  max_delay_ms: number;
                }>(
                  `INSERT INTO workspace_provider_recovery_policies (
                     workspace_id, automatic_retry_enabled, failover_enabled,
                     failover_on_permanent_failure, max_attempts, base_delay_ms,
                     max_delay_ms, updated_by
                   )
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                   ON CONFLICT (workspace_id) DO UPDATE SET
                     automatic_retry_enabled = EXCLUDED.automatic_retry_enabled,
                     failover_enabled = EXCLUDED.failover_enabled,
                     failover_on_permanent_failure = EXCLUDED.failover_on_permanent_failure,
                     max_attempts = EXCLUDED.max_attempts,
                     base_delay_ms = EXCLUDED.base_delay_ms,
                     max_delay_ms = EXCLUDED.max_delay_ms,
                     updated_by = EXCLUDED.updated_by,
                     updated_at = now()
                   RETURNING automatic_retry_enabled, failover_enabled,
                             failover_on_permanent_failure, max_attempts,
                             base_delay_ms, max_delay_ms`,
                  [
                    workspaceId,
                    policy.automaticRetryEnabled,
                    policy.failoverEnabled,
                    policy.failoverOnPermanentFailure,
                    policy.maxAttempts,
                    policy.baseDelayMs,
                    policy.maxDelayMs,
                    actorId,
                  ],
                );
                await client.query(
                  `INSERT INTO audit_events
                    (workspace_id, actor_user_id, event_type, target_type, target_id, details)
                   VALUES ($1, $2, 'playback.recovery.policy.updated',
                           'workspace_provider_recovery_policy', $1, $3::jsonb)`,
                  [workspaceId, actorId, JSON.stringify({ ...policy, reason })],
                );
                return mapRecoveryPolicy(result.rows[0]);
              },
            ),
          authorize: async ({ workspaceId, actorId }) => {
            const result = await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              (client) =>
                client.query<{ role: string }>(
                  `SELECT role FROM workspace_memberships
                    WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
                  [workspaceId, actorId],
                ),
            );
            return { allowed: ['owner', 'admin'].includes(result.rows[0]?.role ?? '') };
          },
          getRequest: async ({ workspaceId, requestId, actorId }) => {
            const result = await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              (client) =>
                client.query<{
                  id: string;
                  workspace_id: string;
                  media_id: string | null;
                  status: string;
                  provider_instance_id: string | null;
                }>(
                  `SELECT r.id, r.workspace_id, r.media_id, r.status,
                          (SELECT s.provider_instance_id
                             FROM provider_execution_states s
                            WHERE s.workspace_id = r.workspace_id AND s.request_id = r.id
                            ORDER BY s.updated_at DESC LIMIT 1) AS provider_instance_id
                     FROM media_requests r
                    WHERE r.workspace_id = $1 AND r.id = $2`,
                  [workspaceId, requestId],
                ),
            );
            const row = result.rows[0];
            return row
              ? {
                  id: row.id,
                  workspaceId: row.workspace_id,
                  mediaId: row.media_id,
                  status: row.status,
                  providerInstanceId: row.provider_instance_id,
                }
              : null;
          },
          retry: async (request: RecoverablePlaybackRequest, actorId: string) => {
            const providerInstanceId = request.providerInstanceId;
            if (!providerInstanceId) {
              throw new Error(
                'No previous provider assignment exists; choose a provider with reroute.',
              );
            }
            await requeueFailedRequest(database, request, actorId);
            await executionQueue.enqueue({
              workspaceId: request.workspaceId,
              requestId: request.id,
              providerInstanceId,
              actorId,
            });
          },
          reroute: async (
            request: RecoverablePlaybackRequest,
            providerInstanceId: string,
            actorId: string,
          ) => {
            await requeueFailedRequest(database, request, actorId);
            await executionQueue.enqueue({
              workspaceId: request.workspaceId,
              requestId: request.id,
              providerInstanceId,
              actorId,
            });
          },
          skip: async (request: RecoverablePlaybackRequest, actorId: string, reason: string) => {
            await closeRequest(database, request, actorId, 'skipped', reason);
          },
          dismiss: async (request: RecoverablePlaybackRequest, actorId: string, reason: string) => {
            await closeRequest(database, request, actorId, 'cancelled', reason);
          },
          appendAudit: async (event) => {
            const workspaceId = String(event.workspaceId);
            const actorId = String(event.actorId);
            await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              async (client) => {
                await client.query(
                  `INSERT INTO provider_recovery_actions
                    (workspace_id, request_id, actor_user_id, action, reason, to_provider_instance_id)
                   VALUES ($1, $2, $3, $4, $5, $6)`,
                  [
                    workspaceId,
                    event.requestId,
                    actorId,
                    String(event.action).replace('playback.recovery.', ''),
                    event.reason,
                    event.providerInstanceId ?? null,
                  ],
                );
                await client.query(
                  `INSERT INTO audit_events
                    (workspace_id, actor_user_id, event_type, target_type, target_id, details)
                   VALUES ($1, $2, $3, 'media_request', $4, $5::jsonb)`,
                  [
                    workspaceId,
                    actorId,
                    event.action,
                    event.requestId,
                    JSON.stringify({ reason: event.reason, mediaId: event.mediaId }),
                  ],
                );
              },
            );
          },
        }),
    },
  ],
  exports: [PlaybackRecoveryService],
})
export class PlaybackRecoveryModule {}

async function requeueFailedRequest(
  database: DatabaseService,
  request: RecoverablePlaybackRequest,
  actorId: string,
): Promise<void> {
  await database.transaction(
    { userId: actorId, verifiedWorkspaceId: request.workspaceId as never },
    async (client) => {
      const locked = await client.query<{ status: string }>(
        `SELECT status FROM media_requests
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [request.workspaceId, request.id],
      );
      const status = locked.rows[0]?.status;
      if (!status) throw new Error('Playback request not found.');
      if (status === 'failed') {
        await client.query(
          `INSERT INTO workspace_queue_counters (workspace_id, next_sequence)
           VALUES ($1, 1) ON CONFLICT (workspace_id) DO NOTHING`,
          [request.workspaceId],
        );
        const sequence = await client.query<{ next_sequence: string }>(
          `UPDATE workspace_queue_counters SET next_sequence = next_sequence + 1
            WHERE workspace_id = $1 RETURNING (next_sequence - 1)::text AS next_sequence`,
          [request.workspaceId],
        );
        await client.query(
          `INSERT INTO logical_queue_entries (workspace_id, request_id, priority, sequence, inserted_by_user_id)
           SELECT workspace_id, id, priority, $3, $4 FROM media_requests
            WHERE workspace_id = $1 AND id = $2
           ON CONFLICT (request_id) DO UPDATE SET sequence = EXCLUDED.sequence`,
          [request.workspaceId, request.id, sequence.rows[0]?.next_sequence, actorId],
        );
        await client.query(
          `UPDATE media_requests SET status = 'queued', status_reason = NULL, updated_at = now()
            WHERE workspace_id = $1 AND id = $2`,
          [request.workspaceId, request.id],
        );
        await client.query(
          `INSERT INTO request_state_history
            (workspace_id, request_id, from_status, to_status, actor_user_id, actor_type, reason)
           VALUES ($1, $2, 'failed', 'queued', $3, 'moderator', 'Manual provider retry')`,
          [request.workspaceId, request.id, actorId],
        );
      }
    },
  );
}

async function closeRequest(
  database: DatabaseService,
  request: RecoverablePlaybackRequest,
  actorId: string,
  status: 'skipped' | 'cancelled',
  reason: string,
): Promise<void> {
  await database.transaction(
    { userId: actorId, verifiedWorkspaceId: request.workspaceId as never },
    async (client) => {
      const locked = await client.query<{ status: string }>(
        `SELECT status FROM media_requests
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [request.workspaceId, request.id],
      );
      const previous = locked.rows[0]?.status;
      if (!previous) throw new Error('Playback request not found.');
      const allowed: Record<string, string[]> = {
        queued: ['skipped', 'cancelled'],
        resolving: ['skipped', 'cancelled'],
        ready: ['skipped', 'cancelled'],
        playing: ['skipped'],
        failed: ['skipped', 'cancelled'],
      };
      if (!allowed[previous]?.includes(status)) {
        throw new Error(`Request cannot be ${status} from state ${previous}.`);
      }
      await client.query(
        `UPDATE media_requests SET status = $3, status_reason = $4, updated_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [request.workspaceId, request.id, status, reason],
      );
      await client.query(
        'DELETE FROM logical_queue_entries WHERE workspace_id = $1 AND request_id = $2',
        [request.workspaceId, request.id],
      );
      await client.query(
        `UPDATE provider_execution_states SET state = 'cancelled', updated_at = now()
          WHERE workspace_id = $1 AND request_id = $2
            AND state NOT IN ('completed', 'failed', 'cancelled')`,
        [request.workspaceId, request.id],
      );
      await client.query(
        `INSERT INTO request_state_history
          (workspace_id, request_id, from_status, to_status, actor_user_id, actor_type, reason)
         VALUES ($1, $2, $3, $4, $5, 'moderator', $6)`,
        [request.workspaceId, request.id, previous, status, actorId, reason],
      );
    },
  );
}

function mapRecoveryPolicy(
  row:
    | {
        automatic_retry_enabled: boolean;
        failover_enabled: boolean;
        failover_on_permanent_failure: boolean;
        max_attempts: number;
        base_delay_ms: number;
        max_delay_ms: number;
      }
    | undefined,
): WorkspaceProviderRecoveryPolicy {
  if (!row) throw new Error('Provider recovery policy could not be loaded.');
  return {
    automaticRetryEnabled: row.automatic_retry_enabled,
    failoverEnabled: row.failover_enabled,
    failoverOnPermanentFailure: row.failover_on_permanent_failure,
    maxAttempts: row.max_attempts,
    baseDelayMs: row.base_delay_ms,
    maxDelayMs: row.max_delay_ms,
  };
}
