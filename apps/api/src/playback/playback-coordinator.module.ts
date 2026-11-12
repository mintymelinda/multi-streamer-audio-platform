import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { ProviderOutputAssignmentModule } from '../providers/provider-output-assignment.module.js';
import { ProviderOutputAssignmentService } from '../providers/provider-output-assignment.service.js';
import { PlaybackAdapterRegistry } from '../providers/playback-adapter.registry.js';
import {
  PlaybackCoordinatorService,
  type PlaybackOperation,
} from './playback-coordinator.service.js';

type LeaseContext = {
  workspaceId: string;
  providerInstanceId: string;
  playerId: string;
  actorId?: string;
  ownerId: string;
  expiresAt: Date;
};

type OperationRow = {
  id: string;
  workspace_id: string;
  provider_instance_id: string;
  player_id: string;
  output_id: string | null;
  request_id: string;
  requested_by: string;
  command: PlaybackOperation['command'];
  idempotency_key: string;
  status: PlaybackOperation['status'];
  result: Record<string, unknown> | null;
  error_code: string | null;
  provider_playback_id: string | null;
  fencing_token: number;
  created_at: Date;
  updated_at: Date;
};

function decodeLeaseKey(
  key: string,
): Pick<LeaseContext, 'workspaceId' | 'providerInstanceId' | 'playerId'> {
  const value: unknown = JSON.parse(key);
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((part) => typeof part !== 'string' || !part)
  ) {
    throw new TypeError('Playback lease key is invalid.');
  }
  return {
    workspaceId: value[0],
    providerInstanceId: value[1],
    playerId: value[2],
  };
}

