import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { redactProviderSecrets } from '../providers/provider-contracts.js';

export type PlaybackCommand = 'play' | 'pause' | 'resume' | 'skip' | 'seek';
export type PlaybackOperationStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'uncertain'
  | 'reconciled';

export interface PlaybackOperation {
  id?: string;
  actorId?: string;
  fencingToken?: number;
  workspaceId: string;
  providerInstanceId: string;
  playerId: string;
  outputId?: string;
  requestId: string;
  command: PlaybackCommand;
  idempotencyKey: string;
  status: PlaybackOperationStatus;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
  providerPlaybackId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybackLeaseInput {
  workspaceId: string;
  providerInstanceId: string;
  playerId: string;
  actorId?: string;
  ownerId: string;
  expiresAt: Date;
}

export interface PlaybackCoordinatorDependencies {
  acquireLease(
    keyOrInput: string | PlaybackLeaseInput,
    context?: Record<string, unknown>,
  ): Promise<boolean | { acquired: boolean; ownerId?: string; fencingToken?: number }>;
  releaseLease?(key: string, context?: Record<string, unknown>): Promise<unknown>;
  findUnresolvedOperation?(input: {
    workspaceId: string;
    outputId: string;
    actorId?: string;
  }): Promise<PlaybackOperation | null>;
  findOperationByIdempotencyKey(
    key: string,
    workspaceId?: string,
    actorId?: string,
  ): Promise<PlaybackOperation | null>;
  persistOperation(operation: PlaybackOperation): Promise<PlaybackOperation>;
  getProviderAdapter(
    providerInstanceId: string,
    context?: PlaybackCommandInput,
  ): Promise<PlaybackAdapter>;
  assertOutputAssignment?(input: PlaybackCommandInput): Promise<void>;
  getWorkspacePlaybackPolicy?(
    workspaceId: string,
    actorId?: string,
  ): Promise<{ enabled: boolean; reason?: string }>;
  appendOutboxEvent?(event: Record<string, unknown>): Promise<unknown>;
  now?: () => Date;
  leaseDurationMs?: number;
}

export interface PlaybackState {
  status: string;
  providerPlaybackId?: string;
  requestId?: string;
  positionMs?: number;
  durationMs?: number;
}

export interface PlaybackAdapter {
  play?(input: PlaybackCommandInput): Promise<ProviderCommandResult>;
  pause?(input: PlaybackCommandInput): Promise<ProviderCommandResult>;
  resume?(input: PlaybackCommandInput): Promise<ProviderCommandResult>;
  skip?(input: PlaybackCommandInput): Promise<ProviderCommandResult>;
  seek?(input: PlaybackCommandInput): Promise<ProviderCommandResult>;
  // requestId must identify the provider's current item; otherwise command reconciliation stays uncertain.
  getPlaybackState?(input: PlaybackCommandInput): Promise<PlaybackState | null>;
}

export interface PlaybackCommandInput {
  workspaceId: string;
  providerInstanceId: string;
  playerId: string;
  outputId?: string;
  requestId: string;
  command: PlaybackCommand;
  idempotencyKey: string;
  actorId?: string;
  fencingToken?: number;
  payload?: Record<string, unknown>;
}

/** Adapters return unknown for timeouts or transport errors that may have applied the command. */
export interface ProviderCommandResult {
  outcome: 'started' | 'paused' | 'resumed' | 'skipped' | 'completed' | 'unknown';
  providerPlaybackId?: string;
  [key: string]: unknown;
}

export class ProviderCommandRejectedError extends Error {
  constructor(
    message: string,
    readonly code = 'PROVIDER_COMMAND_REJECTED',
  ) {
    super(message);
    this.name = 'ProviderCommandRejectedError';
  }
}

export class PlaybackCoordinatorError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PlaybackCoordinatorError';
  }
}

