import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { DatabaseService } from '../database/database.service.js';
import { PlaybackCoordinatorService } from '../playback/playback-coordinator.service.js';
import { QueueManagerService } from '../queues/queue-manager.service.js';

type HandoffPayload = {
  executionStateId: string;
  workspaceId: string;
  requestId: string;
  providerInstanceId: string;
  dispatchGeneration: number;
  actorUserId: string;
};

type ExecutionRow = {
  source: 'twitch_reward' | 'dashboard' | 'moderator' | 'api';
  submitted_by_user_id: string | null;
  source_event_id: string | null;
  source_provider_id: string | null;
  owner_user_id: string;
  request_status: string;
  execution_state: string;
  dispatch_generation: number;
  next_attempt_at: Date | null;
  provider_id: string;
  capabilities: Record<string, unknown>;
  output_id: string;
  player_id: string;
  media_id: string | null;
  media_url: string | null;
  title: string;
  artist: string | null;
  duration_ms: string | null;
  metadata: Record<string, unknown>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxClockSkewSeconds = 300;

function handoffSecret(): string {
  const file = process.env.PROVIDER_EXECUTION_HANDOFF_SECRET_FILE;
  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (value.length >= 32) return value;
  }
  if (process.env.NODE_ENV !== 'production') {
    const value = process.env.PROVIDER_EXECUTION_HANDOFF_SECRET?.trim();
    if (value && value.length >= 32) return value;
  }
  throw new Error('Provider execution handoff secret is not configured.');
}

export function signProviderExecutionHandoff(
  secret: string,
  timestamp: string,
  body: unknown,
): string {
  return createHmac('sha256', secret).update(`${timestamp}.${JSON.stringify(body)}`).digest('hex');
}