function mapOperation(row: OperationRow): PlaybackOperation {
  return {
    id: row.id,
    actorId: row.requested_by,
    workspaceId: row.workspace_id,
    providerInstanceId: row.provider_instance_id,
    playerId: row.player_id,
    ...(row.output_id ? { outputId: row.output_id } : {}),
    requestId: row.request_id,
    command: row.command,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    result: row.result,
    errorCode: row.error_code,
    providerPlaybackId: row.provider_playback_id,
    fencingToken: row.fencing_token,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

@Module({
  imports: [DatabaseModule, ProviderOutputAssignmentModule],
  providers: [
    PlaybackAdapterRegistry,
    {
      provide: PlaybackCoordinatorService,
      inject: [DatabaseService, ProviderOutputAssignmentService, PlaybackAdapterRegistry],
      useFactory: (
        database: DatabaseService,
        outputAssignments: ProviderOutputAssignmentService,
        adapters: PlaybackAdapterRegistry,
      ) => {
        return new PlaybackCoordinatorService({
          assertOutputAssignment: async (input) => {
            if (!input.actorId || !input.outputId) {
              throw new Error('Authenticated user and explicit output assignment are required.');
            }
            const assignment = await outputAssignments.requireAssignment({
              workspaceId: input.workspaceId,
              providerInstanceId: input.providerInstanceId,
              playerId: input.playerId,
              actorId: input.actorId,
            });
            if (assignment.outputId !== input.outputId) {
              throw new Error('Playback output does not match the provider output assignment.');
            }
          },
          acquireLease: async (keyOrInput, context) => {
            const input =
              typeof keyOrInput === 'string'
                ? { ...decodeLeaseKey(keyOrInput), ...(context as LeaseContext) }
                : keyOrInput;
            if (!input.actorId) {
              throw new Error('An authenticated workspace user is required for playback.');
            }
            const result = await database.transaction(
              {
                userId: input.actorId,
                verifiedWorkspaceId: input.workspaceId as never,
              },
              (client) =>
                client.query<{ lease_owner_id: string; fencing_token: number }>(
                  `INSERT INTO playback_leases (
                     workspace_id, provider_instance_id, player_id, lease_owner_id,
                     lease_token, fencing_token, expires_at
                   )
                   VALUES ($1, $2, $3, $4, gen_random_uuid(), 1, $5)
                   ON CONFLICT (workspace_id, provider_instance_id, player_id)
                   DO UPDATE SET
                     lease_owner_id = EXCLUDED.lease_owner_id,
                     lease_token = gen_random_uuid(),
                     fencing_token = playback_leases.fencing_token + 1,
                     expires_at = EXCLUDED.expires_at,
                     updated_at = now()
                   WHERE playback_leases.expires_at <= now()
                   RETURNING lease_owner_id, fencing_token`,
                  [
                    input.workspaceId,
                    input.providerInstanceId,
                    input.playerId,
                    input.ownerId,
                    input.expiresAt,
                  ],
                ),
            );
            return {
              acquired: result.rowCount === 1,
              ownerId: input.ownerId,
              ...(result.rows[0] ? { fencingToken: result.rows[0].fencing_token } : {}),
            };
          },
          releaseLease: async (key, context) => {
            const identity = decodeLeaseKey(key);
            const input = { ...identity, ...(context as LeaseContext) };
            if (!input.actorId) {
              throw new Error('An authenticated workspace user is required for playback.');
            }
            await database.transaction(
              {
                userId: input.actorId,
                verifiedWorkspaceId: input.workspaceId as never,
              },
              (client) =>
                client.query(
                  `UPDATE playback_leases SET expires_at = now(), updated_at = now()
                    WHERE workspace_id = $1 AND provider_instance_id = $2
                      AND player_id = $3 AND lease_owner_id = $4`,
                  [input.workspaceId, input.providerInstanceId, input.playerId, input.ownerId],
                ),
            );
          },
          findUnresolvedOperation: async ({ workspaceId, outputId, actorId }) => {
            if (!actorId) {
              throw new Error(
                'Workspace and authenticated user are required for playback recovery.',
              );
            }
            const result = await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              (client) =>
                client.query<OperationRow>(
                  `SELECT id, workspace_id, provider_instance_id, player_id, output_id,
                          request_id, requested_by, command, idempotency_key, status, result,
                          error_code, provider_playback_id, fencing_token, created_at, updated_at
                     FROM playback_operations
                    WHERE workspace_id = $1 AND output_id = $2
                      AND status IN ('pending', 'executing', 'uncertain')
                    ORDER BY created_at ASC
                    LIMIT 1`,
                  [workspaceId, outputId],
                ),
            );
            return result.rows[0] ? mapOperation(result.rows[0]) : null;
          },
          findOperationByIdempotencyKey: async (key, workspaceId, actorId) => {
            if (!workspaceId || !actorId) {
              throw new Error('Workspace and authenticated user are required for playback lookup.');
            }
            const result = await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              (client) =>
                client.query<OperationRow>(
                  `SELECT id, workspace_id, provider_instance_id, player_id, output_id,
                          request_id, requested_by, command, idempotency_key, status, result, error_code,
                          provider_playback_id, fencing_token, created_at, updated_at
                     FROM playback_operations
                    WHERE workspace_id = $1 AND idempotency_key = $2`,
                  [workspaceId, key],
                ),
            );
            return result.rows[0] ? mapOperation(result.rows[0]) : null;
          },
          persistOperation: async (operation) => {
            if (!operation.actorId) {
              throw new Error('An authenticated workspace user is required for playback.');
            }
            return database.transaction(
              {
                userId: operation.actorId,
                verifiedWorkspaceId: operation.workspaceId as never,
              },
              async (client) => {
                const result = await client.query<OperationRow>(
                  `INSERT INTO playback_operations (
                     workspace_id, provider_instance_id, player_id, output_id, request_id,
                     requested_by, command, idempotency_key, status, result, error_code,
                     provider_playback_id, fencing_token
                   )
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
                   ON CONFLICT (workspace_id, idempotency_key)
                   DO UPDATE SET
                     status = EXCLUDED.status,
                     result = EXCLUDED.result,
                     error_code = EXCLUDED.error_code,
                     provider_playback_id = EXCLUDED.provider_playback_id,
                     fencing_token = EXCLUDED.fencing_token,
                     updated_at = now()
                   WHERE playback_operations.fencing_token <= EXCLUDED.fencing_token
                   RETURNING id, workspace_id, provider_instance_id, player_id, output_id,
                             request_id, requested_by, command, idempotency_key, status, result,
                             error_code, provider_playback_id, fencing_token, created_at, updated_at`,
                  [
                    operation.workspaceId,
                    operation.providerInstanceId,
                    operation.playerId,
                    operation.outputId ?? null,
                    operation.requestId,
                    operation.actorId,
                    operation.command,
                    operation.idempotencyKey,
                    operation.status,
                    JSON.stringify(operation.result ?? null),
                    operation.errorCode ?? null,
                    operation.providerPlaybackId ?? null,
                    operation.fencingToken ?? 0,
                  ],
                );
                const row = result.rows[0];
                if (!row) throw new Error('Playback operation could not be persisted.');
                if (
                  row.status === 'completed' ||
                  row.status === 'reconciled' ||
                  row.status === 'uncertain' ||
                  row.status === 'failed'
                ) {
                  const eventType =
                    row.status === 'uncertain'
                      ? 'playback.command.uncertain'
                      : row.status === 'failed'
                        ? 'playback.command.failed'
                        : 'playback.command.completed';
                  await client.query(
                    `INSERT INTO outbox_events (
                       workspace_id, event_type, aggregate_type, aggregate_id, idempotency_key, payload
                     )
                     VALUES ($1, $2, 'playback_operation', $3, $4, $5::jsonb)
                     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
                    [
                      row.workspace_id,
                      eventType,
                      row.id,
                      `playback-operation:${row.id}:${row.status}`,
                      JSON.stringify({
                        requestId: row.request_id,
                        providerInstanceId: row.provider_instance_id,
                        playerId: row.player_id,
                        command: row.command,
                        status: row.status,
                      }),
                    ],
                  );
                }
                return mapOperation(row);
              },
            );
          },
          getWorkspacePlaybackPolicy: async (workspaceId, actorId) => {
            if (!actorId) {
              throw new Error('An authenticated workspace user is required for playback policy.');
            }
            const result = await database.transaction(
              {
                userId: actorId,
                verifiedWorkspaceId: workspaceId as never,
              },
              (client) =>
                client.query<{ enabled: boolean; reason: string | null }>(
                  'SELECT enabled, reason FROM workspace_playback_policies WHERE workspace_id = $1',
                  [workspaceId],
                ),
            );
            const policy = result.rows[0];
            return policy
              ? { enabled: policy.enabled, ...(policy.reason ? { reason: policy.reason } : {}) }
              : { enabled: true };
          },
          getProviderAdapter: async (providerInstanceId, context) => {
            if (!context?.actorId) {
              throw new Error('An authenticated workspace user is required to select a playback adapter.');
            }
            const result = await database.transaction(
              {
                userId: context.actorId,
                verifiedWorkspaceId: context.workspaceId as never,
              },
              (client) =>
                client.query<{
                  provider_id: string;
                  capabilities: Record<string, unknown>;
                  enabled: boolean;
                  connection_health: string;
                }>(
                  `SELECT provider_id, capabilities, enabled, connection_health
                     FROM provider_instances
                    WHERE workspace_id = $1 AND id = $2`,
                  [context.workspaceId, providerInstanceId],
                ),
            );
            const provider = result.rows[0];
            if (!provider || !provider.enabled || provider.connection_health !== 'healthy') {
              throw new Error('The assigned playback provider is unavailable or disabled.');
            }
            if (provider.capabilities.playback !== true) {
              throw new Error('The assigned provider does not declare playback capability.');
            }
            return adapters.resolve(provider.provider_id, context);
          },
        });
      },
    },
  ],
  exports: [PlaybackCoordinatorService, PlaybackAdapterRegistry],
})
export class PlaybackCoordinatorModule {}