@Injectable()
export class PlaybackCoordinatorService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;

  constructor(private readonly dependencies: PlaybackCoordinatorDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.leaseDurationMs = dependencies.leaseDurationMs ?? 30_000;
  }

  async execute(input: PlaybackCommandInput): Promise<PlaybackOperation> {
    const command = validateCommand(input);
    const lockKey = leaseKey(command);
    return this.withLocalLock(lockKey, () => this.executeLocked(command, lockKey));
  }

  async observePlaybackState(input: PlaybackCommandInput): Promise<PlaybackState | null> {
    return this.withPlaybackState(input, async (state) => state);
  }

  async withPlaybackState<T>(
    input: PlaybackCommandInput,
    action: (state: PlaybackState | null) => Promise<T>,
  ): Promise<T | null> {
    const command = validateCommand({ ...input, command: 'play' });
    const lockKey = leaseKey(command);
    return this.withLocalLock(lockKey, async () => {
      const ownerId = randomUUID();
      const expiresAt = new Date(this.now().getTime() + this.leaseDurationMs);
      const acquired = await this.dependencies.acquireLease(lockKey, {
        ...command,
        ownerId,
        expiresAt,
      });
      const lease = typeof acquired === 'boolean' ? { acquired } : acquired;
      if (!lease.acquired) return null;

      const observationInput = {
        ...command,
        ...(lease.fencingToken !== undefined ? { fencingToken: lease.fencingToken } : {}),
      };
      try {
        const adapter = await this.dependencies.getProviderAdapter(
          command.providerInstanceId,
          observationInput,
        );
        const state = (await adapter.getPlaybackState?.(observationInput)) ?? null;
        return await action(state);
      } finally {
        await this.dependencies.releaseLease?.(lockKey, {
          ...observationInput,
          ownerId,
        });
      }
    });
  }

  async acquirePlaybackLease(
    input: PlaybackLeaseInput,
  ): Promise<{ acquired: boolean; ownerId?: string; fencingToken?: number }> {
    const result = await this.dependencies.acquireLease(input);
    if (typeof result === 'boolean') return { acquired: result };
    return result;
  }

  private async executeLocked(
    input: PlaybackCommandInput,
    lockKey: string,
  ): Promise<PlaybackOperation> {
    const policy = await this.dependencies.getWorkspacePlaybackPolicy?.(
      input.workspaceId,
      input.actorId,
    );
    if (policy && !policy.enabled) {
      throw new PlaybackCoordinatorError(
        policy.reason || 'Playback is disabled by workspace policy.',
        'WORKSPACE_PLAYBACK_DISABLED',
      );
    }

    const existing = await this.dependencies.findOperationByIdempotencyKey(
      input.idempotencyKey,
      input.workspaceId,
      input.actorId,
    );
    if (existing) {
      if (existing.status === 'executing' || existing.status === 'uncertain') {
        return this.reconcileExisting(existing, input);
      }
      if (existing.status !== 'pending') return existing;
    }

    if (input.outputId && this.dependencies.findUnresolvedOperation) {
      const unresolved = await this.dependencies.findUnresolvedOperation({
        workspaceId: input.workspaceId,
        outputId: input.outputId,
        ...(input.actorId ? { actorId: input.actorId } : {}),
      });
      if (unresolved) {
        if (unresolved.status === 'pending') {
          await this.dependencies.persistOperation({
            ...unresolved,
            status: 'failed',
            errorCode: 'COMMAND_NOT_DISPATCHED',
            result: { outcome: 'not_dispatched' },
            updatedAt: this.now().toISOString(),
          });
        } else {
          const previousInput: PlaybackCommandInput = {
            workspaceId: unresolved.workspaceId,
            providerInstanceId: unresolved.providerInstanceId,
            playerId: unresolved.playerId,
            outputId: unresolved.outputId ?? input.outputId,
            requestId: unresolved.requestId,
            command: unresolved.command,
            idempotencyKey: unresolved.idempotencyKey,
            ...(input.actorId ? { actorId: input.actorId } : {}),
            ...(unresolved.fencingToken !== undefined
              ? { fencingToken: unresolved.fencingToken }
              : {}),
          };
          const reconciled = await this.reconcileExisting(unresolved, previousInput);
          if (reconciled.status === 'uncertain') {
            throw new PlaybackCoordinatorError(
              'An earlier command for this output has an uncertain outcome. Reconcile it before issuing another command.',
              'PLAYBACK_OUTCOME_UNCERTAIN',
            );
          }
        }
      }
    }

    await this.dependencies.assertOutputAssignment?.(input);

    const ownerId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + this.leaseDurationMs);
    const acquired = await this.dependencies.acquireLease(lockKey, {
      ...input,
      ownerId,
      expiresAt,
    });
    if (!(typeof acquired === 'boolean' ? acquired : acquired.acquired)) {
      throw new PlaybackCoordinatorError(
        'Another coordinator currently holds this playback output lease.',
        'PLAYBACK_LEASE_HELD',
      );
    }

    const operationInput = {
      ...input,
      ...(typeof acquired === 'object' && acquired.fencingToken !== undefined
        ? { fencingToken: acquired.fencingToken }
        : {}),
    };
    const timestamp = this.now().toISOString();
    const operation: PlaybackOperation = {
      ...operationInput,
      status: 'pending',
      result: null,
      errorCode: null,
      providerPlaybackId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      await this.dependencies.persistOperation(operation);
      const adapter = await this.dependencies.getProviderAdapter(input.providerInstanceId, input);
      operation.status = 'executing';
      operation.updatedAt = this.now().toISOString();
      await this.dependencies.persistOperation(operation);
      const executeCommand = adapter[input.command];
      if (!executeCommand) {
        throw new PlaybackCoordinatorError(
          `Provider does not support the ${input.command} command.`,
          'PROVIDER_COMMAND_UNSUPPORTED',
        );
      }

      let result: ProviderCommandResult;
      try {
        result = await executeCommand.call(adapter, operationInput);
      } catch (error) {
        if (error instanceof ProviderCommandRejectedError) {
          operation.status = 'failed';
          operation.errorCode = error.code;
          operation.result = { message: 'Provider command was rejected.' };
          operation.updatedAt = this.now().toISOString();
          await this.dependencies.persistOperation(operation);
          throw error;
        }

        let state: { status: string; providerPlaybackId?: string; requestId?: string } | undefined;
        try {
          state = await adapter.getPlaybackState?.(operationInput);
        } catch {
          state = undefined;
        }
        operation.status =
          state &&
          confirmsCommand(input.command, state.status) &&
          state.requestId === input.requestId
            ? 'reconciled'
            : 'uncertain';
        operation.providerPlaybackId =
          operation.status === 'reconciled' ? (state?.providerPlaybackId ?? null) : null;
        operation.result = {
          outcome: 'unknown',
          providerStatus: state?.status ?? 'unavailable',
        };
        operation.updatedAt = this.now().toISOString();
        return this.dependencies.persistOperation(operation);
      }

      if (result.outcome === 'unknown') {
        let state: { status: string; providerPlaybackId?: string; requestId?: string } | undefined;
        try {
          state = await adapter.getPlaybackState?.(operationInput);
        } catch {
          state = undefined;
        }
        if (
          state &&
          confirmsCommand(input.command, state.status) &&
          state.requestId === input.requestId
        ) {
          operation.status = 'reconciled';
          operation.providerPlaybackId = state.providerPlaybackId ?? null;
          operation.result = {
            outcome: 'reconciled',
            providerStatus: state.status,
          };
        } else {
          operation.status = 'uncertain';
          operation.result = {
            outcome: 'unknown',
            providerStatus: state?.status ?? 'unavailable',
          };
        }
      } else {
        operation.status = 'completed';
        operation.providerPlaybackId = result.providerPlaybackId ?? null;
        operation.result = redactProviderSecrets(result);
      }

      operation.updatedAt = this.now().toISOString();
      const persisted = await this.dependencies.persistOperation(operation);
      if (persisted.status === 'completed' || persisted.status === 'reconciled') {
        await this.dependencies.appendOutboxEvent?.({
          type: 'playback.command.completed',
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          providerInstanceId: input.providerInstanceId,
          playerId: input.playerId,
          command: input.command,
          operationId: persisted.id,
          status: persisted.status,
        });
      }
      return persisted;
    } finally {
      await this.dependencies.releaseLease?.(lockKey, {
        ...operationInput,
        ownerId,
      });
    }
  }

  private async reconcileExisting(
    existing: PlaybackOperation,
    input: PlaybackCommandInput,
  ): Promise<PlaybackOperation> {
    let state: { status: string; providerPlaybackId?: string; requestId?: string } | undefined;
    try {
      const adapter = await this.dependencies.getProviderAdapter(input.providerInstanceId, input);
      state = await adapter.getPlaybackState?.(input);
    } catch {
      state = undefined;
    }

    const reconciled = { ...existing, updatedAt: this.now().toISOString() };
    if (
      state &&
      confirmsCommand(input.command, state.status) &&
      state.requestId === input.requestId
    ) {
      reconciled.status = 'reconciled';
      reconciled.providerPlaybackId = state.providerPlaybackId ?? null;
      reconciled.result = { outcome: 'reconciled', providerStatus: state.status };
    } else {
      reconciled.status = 'uncertain';
      reconciled.result = {
        outcome: 'unknown',
        providerStatus: state?.status ?? 'unavailable',
      };
    }
    return this.dependencies.persistOperation(reconciled);
  }

  private async withLocalLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let unlock: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      unlock();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

function validateCommand(input: PlaybackCommandInput): PlaybackCommandInput {
  for (const field of [
    'workspaceId',
    'providerInstanceId',
    'playerId',
    'requestId',
    'idempotencyKey',
  ] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim()) {
      throw new TypeError(`${field} is required.`);
    }
  }
  if (!['play', 'pause', 'resume', 'skip', 'seek'].includes(input.command)) {
    throw new TypeError('Playback command is invalid.');
  }
  return {
    ...input,
    workspaceId: input.workspaceId.trim(),
    providerInstanceId: input.providerInstanceId.trim(),
    playerId: input.playerId.trim(),
    requestId: input.requestId.trim(),
    idempotencyKey: input.idempotencyKey.trim(),
  };
}

function leaseKey(input: PlaybackCommandInput): string {
  return JSON.stringify([input.workspaceId, input.providerInstanceId, input.playerId]);
}

function confirmsCommand(command: PlaybackCommand, status: string): boolean {
  const expected: Record<PlaybackCommand, string[]> = {
    play: ['playing'],
    pause: ['paused'],
    resume: ['playing'],
    skip: ['idle', 'stopped', 'playing'],
    seek: ['playing', 'paused'],
  };
  return expected[command].includes(status);
}
