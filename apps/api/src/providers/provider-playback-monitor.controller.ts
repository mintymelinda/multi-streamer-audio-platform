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
  playbackSessionId: string;
  executionStateId: string;
  workspaceId: string;
  requestId: string;
  providerInstanceId: string;
  dispatchGeneration: number;
  actorUserId: string;
};

type PlaybackSessionRow = {
  id: string;
  status: 'playing' | 'paused' | 'completed';
  expected_duration_ms: string | number | null;
  queue_advance_pending: boolean;
  output_id: string;
  player_id: string;
};

type ProviderObservation = {
  status: 'playing' | 'paused' | 'stopped' | 'idle' | 'unavailable';
  positionMs?: number;
  durationMs?: number;
};

type MonitorResult =
  | { accepted: true; status: 'stale' | 'output_busy' | 'playing' | 'paused' | 'unavailable' | 'stopped_before_end' | 'queue_advanced' }
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
    if (!secret) {
      throw new ServiceUnavailableException('Provider execution authentication is not configured.');
    }
    if (!verifyProviderExecutionHandoffSignature({ secret, timestamp, signature, body: rawPayload })) {
      throw new UnauthorizedException('Provider playback monitor signature is invalid or expired.');
    }

    const session = await this.loadSession(payload);
    if (!session) return { accepted: true, status: 'stale' };

    if (session.status === 'completed' && session.queue_advance_pending) {
      await this.advanceQueue(payload);
      return { accepted: true, status: 'queue_advanced' };
    }
    if (session.status !== 'playing' && session.status !== 'paused') {
      return { accepted: true, status: 'stale' };
    }

    let rawObservation;
    try {
      rawObservation = await this.coordinator.observePlaybackState({
        workspaceId: payload.workspaceId,
        providerInstanceId: payload.providerInstanceId,
        playerId: session.player_id,
        outputId: session.output_id,
        requestId: payload.requestId,
        command: 'play',
        idempotencyKey: `playback-monitor:${payload.playbackSessionId}:${payload.dispatchGeneration}`,
        actorId: payload.actorUserId,
      });
    } catch {
      await this.persistObservation(payload, { status: 'unavailable' }, session.status);
      return { accepted: true, status: 'unavailable' };
    }
    if (!rawObservation) return { accepted: true, status: 'output_busy' };

    const observation = normalizeObservation(rawObservation);
    if (observation.status === 'stopped' && isNaturalCompletion(session, observation)) {
      const completed = await this.completeRequest(payload, observation);
      if (!completed) return { accepted: true, status: 'stale' };
      await this.advanceQueue(payload);
      return { accepted: true, status: 'completed' };
    }

    if (observation.status === 'stopped' || observation.status === 'idle') {
      await this.persistObservation(payload, observation, 'uncertain');
      return { accepted: true, status: 'stopped_before_end' };
    }
    if (observation.status === 'playing') {
      await this.persistObservation(payload, observation, 'playing');
      return { accepted: true, status: 'playing' };
    }
    if (observation.status === 'paused') {
      await this.persistObservation(payload, observation, 'paused');
      return { accepted: true, status: 'paused' };
    }
    await this.persistObservation(payload, observation, session.status);
    return { accepted: true, status: 'unavailable' };
  }

  private async loadSession(payload: PlaybackMonitorPayload): Promise<PlaybackSessionRow | null> {
    return this.database.transaction(
      { userId: payload.actorUserId, verifiedWorkspaceId: payload.workspaceId as VerifiedWorkspaceId },
      async (client) => {
        const result = await client.query<PlaybackSessionRow>(
          `SELECT session.id, session.status, session.expected_duration_ms::text,
                  session.queue_advance_dispatched_at IS NULL AS queue_advance_pending,
                  session.output_id, session.player_id
             FROM public.playback_sessions session
             JOIN public.provider_execution_states execution
               ON execution.workspace_id = session.workspace_id
              AND execution.id = session.execution_state_id
              AND execution.request_id = session.request_id
              AND execution.provider_instance_id = session.provider_instance_id
              AND execution.dispatch_generation = session.dispatch_generation
             JOIN public.media_requests request
               ON request.workspace_id = session.workspace_id AND request.id = session.request_id
             JOIN public.workspaces workspace ON workspace.id = session.workspace_id
             JOIN public.workspace_memberships membership
               ON membership.workspace_id = workspace.id
              AND membership.user_id = workspace.owner_user_id
              AND membership.status = 'active'
             JOIN public.platform_users account
               ON account.id = workspace.owner_user_id AND account.status = 'active'
             JOIN public.provider_instances provider
               ON provider.workspace_id = session.workspace_id AND provider.id = session.provider_instance_id
             JOIN public.playback_operations operation
               ON operation.workspace_id = session.workspace_id
              AND operation.id = session.playback_operation_id
              AND operation.command = 'play'
              AND operation.status IN ('completed', 'reconciled')
            WHERE session.id = $1
              AND session.workspace_id = $2
              AND session.request_id = $3
              AND session.execution_state_id = $4
              AND session.provider_instance_id = $5
              AND session.dispatch_generation = $6
              AND workspace.owner_user_id = $7
              AND workspace.status = 'active'
              AND (
                (session.status = 'completed' AND session.queue_advance_dispatched_at IS NULL
                 AND request.status = 'completed' AND execution.state = 'completed')
                OR (
                  session.status IN ('playing', 'paused')
                  AND execution.state = 'playing'
                  AND request.status = 'playing'
                  AND provider.provider_id = 'lyrion'
                  AND provider.enabled = true
                  AND provider.connection_health = 'healthy'
                  AND EXISTS (
                    SELECT 1 FROM public.provider_output_assignments assignment
                     WHERE assignment.workspace_id = session.workspace_id
                       AND assignment.provider_instance_id = session.provider_instance_id
                       AND assignment.output_id = session.output_id
                       AND assignment.player_id = session.player_id
                       AND assignment.active = true
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM public.playback_operations active_operation
                     WHERE active_operation.workspace_id = session.workspace_id
                       AND active_operation.output_id = session.output_id
                       AND active_operation.status IN ('pending', 'executing', 'uncertain')
                  )
                )
              )
            LIMIT 1`,
          [
            payload.playbackSessionId,
            payload.workspaceId,
            payload.requestId,
            payload.executionStateId,
            payload.providerInstanceId,
            payload.dispatchGeneration,
            payload.actorUserId,
          ],
        );
        return result.rows[0] ?? null;
      },
    );
  }

  private async persistObservation(
    payload: PlaybackMonitorPayload,
    observation: ProviderObservation,
    sessionStatus: 'playing' | 'paused' | 'uncertain',
  ): Promise<void> {
    await this.database.transaction(
      { userId: payload.actorUserId, verifiedWorkspaceId: payload.workspaceId as VerifiedWorkspaceId },
      (client) => client.query(
        `UPDATE public.playback_sessions
            SET observed_position_ms = $1,
                observed_duration_ms = $2,
                observed_status = $3,
                observed_at = now(),
                status = $4,
                updated_at = now()
          WHERE id = $5
            AND workspace_id = $6
            AND request_id = $7
            AND execution_state_id = $8
            AND provider_instance_id = $9
            AND dispatch_generation = $10
            AND status IN ('playing', 'paused')`,
        [
          observation.positionMs ?? null,
          observation.durationMs ?? null,
          observation.status,
          sessionStatus,
          payload.playbackSessionId,
          payload.workspaceId,
          payload.requestId,
          payload.executionStateId,
          payload.providerInstanceId,
          payload.dispatchGeneration,
        ],
      ),
    );
  }

  private async completeRequest(
    payload: PlaybackMonitorPayload,
    observation: ProviderObservation,
  ): Promise<boolean> {
    return this.database.transaction(
      { userId: payload.actorUserId, verifiedWorkspaceId: payload.workspaceId as VerifiedWorkspaceId },
      async (client) => {
        const locked = await client.query(
          `SELECT session.id
             FROM public.playback_sessions session
             JOIN public.provider_execution_states execution
               ON execution.workspace_id = session.workspace_id AND execution.id = session.execution_state_id
             JOIN public.media_requests request
               ON request.workspace_id = session.workspace_id AND request.id = session.request_id
            WHERE session.id = $1
              AND session.workspace_id = $2
              AND session.request_id = $3
              AND session.execution_state_id = $4
              AND session.provider_instance_id = $5
              AND session.dispatch_generation = $6
              AND session.status = 'playing'
              AND execution.state = 'playing'
              AND execution.dispatch_generation = $6
              AND request.status = 'playing'
              AND NOT EXISTS (
                SELECT 1 FROM public.playback_operations active_operation
                 WHERE active_operation.workspace_id = session.workspace_id
                   AND active_operation.output_id = session.output_id
                   AND active_operation.status IN ('pending', 'executing', 'uncertain')
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.playback_sessions newer
                 WHERE newer.workspace_id = session.workspace_id
                   AND newer.output_id = session.output_id
                   AND newer.started_at > session.started_at
                   AND newer.status IN ('playing', 'paused')
              )
            FOR UPDATE OF session, execution, request`,
          [
            payload.playbackSessionId,
            payload.workspaceId,
            payload.requestId,
            payload.executionStateId,
            payload.providerInstanceId,
            payload.dispatchGeneration,
          ],
        );
        if (locked.rowCount !== 1) return false;

        const session = await client.query(
          `UPDATE public.playback_sessions
              SET status = 'completed',
                  observed_position_ms = $1,
                  observed_duration_ms = $2,
                  observed_status = 'stopped',
                  observed_at = now(),
                  ended_at = now(),
                  queue_advance_dispatched_at = NULL,
                  updated_at = now()
            WHERE id = $3 AND workspace_id = $4
              AND request_id = $5 AND execution_state_id = $6
              AND provider_instance_id = $7 AND dispatch_generation = $8
              AND status = 'playing'`,
          [
            observation.positionMs,
            observation.durationMs,
            payload.playbackSessionId,
            payload.workspaceId,
            payload.requestId,
            payload.executionStateId,
            payload.providerInstanceId,
            payload.dispatchGeneration,
          ],
        );
        if (session.rowCount !== 1) throw new Error('Playback session changed before completion was persisted.');

        const execution = await client.query(
          `UPDATE public.provider_execution_states
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
        if (execution.rowCount !== 1) throw new Error('Provider execution changed before completion was persisted.');

        const request = await client.query(
          `UPDATE public.media_requests
              SET status = 'completed', updated_at = now()
            WHERE workspace_id = $1 AND id = $2 AND status = 'playing'`,
          [payload.workspaceId, payload.requestId],
        );
        if (request.rowCount !== 1) throw new Error('Request lifecycle changed before completion was persisted.');

        await client.query(
          `INSERT INTO public.request_state_history
            (workspace_id, request_id, from_status, to_status, actor_user_id, actor_type)
           VALUES ($1, $2, 'playing', 'completed', $3, 'system')`,
          [payload.workspaceId, payload.requestId, payload.actorUserId],
        );
        await client.query(
          'DELETE FROM public.logical_queue_entries WHERE workspace_id = $1 AND request_id = $2',
          [payload.workspaceId, payload.requestId],
        );
        await client.query(
          `INSERT INTO public.outbox_events
            (workspace_id, event_type, aggregate_type, aggregate_id, idempotency_key, payload)
           VALUES ($1, 'request.status.changed', 'media_request', $2, $3, $4::jsonb)
           ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
          [
            payload.workspaceId,
            payload.requestId,
            `request.status:${payload.requestId}:playing:completed:${payload.playbackSessionId}:${payload.dispatchGeneration}`,
            JSON.stringify({ requestId: payload.requestId, from: 'playing', to: 'completed' }),
          ],
        );
        return true;
      },
    );
  }

  private async advanceQueue(payload: PlaybackMonitorPayload): Promise<void> {
    await this.queueManager.dispatchNext({
      workspaceId: payload.workspaceId,
      actorId: payload.actorUserId,
    });
    await this.database.transaction(
      { userId: payload.actorUserId, verifiedWorkspaceId: payload.workspaceId as VerifiedWorkspaceId },
      (client) => client.query(
        `UPDATE public.playback_sessions
            SET queue_advance_dispatched_at = COALESCE(queue_advance_dispatched_at, now()),
                updated_at = now()
          WHERE id = $1
            AND workspace_id = $2
            AND request_id = $3
            AND dispatch_generation = $4
            AND status = 'completed'`,
        [payload.playbackSessionId, payload.workspaceId, payload.requestId, payload.dispatchGeneration],
      ),
    );
  }
}

