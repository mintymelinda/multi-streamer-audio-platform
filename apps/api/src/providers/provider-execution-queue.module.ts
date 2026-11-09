import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import {
  ProviderExecutionQueueService,
  type ProviderExecutionJob,
  type ProviderExecutionStateInput,
} from './provider-execution-queue.service.js';

type RequestRow = {
  id: string;
  workspace_id: string;
  status: string;
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
  imports: [DatabaseModule],
  providers: [
    {
      provide: ProviderExecutionQueueService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) =>
        new ProviderExecutionQueueService({
          getRequestFromPostgres: async (requestId, workspaceId, actorId) => {
            if (!actorId) {
              throw new Error('Authenticated workspace user is required for provider execution.');
            }
            const result = await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              (client) =>
                client.query<RequestRow>(
                  `SELECT id, workspace_id, status
                     FROM media_requests
                    WHERE workspace_id = $1 AND id = $2`,
                  [workspaceId, requestId],
                ),
            );
            const row = result.rows[0];
            return row ? { id: row.id, workspaceId: row.workspace_id, status: row.status } : null;
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
