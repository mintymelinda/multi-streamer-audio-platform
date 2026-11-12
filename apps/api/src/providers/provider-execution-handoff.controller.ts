import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
  Body,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseService } from '../database/database.service.js';
import { PlaybackCoordinatorService } from '../playback/playback-coordinator.service.js';

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
  if (!/^\\d{10}$/.test(input.timestamp) || !/^[a-f0-9]{64}$/i.test(input.signature)) return false;
  const timestamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > maxClockSkewSeconds) return false;
  const expected = Buffer.from(signProviderExecutionHandoff(input.secret, input.timestamp, input.body), 'hex');
  const supplied = Buffer.from(input.signature, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
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
          `SELECT r.source, r.submitted_by_user_id, r.source_event_id,
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
              AND r.status = 'queued' AND p.enabled = true
              AND p.connection_health = 'healthy'
              AND COALESCE((SELECT policy.enabled FROM workspace_playback_policies policy
                             WHERE policy.workspace_id = r.workspace_id), true) = true
              AND NOT EXISTS (
                SELECT 1 FROM workspace_provider_path_restrictions restriction
                 WHERE restriction.workspace_id = r.workspace_id
                   AND restriction.provider_id = p.provider_id
                   AND restriction.disabled_at IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM rights_content_blocks block
                 WHERE block.workspace_id = r.workspace_id
                   AND block.content_id IN (r.media_id, p.provider_id || ':' || r.media_id)
              )
              AND EXISTS (
                SELECT 1 FROM logical_queue_entries q
                 WHERE q.workspace_id = r.workspace_id AND q.request_id = r.id
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
                AND (next_attempt_at IS NULL OR next_attempt_at <= now())`,
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
        sourceProviderId: execution.provider_id,
      },
    });
    const executionState = operation.status === 'failed'
      ? 'failed'
      : operation.status === 'completed' || operation.status === 'reconciled'
        ? 'playing'
        : 'resolving';
    await this.database.transaction(
      { userId: input.actorUserId, verifiedWorkspaceId: input.workspaceId as never },
      (client) => client.query(
        `UPDATE provider_execution_states
            SET state = $1, last_error_code = $2, updated_at = now()
          WHERE id = $3 AND workspace_id = $4 AND dispatch_generation = $5`,
        [
          executionState,
          operation.errorCode ?? null,
          input.executionStateId,
          input.workspaceId,
          input.dispatchGeneration,
        ],
      ),
    );
    return { accepted: true, operationId: operation.id ?? null, status: operation.status };
  }
}
