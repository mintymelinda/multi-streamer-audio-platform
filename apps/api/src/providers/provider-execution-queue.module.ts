import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { RightsComplianceModule } from '../compliance/rights-compliance.module.js';
import { RightsComplianceService } from '../compliance/rights-compliance.service.js';
import { ProviderRoutingService } from './provider-routing.service.js';
import {
  ProviderExecutionQueueService,
  type ProviderExecutionJob,
  type ProviderExecutionStateInput,
} from './provider-execution-queue.service.js';

type RequestRow = {
  id: string;
  workspace_id: string;
  status: string;
  provider: string | null;
  duration_ms: number | string | null;
};

type ExecutionRow = {
  id: string;
  workspace_id: string;
  request_id: string;
  provider_instance_id: string;
  state: ProviderExecutionStateInput['state'];
  attempt: number;
  dispatch_generation: number;
};

@Module({
  imports: [DatabaseModule, RightsComplianceModule],
  providers: [
    {
      provide: ProviderExecutionQueueService,
      inject: [DatabaseService, RightsComplianceService],
      useFactory: (database: DatabaseService, rightsCompliance: RightsComplianceService) =>
        new ProviderExecutionQueueService({
          routeProvider: async ({ workspaceId, actorId, request }) => {
            const routing = new ProviderRoutingService({
              listProviderInstances: async (tenantId, userId) => {
                if (!userId) throw new Error('Authenticated workspace user is required for routing.');
                const result = await database.transaction(
                  { userId, verifiedWorkspaceId: tenantId as never },
                  (client) => client.query<{
                    id: string;
                    provider_id: string;
                    enabled: boolean;
                    connection_health: 'healthy' | 'degraded' | 'unavailable' | 'authorization_expired' | 'unconfigured';
                    capabilities: Record<string, unknown>;
                  }>(
                    `SELECT id, provider_id, enabled, connection_health, capabilities
                       FROM provider_instances WHERE workspace_id = $1`,
                    [tenantId],
                  ),
                );
                return result.rows.map((row) => ({
                  providerId: row.provider_id,
                  instanceId: row.id,
                  enabled: row.enabled,
                  health: row.connection_health,
                  priority: 0,
                  capabilities: {
                    search: row.capabilities.search === true,
                    resolve: row.capabilities.resolve === true,
                    playback: row.capabilities.playback === true,
                    pause: row.capabilities.pause === true,
                    resume: row.capabilities.resume === true,
                    seek: row.capabilities.seek === true,
                    queue: row.capabilities.queue === true,
                    maxDurationSeconds: typeof row.capabilities.maxDurationSeconds === 'number'
                      ? row.capabilities.maxDurationSeconds
                      : null,
                    mediaTypes: Array.isArray(row.capabilities.mediaTypes)
                      ? row.capabilities.mediaTypes.filter(
                          (value): value is 'audio' | 'video' | 'live_stream' =>
                            value === 'audio' || value === 'video' || value === 'live_stream',
                        )
                      : [],
                    ...(Array.isArray(row.capabilities.supportedSourceProviderIds)
                      ? {
                          supportedSourceProviderIds: row.capabilities.supportedSourceProviderIds.filter(
                            (value): value is string => typeof value === 'string',
                          ),
                        }
                      : {}),
                  },
                }));
              },
              getWorkspaceRules: async (tenantId, userId) => {
                if (!userId) throw new Error('Authenticated workspace user is required for routing.');
                const result = await database.transaction(
                  { userId, verifiedWorkspaceId: tenantId as never },
                  (client) => client.query<{ provider_id: string }>(
                    `SELECT provider_id FROM workspace_provider_path_restrictions
                      WHERE workspace_id = $1 AND disabled_at IS NOT NULL`,
                    [tenantId],
                  ),
                );
                return {
                  allowedProviderIds: [],
                  blockedProviderIds: result.rows.map((row) => row.provider_id),
                  preferredProviderIds: [],
                };
              },
              getOutputAssignment: async (tenantId, providerInstanceId, userId) => {
                if (!userId) throw new Error('Authenticated workspace user is required for routing.');
                const result = await database.transaction(
                  { userId, verifiedWorkspaceId: tenantId as never },
                  (client) => client.query<{
                    output_id: string;
                    provider_instance_id: string;
                    player_id: string;
                  }>(
                    `SELECT assignment.output_id, assignment.provider_instance_id, assignment.player_id
                       FROM provider_output_assignments assignment
                      WHERE assignment.workspace_id = $1
                        AND assignment.provider_instance_id = $2
                        AND assignment.active = true
                        AND NOT EXISTS (
                          SELECT 1
                            FROM provider_execution_states active_execution
                            JOIN provider_output_assignments active_assignment
                              ON active_assignment.workspace_id = active_execution.workspace_id
                             AND active_assignment.provider_instance_id = active_execution.provider_instance_id
                             AND active_assignment.active = true
                           WHERE active_assignment.workspace_id = assignment.workspace_id
                             AND active_assignment.output_id = assignment.output_id
                             AND active_execution.state IN ('resolving', 'ready', 'playing')
                                            )
                        AND NOT EXISTS (
                          SELECT 1
                            FROM playback_operations active_operation
                           WHERE active_operation.workspace_id = assignment.workspace_id
                             AND active_operation.output_id = assignment.output_id
                             AND active_operation.status IN ('pending', 'executing', 'uncertain')
                        )`,
                    [tenantId, providerInstanceId],
                  ),
                );
                return result.rows.map((row) => ({
                  outputId: row.output_id,
                  providerInstanceId: row.provider_instance_id,
                  playerId: row.player_id,
                }));
              },
            });
            return routing.route({ workspaceId, actorId, request });
          },
          assertExecutionEligible: async ({ workspaceId, requestId, providerInstanceId, actorId }) => {
            await rightsCompliance.assertWorkspacePlaybackEligible({ workspaceId, actorId });
            await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              async (client) => {
                const provider = await client.query<{ provider_id: string; source_provider_id: string | null; capabilities: Record<string, unknown> }>(
                  `SELECT p.provider_id, p.capabilities, r.provider AS source_provider_id
                     FROM provider_instances p
                     JOIN media_requests r ON r.workspace_id = p.workspace_id AND r.id = $3
                    WHERE p.workspace_id = $1 AND p.id = $2`,
                  [workspaceId, providerInstanceId, requestId],
                );
                const providerId = provider.rows[0]?.provider_id;
                const sourceProviderId = provider.rows[0]?.source_provider_id;
                if (!providerId) throw new Error('Provider instance was not found in this workspace.');
                if (!sourceProviderId) throw new Error('The request has no supported media source provider.');
                const supportedSources = provider.rows[0]?.capabilities.supportedSourceProviderIds;
                if (Array.isArray(supportedSources) && !supportedSources.includes(sourceProviderId)) {
                  throw new Error('The selected playback output does not support this media source provider.');
                }
                const sourceProvider = await client.query(
                  `SELECT 1 FROM provider_instances
                    WHERE workspace_id = $1 AND provider_id = $2
                      AND enabled = true AND connection_health = 'healthy'
                      AND COALESCE((capabilities->>'resolve')::boolean, false) = true
                    LIMIT 1`,
                  [workspaceId, sourceProviderId],
                );
                if ((sourceProvider.rowCount ?? 0) !== 1) {
                  throw new Error('No healthy source resolver is configured for this media provider.');
                }
                if (sourceProviderId === 'spotify') {
                  const credential = await client.query(
                    `SELECT 1 FROM provider_credentials
                      WHERE workspace_id = $1 AND provider_instance_id IN (
                        SELECT id FROM provider_instances
                         WHERE workspace_id = $1 AND provider_id = 'spotify'
                           AND enabled = true AND connection_health = 'healthy'
                      )
                        AND status = 'connected'
                        AND (expires_at IS NULL OR expires_at > now())
                      LIMIT 1`,
                    [workspaceId],
                  );
                  if ((credential.rowCount ?? 0) !== 1) {
                    throw new Error('Spotify source authorization is unavailable or expired.');
                  }
                }
                const restriction = await client.query(
                  `SELECT 1 FROM workspace_provider_path_restrictions
                    WHERE workspace_id = $1 AND provider_id = ANY($2::text[]) AND disabled_at IS NOT NULL
                    LIMIT 1`,
                  [workspaceId, [providerId, sourceProviderId].filter((value): value is string => Boolean(value))],
                );
                if ((restriction.rowCount ?? 0) > 0) {
                  const error = new Error('This provider path is disabled by workspace rights policy.');
                  Object.assign(error, { code: 'PROVIDER_PATH_DISABLED' });
                  throw error;
                }
                const blocked = await client.query(
                  `SELECT 1 FROM media_requests r
                    JOIN provider_instances p
                      ON p.workspace_id = r.workspace_id AND p.id = $3
                    JOIN rights_content_blocks b
                      ON b.workspace_id = r.workspace_id
                     AND b.content_id IN (r.media_id, p.provider_id || ':' || r.media_id, r.provider || ':' || r.media_id)
                   WHERE r.workspace_id = $1 AND r.id = $2
                   LIMIT 1`,
                  [workspaceId, requestId, providerInstanceId],
                );
                if ((blocked.rowCount ?? 0) > 0) {
                  const error = new Error('This media item is blocked by workspace rights policy.');
                  Object.assign(error, { code: 'RIGHTS_CONTENT_BLOCKED' });
                  throw error;
                }
              },
            );
          },
          getRequestFromPostgres: async (requestId, workspaceId, actorId) => {
            if (!actorId) {
              throw new Error('Authenticated workspace user is required for provider execution.');
            }
            const result = await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              (client) =>
                client.query<RequestRow>(
                  `SELECT id, workspace_id, status, provider, duration_ms
                     FROM media_requests
                    WHERE workspace_id = $1 AND id = $2`,
                  [workspaceId, requestId],
                ),
            );
            const row = result.rows[0];
            return row
              ? {
                  id: row.id,
                  workspaceId: row.workspace_id,
                  status: row.status,
                  sourceProviderId: row.provider,
                  durationSeconds: row.duration_ms === null ? null : Number(row.duration_ms) / 1000,
                }
              : null;
          },
          enqueueProviderExecution: async (job: ProviderExecutionJob) => {
            const actorId = job.actorId ?? '';
            if (!actorId) {
              throw new Error('Authenticated workspace user is required for provider execution.');
            }
            return database.transaction(
              { userId: actorId, verifiedWorkspaceId: job.workspaceId as never },
              async (client) => {
                const request = await client.query<RequestRow>(
                  `SELECT id, workspace_id, status
                     FROM media_requests
                    WHERE workspace_id = $1 AND id = $2
                    FOR SHARE`,
                  [job.workspaceId, job.requestId],
                );
                if (
                  !request.rows[0] ||
                  ['completed', 'dismissed', 'rejected', 'cancelled', 'failed', 'skipped'].includes(
                    request.rows[0].status,
                  )
                ) {
                  throw new Error('The authoritative request is missing or terminal.');
                }
                const persisted = await client.query<ExecutionRow>(
                  `INSERT INTO provider_execution_states (
                     workspace_id, request_id, provider_instance_id, state, attempt
                   )
                   VALUES ($1, $2, $3, 'queued', 0)
                   ON CONFLICT (workspace_id, request_id, provider_instance_id)
                   DO UPDATE SET
                     state = CASE
                       WHEN provider_execution_states.state IN ('failed', 'retry_wait') THEN 'queued'
                       ELSE provider_execution_states.state END,
                     attempt = CASE
                       WHEN provider_execution_states.state IN ('failed', 'retry_wait') THEN 0
                       ELSE provider_execution_states.attempt END,
                     next_attempt_at = CASE
                       WHEN provider_execution_states.state IN ('failed', 'retry_wait') THEN NULL
                       ELSE provider_execution_states.next_attempt_at END,
                     last_error_code = CASE
                       WHEN provider_execution_states.state IN ('failed', 'retry_wait') THEN NULL
                       ELSE provider_execution_states.last_error_code END,
                     dispatch_generation = CASE
                       WHEN provider_execution_states.state IN ('failed', 'retry_wait')
                         THEN provider_execution_states.dispatch_generation + 1
                       ELSE provider_execution_states.dispatch_generation END,
                     updated_at = now()
                   WHERE provider_execution_states.state NOT IN ('completed', 'cancelled')
                   RETURNING id, workspace_id, request_id, provider_instance_id, state, attempt, dispatch_generation`,
                  [job.workspaceId, job.requestId, job.providerInstanceId],
                );
                const row = persisted.rows[0];
                if (!row) throw new Error('Provider execution is already terminal.');
                await client.query(
                  `INSERT INTO outbox_events (
                     workspace_id, event_type, aggregate_type, aggregate_id, idempotency_key, payload
                   )
                   VALUES ($1, 'provider.execution.queued', 'provider_execution_state', $2, $3, $4::jsonb)
                   ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
                  [
                    job.workspaceId,
                    row.id,
                    `provider-execution:${job.workspaceId}:${job.requestId}:${job.providerInstanceId}:${row.dispatch_generation}`,
                    JSON.stringify({
                      executionStateId: row.id,
                      requestId: job.requestId,
                      providerInstanceId: job.providerInstanceId,
                      queueName: job.queueName,
                      dispatchGeneration: row.dispatch_generation,
                    }),
                  ],
                );
                return job;
              },
            );
          },
          updateProviderExecutionState: async (state: ProviderExecutionStateInput) => {
            if (!state.actorId) {
              throw new Error('Authenticated workspace user is required for provider execution.');
            }
            return database.transaction(
              { userId: state.actorId, verifiedWorkspaceId: state.workspaceId as never },
              async (client) => {
                const request = await client.query<RequestRow>(
                  `SELECT id, status FROM media_requests
                    WHERE workspace_id = $1 AND id = $2 FOR SHARE`,
                  [state.workspaceId, state.requestId],
                );
                if (
                  !request.rows[0] ||
                  ['completed', 'rejected', 'cancelled', 'failed', 'skipped'].includes(
                    request.rows[0].status,
                  )
                ) {
                  throw new Error('The authoritative request is missing or terminal.');
                }
                const result = await client.query<ExecutionRow>(
                  `INSERT INTO provider_execution_states (
                     workspace_id, request_id, provider_instance_id, state, attempt,
                     next_attempt_at, last_error_code
                   )
                   VALUES ($1, $2, $3, $4, $5, $6, $7)
                   ON CONFLICT (workspace_id, request_id, provider_instance_id)
                   DO UPDATE SET
                     state = EXCLUDED.state,
                     attempt = EXCLUDED.attempt,
                     next_attempt_at = EXCLUDED.next_attempt_at,
                     last_error_code = EXCLUDED.last_error_code,
                     updated_at = now()
                   RETURNING id, workspace_id, request_id, provider_instance_id, state, attempt`,
                  [
                    state.workspaceId,
                    state.requestId,
                    state.providerInstanceId,
                    state.state,
                    state.attempt,
                    state.nextAttemptAt ?? null,
                    state.errorCode ?? null,
                  ],
                );
                return result.rows[0];
              },
            );
          },
        }),
    },
  ],
  exports: [ProviderExecutionQueueService],
})
export class ProviderExecutionQueueModule {}