export function verifyProviderExecutionHandoffSignature(input: {
  secret: string;
  timestamp: string;
  signature: string;
  body: unknown;
  nowSeconds?: number;
}): boolean {
  if (!/^\d{10}$/.test(input.timestamp) || !/^[a-f0-9]{64}$/i.test(input.signature)) return false;
  const timestamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > maxClockSkewSeconds) return false;
  const expected = Buffer.from(signProviderExecutionHandoff(input.secret, input.timestamp, input.body), 'hex');
  const supplied = Buffer.from(input.signature, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function transitionRequestStatus(
  client: PoolClient,
  input: {
    workspaceId: string;
    requestId: string;
    actorUserId: string;
    from: string;
    to: string;
    operationId: string;
  },
): Promise<void> {
  const updated = await client.query(
    `UPDATE media_requests SET status = $4, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = $3`,
    [input.workspaceId, input.requestId, input.from, input.to],
  );
  if (updated.rowCount !== 1) {
    throw new Error('Request lifecycle changed before the provider outcome was persisted.');
  }
  await client.query(
    `INSERT INTO request_state_history
      (workspace_id, request_id, from_status, to_status, actor_user_id, actor_type)
     VALUES ($1, $2, $3, $4, $5, 'system')`,
    [input.workspaceId, input.requestId, input.from, input.to, input.actorUserId],
  );
  await client.query(
    `INSERT INTO outbox_events
      (workspace_id, event_type, aggregate_type, aggregate_id, idempotency_key, payload)
     VALUES ($1, 'request.status.changed', 'media_request', $2, $3, $4::jsonb)
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
    [
      input.workspaceId,
      input.requestId,
      `request.status:${input.requestId}:${input.from}:${input.to}:${input.operationId}`,
      JSON.stringify({ requestId: input.requestId, from: input.from, to: input.to }),
    ],
  );
}

function parsePayload(value: unknown): HandoffPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Invalid provider execution handoff.');
  }
  const input = value as Record<string, unknown>;
  for (const field of ['executionStateId', 'workspaceId', 'requestId', 'providerInstanceId', 'actorUserId']) {
    if (typeof input[field] !== 'string' || !uuidPattern.test(input[field] as string)) {
      throw new BadRequestException(`Invalid provider execution ${field}.`);
    }
  }
  if (!Number.isSafeInteger(input.dispatchGeneration) || Number(input.dispatchGeneration) < 1) {
    throw new BadRequestException('Invalid provider execution dispatch generation.');
  }
  return {
    executionStateId: input.executionStateId as string,
    workspaceId: input.workspaceId as string,
    requestId: input.requestId as string,
    providerInstanceId: input.providerInstanceId as string,
    dispatchGeneration: Number(input.dispatchGeneration),
    actorUserId: input.actorUserId as string,
  };
}

@Controller('internal/provider-executions')
export class ProviderExecutionHandoffController {
  constructor(
    private readonly database: DatabaseService,
    private readonly coordinator: PlaybackCoordinatorService,
    private readonly queueManager: QueueManagerService,
  ) {}

  @Post('handoff')
  @HttpCode(202)
  async handoff(
    @Body() body: unknown,
    @Headers('x-provider-execution-timestamp') timestamp: string | undefined,
    @Headers('x-provider-execution-signature') signature: string | undefined,
  ): Promise<{ accepted: true; operationId: string | null; status: string }> {
    if (!timestamp || !signature) throw new UnauthorizedException('Invalid worker authentication.');
    if (!verifyProviderExecutionHandoffSignature({
      secret: handoffSecret(),
      timestamp,
      signature,
      body,
    })) {
      throw new UnauthorizedException('Invalid worker authentication.');
    }

    const input = parsePayload(body);
    const execution = await this.database.transaction(
      { userId: input.actorUserId, verifiedWorkspaceId: input.workspaceId as never },
      async (client) => {
        const result = await client.query<ExecutionRow>(
          `SELECT r.source, r.submitted_by_user_id, r.source_event_id, r.provider AS source_provider_id,
                  w.owner_user_id, r.status AS request_status,
                  s.state AS execution_state, s.dispatch_generation, s.next_attempt_at,
                  p.provider_id, p.capabilities, o.output_id, o.player_id,
                  r.media_id, r.media_url, r.title, r.artist, r.duration_ms, r.metadata
             FROM media_requests r
             JOIN workspaces w ON w.id = r.workspace_id
             JOIN provider_execution_states s
               ON s.workspace_id = r.workspace_id AND s.request_id = r.id
             JOIN provider_instances p
               ON p.workspace_id = s.workspace_id AND p.id = s.provider_instance_id
             JOIN provider_output_assignments o
               ON o.workspace_id = p.workspace_id AND o.provider_instance_id = p.id
              AND o.active = true
            WHERE r.workspace_id = $1 AND r.id = $2
              AND s.id = $3 AND s.provider_instance_id = $4
              AND s.dispatch_generation = $5
              AND s.state IN ('queued', 'retry_wait', 'resolving')
              AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= now())
              AND r.status = 'queued' AND r.provider IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM provider_instances source_provider
                 WHERE source_provider.workspace_id = r.workspace_id
                   AND source_provider.provider_id = r.provider
                   AND source_provider.enabled = true
                   AND source_provider.connection_health = 'healthy'
                   AND COALESCE((source_provider.capabilities->>'resolve')::boolean, false) = true
                   AND (
                     source_provider.provider_id <> 'spotify'
                     OR EXISTS (
                       SELECT 1 FROM provider_credentials source_credential
                        WHERE source_credential.workspace_id = r.workspace_id
                          AND source_credential.provider_instance_id = source_provider.id
                          AND source_credential.status = 'connected'
                          AND (source_credential.expires_at IS NULL OR source_credential.expires_at > now())
                     )
                   )
              )
              AND p.enabled = true
              AND COALESCE((p.capabilities->>'playback')::boolean, false) = true
              AND (
                NOT (p.capabilities ? 'supportedSourceProviderIds')
                OR ((p.capabilities->'supportedSourceProviderIds') ? r.provider)
              )
              AND p.connection_health = 'healthy'
              AND COALESCE((SELECT policy.enabled FROM workspace_playback_policies policy
                             WHERE policy.workspace_id = r.workspace_id), true) = true
              AND NOT EXISTS (
                SELECT 1 FROM workspace_provider_path_restrictions restriction
                 WHERE restriction.workspace_id = r.workspace_id
                   AND restriction.provider_id IN (p.provider_id, r.provider)
                   AND restriction.disabled_at IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM rights_content_blocks block
                 WHERE block.workspace_id = r.workspace_id
                   AND block.content_id IN (r.media_id, p.provider_id || ':' || r.media_id, r.provider || ':' || r.media_id)
              )
              AND EXISTS (
                SELECT 1 FROM logical_queue_entries q
                 WHERE q.workspace_id = r.workspace_id AND q.request_id = r.id
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM logical_queue_entries earlier_queue
                  JOIN media_requests earlier_request
                    ON earlier_request.workspace_id = earlier_queue.workspace_id
                   AND earlier_request.id = earlier_queue.request_id
                  JOIN logical_queue_entries current_queue
                    ON current_queue.workspace_id = r.workspace_id
                   AND current_queue.request_id = r.id
                 WHERE earlier_queue.workspace_id = r.workspace_id
                   AND earlier_queue.request_id <> r.id
                   AND earlier_request.status IN ('queued', 'resolving', 'ready')
                   AND (
                     earlier_queue.priority > current_queue.priority
                     OR (
                       earlier_queue.priority = current_queue.priority
                       AND earlier_queue.sequence < current_queue.sequence
                     )
                   )
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM provider_execution_states other_execution
                 WHERE other_execution.workspace_id = r.workspace_id
                   AND other_execution.request_id = r.id
                   AND other_execution.id <> s.id
                   AND other_execution.state IN ('resolving', 'ready', 'playing')
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM provider_execution_states active_execution
                  JOIN provider_output_assignments active_output
                    ON active_output.workspace_id = active_execution.workspace_id
                   AND active_output.provider_instance_id = active_execution.provider_instance_id
                   AND active_output.active = true
                 WHERE active_execution.workspace_id = r.workspace_id
                   AND active_output.output_id = o.output_id
                   AND active_execution.request_id <> r.id
                   AND active_execution.state IN ('resolving', 'ready', 'playing')
                        )
              AND NOT EXISTS (
                SELECT 1
                  FROM playback_operations active_operation
                 WHERE active_operation.workspace_id = r.workspace_id
                   AND active_operation.output_id = o.output_id
                   AND active_operation.request_id <> r.id
                   AND active_operation.status IN ('pending', 'executing', 'uncertain')
              )
              AND (p.provider_id <> 'spotify' OR EXISTS (
                SELECT 1 FROM provider_credentials credential
                 WHERE credential.workspace_id = p.workspace_id
                   AND credential.provider_instance_id = p.id
                   AND credential.status = 'connected'
                   AND (credential.expires_at IS NULL OR credential.expires_at > now())
              ))
            LIMIT 1`,
          [
            input.workspaceId,
            input.requestId,
            input.executionStateId,
            input.providerInstanceId,
            input.dispatchGeneration,
          ],
        );
        const row = result.rows[0];
        if (!row) return null;
        const actorId = row.source === 'twitch_reward' ? row.owner_user_id : row.submitted_by_user_id;
        if (!actorId || actorId !== input.actorUserId) return null;
        if (row.source === 'twitch_reward') {
          const event = await client.query(
            `SELECT 1 FROM twitch_eventsub_intake
              WHERE workspace_id = $1 AND routed_request_id = $2
                AND event_id = $3 AND routing_status = 'processed'
                AND service_actor_user_id = $4 LIMIT 1`,
            [input.workspaceId, input.requestId, row.source_event_id, row.owner_user_id],
          );
          if ((event.rowCount ?? 0) !== 1) return null;
        } else if (!['dashboard', 'moderator', 'api'].includes(row.source)) {
          return null;
        }
        if (row.execution_state !== 'resolving') {
          const claimed = await client.query(
            `UPDATE provider_execution_states
                SET state = 'resolving', attempt = attempt + 1, updated_at = now()
              WHERE id = $1 AND workspace_id = $2 AND request_id = $3
                AND provider_instance_id = $4 AND dispatch_generation = $5
                AND state IN ('queued', 'retry_wait')
                AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                AND EXISTS (
                  SELECT 1 FROM media_requests r
                   WHERE r.workspace_id = $2 AND r.id = $3 AND r.status = 'queued'
                )
                AND EXISTS (
                  SELECT 1 FROM logical_queue_entries q
                   WHERE q.workspace_id = $2 AND q.request_id = $3
                )`,
            [
              input.executionStateId,
              input.workspaceId,
              input.requestId,
              input.providerInstanceId,
              input.dispatchGeneration,
            ],
          );
          if (claimed.rowCount !== 1) return null;
        }
        return row;
      },
    );

    if (!execution) {
      // Stale jobs are acknowledged so BullMQ does not retry obsolete dispatches.
      return { accepted: true, operationId: null, status: 'stale_or_unauthorized' };
    }

    const operation = await this.coordinator.execute({
      workspaceId: input.workspaceId,
      providerInstanceId: input.providerInstanceId,
      playerId: execution.player_id,
      outputId: execution.output_id,
      requestId: input.requestId,
      command: 'play',
      idempotencyKey: `provider-execution:${input.executionStateId}:${input.dispatchGeneration}`,
      actorId: input.actorUserId,
      payload: {
        mediaId: execution.media_id,
        mediaUrl: execution.media_url,
        title: execution.title,
        artist: execution.artist,
        durationMs: execution.duration_ms,
        metadata: execution.metadata,
        sourceProviderId: execution.source_provider_id,
      },
    });
    const executionState = operation.status === 'failed'
      ? 'failed'
      : operation.status === 'completed' || operation.status === 'reconciled'
        ? 'playing'
        : 'resolving';
    await this.database.transaction(
      { userId: input.actorUserId, verifiedWorkspaceId: input.workspaceId as never },
      async (client) => {
        const persisted = await client.query(
          `UPDATE provider_execution_states
              SET state = $1, last_error_code = $2, updated_at = now()
            WHERE id = $3 AND workspace_id = $4 AND dispatch_generation = $5
            RETURNING id`,
          [
            executionState,
            operation.errorCode ?? null,
            input.executionStateId,
            input.workspaceId,
            input.dispatchGeneration,
          ],
        );
        if (persisted.rowCount !== 1) {
          throw new Error('Provider execution generation changed before its outcome was persisted.');
        }

        if (executionState === 'playing' || executionState === 'failed') {
          const request = await client.query<{ status: string }>(
            `SELECT status FROM media_requests
              WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
            [input.workspaceId, input.requestId],
          );
          let status = request.rows[0]?.status;
          if (!status) throw new Error('The authoritative request disappeared during playback handoff.');

          if (status === 'queued') {
            await transitionRequestStatus(client, {
              workspaceId: input.workspaceId,
              requestId: input.requestId,
              actorUserId: input.actorUserId,
              from: 'queued',
              to: 'resolving',
              operationId: operation.id ?? input.executionStateId,
            });
            status = 'resolving';
          }
          if (executionState === 'playing') {
            if (status === 'resolving') {
              await transitionRequestStatus(client, {
                workspaceId: input.workspaceId,
                requestId: input.requestId,
                actorUserId: input.actorUserId,
                from: 'resolving',
                to: 'ready',
                operationId: operation.id ?? input.executionStateId,
              });
              status = 'ready';
            }
            if (status === 'ready') {
              await transitionRequestStatus(client, {
                workspaceId: input.workspaceId,
                requestId: input.requestId,
                actorUserId: input.actorUserId,
                from: 'ready',
                to: 'playing',
                operationId: operation.id ?? input.executionStateId,
              });
            }
          } else if (status === 'resolving' || status === 'ready') {
            await transitionRequestStatus(client, {
              workspaceId: input.workspaceId,
              requestId: input.requestId,
              actorUserId: input.actorUserId,
              from: status,
              to: 'failed',
              operationId: operation.id ?? input.executionStateId,
            });
          }
        }

        if (executionState === 'playing' && operation.id) {
          await client.query(
            `INSERT INTO playback_sessions (
               workspace_id, request_id, provider_instance_id, execution_state_id,
               dispatch_generation, playback_operation_id, actor_user_id, output_id,
               player_id, provider_playback_id, expected_duration_ms, status
             )
             SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'playing'
              FROM media_requests r
             WHERE r.workspace_id = $1 AND r.id = $2 AND r.status = 'playing'
             ON CONFLICT (workspace_id, playback_operation_id) DO NOTHING`,
            [
              input.workspaceId,
              input.requestId,
              input.providerInstanceId,
              input.executionStateId,
              input.dispatchGeneration,
              operation.id,
              input.actorUserId,
              execution.output_id,
              execution.player_id,
              operation.providerPlaybackId ?? null,
              execution.duration_ms,
            ],
          );
        }
      },
    );
    if (executionState === 'playing' || executionState === 'failed') {
      await this.queueManager.dispatchNext({
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
      });
    }
    return { accepted: true, operationId: operation.id ?? null, status: operation.status };
  }
}
