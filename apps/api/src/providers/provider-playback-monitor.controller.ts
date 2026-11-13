import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { VerifiedWorkspaceId } from '@platform/contracts';
import { DatabaseService } from '../database/database.service.js';
import { PlaybackCoordinatorService } from '../playback/playback-coordinator.service.js';
import { QueueManagerService } from '../queues/queue-manager.service.js';
import { verifyProviderExecutionHandoffSignature } from './provider-execution-handoff.controller.js';

type PlaybackMonitorPayload = {
  executionStateId: string;
  workspaceId: string;
  requestId: string;
  providerInstanceId: string;
  dispatchGeneration: number;
  actorUserId: string;
};

type ActivePlaybackRow = {
  output_id: string;
  player_id: string;
  provider_playback_id: string | null;
};

type MonitorResult =
  | { accepted: true; status: 'stale' | 'session_identity_unavailable' | 'output_busy' | 'session_changed' | 'playing' | 'stopped_before_end' }
  | { accepted: true; status: 'completed' };

@Controller('internal/provider-executions')
export class ProviderPlaybackMonitorController {
  constructor(
    private readonly database: DatabaseService,
    private readonly coordinator: PlaybackCoordinatorService,
    private readonly queueManager: QueueManagerService,
  ) {}

  @Post('monitor')
  @HttpCode(200)
  async monitor(
    @Body() rawPayload: unknown,
    @Headers('x-provider-execution-timestamp') timestamp: string,
    @Headers('x-provider-execution-signature') signature: string,
  ): Promise<MonitorResult> {
    const payload = parsePayload(rawPayload);
    const secret = process.env.PROVIDER_EXECUTION_HANDOFF_SECRET;
    if (!secret) throw new ServiceUnavailableException('Provider execution authentication is not configured.');
    if (!verifyProviderExecutionHandoffSignature({ secret, timestamp, signature, body: rawPayload })) {
      throw new UnauthorizedException('Provider playback monitor signature is invalid or expired.');
    }

    const execution = await this.database.transaction(
      {
        userId: payload.actorUserId,
        verifiedWorkspaceId: payload.workspaceId as VerifiedWorkspaceId,
      },
      async (client) => {
        const result = await client.query<ActivePlaybackRow>(
          `SELECT assignment.output_id, assignment.player_id, play_operation.provider_playback_id
             FROM provider_execution_states execution
             JOIN media_requests request
               ON request.workspace_id = execution.workspace_id AND request.id = execution.request_id
             JOIN workspaces workspace ON workspace.id = execution.workspace_id
             JOIN provider_instances provider
               ON provider.workspace_id = execution.workspace_id AND provider.id = execution.provider_instance_id
             JOIN provider_output_assignments assignment
               ON assignment.workspace_id = execution.workspace_id
              AND assignment.provider_instance_id = execution.provider_instance_id
              AND assignment.active = true
             LEFT JOIN playback_operations play_operation
               ON play_operation.workspace_id = execution.workspace_id
              AND play_operation.request_id = execution.request_id
              AND play_operation.provider_instance_id = execution.provider_instance_id
              AND play_operation.output_id = assignment.output_id
              AND play_operation.player_id = assignment.player_id
              AND play_operation.idempotency_key =
                'provider-execution:' || execution.id::text || ':' || execution.dispatch_generation::text
              AND play_operation.command = 'play'
              AND play_operation.status IN ('completed', 'reconciled')
            WHERE execution.id = $1
              AND execution.workspace_id = $2
              AND execution.request_id = $3
              AND execution.provider_instance_id = $4
              AND execution.dispatch_generation = $5
              AND execution.state = 'playing'
              AND request.status = 'playing'
              AND workspace.status = 'active'
              AND provider.provider_id = 'lyrion'
              AND provider.enabled = true
              AND provider.connection_health = 'healthy'
                        AND (CASE WHEN request.source = 'twitch_reward'
                        THEN workspace.owner_user_id
                        ELSE request.submitted_by_user_id END) = $6
              AND NOT EXISTS (
                SELECT 1 FROM playback_operations active_operation
                 WHERE active_operation.workspace_id = execution.workspace_id
                   AND active_operation.output_id = assignment.output_id
                   AND active_operation.status IN ('pending', 'executing', 'uncertain')
              )
            LIMIT 1`,
          [
            payload.executionStateId,
            payload.workspaceId,
            payload.requestId,
            payload.providerInstanceId,
            payload.dispatchGeneration,
            payload.actorUserId,
          ],
        );
        return result.rows[0] ?? null;
      },
    );
    if (!execution) return { accepted: true, status: 'stale' };
    if (!execution.provider_playback_id) {
      return { accepted: true, status: 'session_identity_unavailable' };
    }

    const observation = await this.coordinator.withPlaybackState(
      {
        workspaceId: payload.workspaceId,
        providerInstanceId: payload.providerInstanceId,
        playerId: execution.player_id,
        outputId: execution.output_id,
        requestId: payload.requestId,
        command: 'play',
        idempotencyKey: `playback-monitor:${payload.executionStateId}:${payload.dispatchGeneration}`,
        actorId: payload.actorUserId,
      },
      async (state): Promise<MonitorResult> => {
        if (!state) return { accepted: true, status: 'output_busy' };
        if (state.providerPlaybackId !== execution.provider_playback_id) {
          return { accepted: true, status: 'session_changed' };
        }
        if (state.status !== 'stopped') return { accepted: true, status: 'playing' };
        if (
          state.progressMs === undefined ||
          state.durationMs === undefined ||
          state.durationMs <= 0 ||
          state.progressMs < Math.max(state.durationMs - 1500, state.durationMs * 0.95)
        ) {
          return { accepted: true, status: 'stopped_before_end' };
        }
        const completed = await this.completeRequest(payload);
        return { accepted: true, status: completed ? 'completed' : 'stale' };
      },
    );
    if (!observation) return { accepted: true, status: 'output_busy' };
    if (observation.status === 'completed') {
      await this.queueManager.dispatchNext({
        workspaceId: payload.workspaceId,
        actorId: payload.actorUserId,
      });
    }
    return observation;
  }