function normalizeObservation(value: {
  status: string;
  positionMs?: number;
  durationMs?: number;
}): ProviderObservation {
  const status = ['playing', 'paused', 'stopped', 'idle'].includes(value.status)
    ? value.status as ProviderObservation['status']
    : 'unavailable';
  const positionMs = Number.isSafeInteger(value.positionMs) && Number(value.positionMs) >= 0
    ? Number(value.positionMs)
    : undefined;
  const durationMs = Number.isSafeInteger(value.durationMs) && Number(value.durationMs) >= 0
    ? Number(value.durationMs)
    : undefined;
  return {
    status,
    ...(positionMs !== undefined ? { positionMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function isNaturalCompletion(session: PlaybackSessionRow, observation: ProviderObservation): boolean {
  if (
    session.status !== 'playing' ||
    observation.status !== 'stopped' ||
    observation.positionMs === undefined ||
    observation.durationMs === undefined ||
    observation.durationMs <= 0
  ) return false;

  const expectedDuration = session.expected_duration_ms === null
    ? null
    : Number(session.expected_duration_ms);
  if (expectedDuration !== null && Number.isFinite(expectedDuration) && expectedDuration > 0) {
    const tolerance = Math.max(10_000, expectedDuration * 0.1);
    if (Math.abs(observation.durationMs - expectedDuration) > tolerance) return false;
  }
  return observation.positionMs >= Math.max(observation.durationMs - 1_500, observation.durationMs * 0.95);
}

function parsePayload(value: unknown): PlaybackMonitorPayload {
  if (!isRecord(value)) throw new UnauthorizedException('Provider playback monitor payload is invalid.');
  const result = {
    playbackSessionId: requireUuid(value.playbackSessionId),
    executionStateId: requireUuid(value.executionStateId),
    workspaceId: requireUuid(value.workspaceId),
    requestId: requireUuid(value.requestId),
    providerInstanceId: requireUuid(value.providerInstanceId),
    dispatchGeneration: Number(value.dispatchGeneration),
    actorUserId: requireUuid(value.actorUserId),
  };
  if (!Number.isSafeInteger(result.dispatchGeneration) || result.dispatchGeneration < 1) {
    throw new UnauthorizedException('Provider playback monitor payload is invalid.');
  }
  return result;
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