  private async completeRequest(payload: PlaybackMonitorPayload): Promise<boolean> {
    return this.database.transaction(
      {
        userId: payload.actorUserId,
        verifiedWorkspaceId: payload.workspaceId as VerifiedWorkspaceId,
      },
      async (client) => {
        const locked = await client.query(
          `SELECT execution.id
             FROM provider_execution_states execution
             JOIN media_requests request
               ON request.workspace_id = execution.workspace_id AND request.id = execution.request_id
            WHERE execution.id = $1
              AND execution.workspace_id = $2
              AND execution.request_id = $3
              AND execution.provider_instance_id = $4
              AND execution.dispatch_generation = $5
              AND execution.state = 'playing'
              AND request.status = 'playing'
            FOR UPDATE OF execution, request`,
          [
            payload.executionStateId,
            payload.workspaceId,
            payload.requestId,
            payload.providerInstanceId,
            payload.dispatchGeneration,
          ],
        );
        if (locked.rowCount !== 1) return false;

        const execution = await client.query(
          `UPDATE provider_execution_states
              SET state = 'completed', updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND request_id = $3
              AND provider_instance_id = $4 AND dispatch_generation = $5
              AND state = 'playing'`,
          [
            payload.executionStateId,
            payload.workspaceId,
            payload.requestId,
            payload.providerInstanceId,
            payload.dispatchGeneration,
          ],
        );
        if (execution.rowCount !== 1) {
          throw new Error('Provider execution changed before playback completion was recorded.');
        }

        const request = await client.query(
          `UPDATE media_requests SET status = 'completed', updated_at = now()
            WHERE workspace_id = $1 AND id = $2 AND status = 'playing'`,
          [payload.workspaceId, payload.requestId],
        );
        if (request.rowCount !== 1) {
          throw new Error('Request lifecycle changed before playback completion was recorded.');
        }

        await client.query(
          `INSERT INTO request_state_history
            (workspace_id, request_id, from_status, to_status, actor_user_id, actor_type)
           VALUES ($1, $2, 'playing', 'completed', $3, 'system')`,
          [payload.workspaceId, payload.requestId, payload.actorUserId],
        );
        await client.query(
          'DELETE FROM logical_queue_entries WHERE workspace_id = $1 AND request_id = $2',
          [payload.workspaceId, payload.requestId],
        );
        await client.query(
          `INSERT INTO outbox_events
            (workspace_id, event_type, aggregate_type, aggregate_id, idempotency_key, payload)
           VALUES ($1, 'request.status.changed', 'media_request', $2, $3, $4::jsonb)
           ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
          [
            payload.workspaceId,
            payload.requestId,
            `request.status:${payload.requestId}:playing:completed:${payload.executionStateId}:${payload.dispatchGeneration}`,
            JSON.stringify({ requestId: payload.requestId, from: 'playing', to: 'completed' }),
          ],
        );
        return true;
      },
    );
  }
}

function parsePayload(value: unknown): PlaybackMonitorPayload {
  if (!isRecord(value)) throw new UnauthorizedException('Provider playback monitor payload is invalid.');
  const executionStateId = requireUuid(value.executionStateId);
  const workspaceId = requireUuid(value.workspaceId);
  const requestId = requireUuid(value.requestId);
  const providerInstanceId = requireUuid(value.providerInstanceId);
  const actorUserId = requireUuid(value.actorUserId);
  if (
    typeof value.dispatchGeneration !== 'number' ||
    !Number.isSafeInteger(value.dispatchGeneration) ||
    value.dispatchGeneration < 1
  ) {
    throw new UnauthorizedException('Provider playback monitor payload is invalid.');
  }
  return {
    executionStateId,
    workspaceId,
    requestId,
    providerInstanceId,
    dispatchGeneration: value.dispatchGeneration,
    actorUserId,
  };
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new UnauthorizedException('Provider playback monitor payload is invalid.');
  }
  return value;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
