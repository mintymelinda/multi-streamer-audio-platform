import {
  classifyProviderFailure,
  DEFAULT_PROVIDER_RETRY_POLICY,
  isProviderFailoverAllowed,
  selectFailoverCandidate,
  shouldReconcilePlayback,
  providerRetryDelayMs,
  type FailoverCandidate,
  type ProviderFailureClass,
  type ProviderRetryPolicy,
} from './provider-execution-policy.js';

export interface AuthoritativeExecutionRequest {
  id: string;
  workspaceId: string;
  mediaId: string;
  mediaType?: string;
  status: string;
}

export interface ProviderExecutionCandidate extends FailoverCandidate {
  providerId?: string;
}

export interface ProviderPlaybackSnapshot {
  status: string;
  providerPlaybackId?: string;
  requestId?: string;
}

export interface ProviderExecutionResult {
  outcome: 'started' | 'completed' | 'unknown' | 'failed';
  providerPlaybackId?: string;
  [key: string]: unknown;
}

export interface ProviderExecutionProcessorDependencies {
  loadAuthoritativeRequest(input: {
    workspaceId: string;
    requestId: string;
  }): Promise<AuthoritativeExecutionRequest | null>;
  getCandidates(request: AuthoritativeExecutionRequest): Promise<ProviderExecutionCandidate[]>;
  execute(
    providerInstanceId: string,
    request: AuthoritativeExecutionRequest,
    input: { idempotencyKey: string },
  ): Promise<ProviderExecutionResult>;
  reconcile?(input: {
    providerInstanceId: string;
    request: AuthoritativeExecutionRequest;
  }): Promise<ProviderPlaybackSnapshot | null>;
  acquirePlaybackLease?(input: {
    workspaceId: string;
    requestId: string;
    ownerId: string;
  }): Promise<boolean | { acquired: boolean }>;
  releasePlaybackLease?(input: {
    workspaceId: string;
    requestId: string;
    ownerId: string;
  }): Promise<unknown>;
  findPlaybackByRequest?(input: {
    workspaceId: string;
    requestId: string;
  }): Promise<ProviderPlaybackSnapshot | null>;
  persistExecutionState(input: {
    workspaceId: string;
    requestId: string;
    providerInstanceId: string;
    state: 'playing' | 'retry_wait' | 'failed' | 'uncertain' | 'completed';
    attempt: number;
    failureClass?: ProviderFailureClass;
    errorCode?: string;
    nextAttemptAt?: string;
    providerPlaybackId?: string;
  }): Promise<unknown>;
  appendAudit?(input: Record<string, unknown>): Promise<unknown>;
  policy?: Partial<ProviderRetryPolicy>;
  now?: () => Date;
}

const activeRequestStatuses = new Set(['approved', 'queued', 'resolving', 'ready', 'playing']);

export class ProviderExecutionProcessor {
  private readonly inFlight = new Map<
    string,
    Promise<
      ProviderExecutionResult & {
        providerInstanceId: string;
        status: string;
      }
    >
  >();

  constructor(private readonly dependencies: ProviderExecutionProcessorDependencies) {}

  async process(input: {
    workspaceId: string;
    requestId: string;
    idempotencyKey?: string;
  }): Promise<ProviderExecutionResult & { providerInstanceId: string; status: string }> {
    const workspaceId = required(input.workspaceId, 'workspaceId');
    const requestId = required(input.requestId, 'requestId');
    const key = `${workspaceId}:${requestId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const operation = this.processOnce({
      workspaceId,
      requestId,
      idempotencyKey: input.idempotencyKey?.trim() || `${requestId}:provider-play`,
    });
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  private async processOnce(input: {
    workspaceId: string;
    requestId: string;
    idempotencyKey: string;
  }): Promise<ProviderExecutionResult & { providerInstanceId: string; status: string }> {
    const request = await this.dependencies.loadAuthoritativeRequest(input);
    if (!request || request.workspaceId !== input.workspaceId) {
      throw new Error('The authoritative request does not exist in this workspace.');
    }
    if (!activeRequestStatuses.has(request.status)) {
      throw new Error('The authoritative request is not eligible for provider execution.');
    }

    const existingPlayback = await this.dependencies.findPlaybackByRequest?.(input);
    if (existingPlayback?.status === 'playing' && existingPlayback.requestId === request.id) {
      return {
        outcome: 'started',
        status: 'reconciled',
        providerInstanceId: '',
        ...(existingPlayback.providerPlaybackId
          ? { providerPlaybackId: existingPlayback.providerPlaybackId }
          : {}),
      };
    }

    const ownerId = `provider-execution:${input.requestId}`;
    const lease = await this.dependencies.acquirePlaybackLease?.({
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      ownerId,
    });
    if (lease !== undefined && !(typeof lease === 'boolean' ? lease : lease.acquired)) {
      throw new Error('Another worker currently owns this request playback lease.');
    }

    try {
      const candidates = await this.dependencies.getCandidates(request);
      const policy = { ...DEFAULT_PROVIDER_RETRY_POLICY, ...this.dependencies.policy };
      const attempted: string[] = [];
      let attempt = 0;

      while (true) {
        const candidate = selectFailoverCandidate(candidates, {
          excludedProviderInstanceIds: attempted,
          requestId: request.id,
        });
        if (!candidate) throw new Error('No eligible provider remains for this request.');

        attempted.push(candidate.providerInstanceId);
        attempt += 1;
        try {
          const result = await this.dependencies.execute(candidate.providerInstanceId, request, {
            idempotencyKey: input.idempotencyKey,
          });
          if (shouldReconcilePlayback(result)) {
            return this.reconcileOrStop(request, candidate.providerInstanceId, attempt);
          }
          if (result.outcome === 'failed') {
            const failureDetails = errorDetails(result);
            const failureClass = classifyProviderFailure(failureDetails);
            await this.dependencies.persistExecutionState({
              workspaceId: input.workspaceId,
              requestId: input.requestId,
              providerInstanceId: candidate.providerInstanceId,
              state: 'failed',
              attempt,
              failureClass,
            });
            if (
              !isProviderFailoverAllowed({
                failureClass,
                retryBudgetRemaining: attempt < policy.maxAttempts,
                policy,
              })
            ) {
              throw Object.assign(
                new Error('Provider execution failed and failover is not permitted.'),
                failureDetails,
              );
            }
            continue;
          }

          await this.dependencies.persistExecutionState({
            workspaceId: input.workspaceId,
            requestId: input.requestId,
            providerInstanceId: candidate.providerInstanceId,
            state: result.outcome === 'completed' ? 'completed' : 'playing',
            attempt,
            ...(result.providerPlaybackId ? { providerPlaybackId: result.providerPlaybackId } : {}),
          });
          await this.dependencies.appendAudit?.({
            action: 'provider.execution.started',
            workspaceId: input.workspaceId,
            requestId: input.requestId,
            providerInstanceId: candidate.providerInstanceId,
            attempt,
          });
          return {
            ...result,
            status: result.outcome === 'completed' ? 'completed' : 'playing',
            providerInstanceId: candidate.providerInstanceId,
          };
        } catch (error) {
          const failureClass = classifyProviderFailure(errorDetails(error));
          await this.dependencies.persistExecutionState({
            workspaceId: input.workspaceId,
            requestId: input.requestId,
            providerInstanceId: candidate.providerInstanceId,
            state:
              failureClass === 'uncertain'
                ? 'uncertain'
                : failureClass === 'transient'
                  ? 'retry_wait'
                  : 'failed',
            attempt,
            failureClass,
            errorCode: errorCode(error),
            ...(failureClass === 'transient'
              ? {
                  nextAttemptAt: new Date(
                    (this.dependencies.now ?? (() => new Date()))().getTime() +
                      providerRetryDelayMs(attempt, policy),
                  ).toISOString(),
                }
              : {}),
          });
          if (failureClass === 'uncertain') {
            return this.reconcileOrStop(request, candidate.providerInstanceId, attempt);
          }
          if (
            !isProviderFailoverAllowed({
              failureClass,
              retryBudgetRemaining: attempt < policy.maxAttempts,
              policy,
            })
          ) {
            throw error;
          }
        }
      }
    } finally {
      if (this.dependencies.releasePlaybackLease) {
        await this.dependencies.releasePlaybackLease({
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          ownerId,
        });
      }
    }
  }

  private async reconcileOrStop(
    request: AuthoritativeExecutionRequest,
    providerInstanceId: string,
    attempt: number,
  ): Promise<ProviderExecutionResult & { providerInstanceId: string; status: string }> {
    let snapshot: ProviderPlaybackSnapshot | null = null;
    try {
      snapshot = (await this.dependencies.reconcile?.({ providerInstanceId, request })) ?? null;
    } catch {
      snapshot = null;
    }
    if (snapshot?.requestId === request.id && snapshot.status === 'playing') {
      await this.dependencies.persistExecutionState({
        workspaceId: request.workspaceId,
        requestId: request.id,
        providerInstanceId,
        state: 'playing',
        attempt,
        ...(snapshot.providerPlaybackId ? { providerPlaybackId: snapshot.providerPlaybackId } : {}),
      });
      return {
        outcome: 'started',
        status: 'reconciled',
        providerInstanceId,
        ...(snapshot.providerPlaybackId ? { providerPlaybackId: snapshot.providerPlaybackId } : {}),
      };
    }
    await this.dependencies.persistExecutionState({
      workspaceId: request.workspaceId,
      requestId: request.id,
      providerInstanceId,
      state: 'uncertain',
      attempt,
      failureClass: 'uncertain',
      errorCode: 'playback_outcome_uncertain',
    });
    await this.dependencies.appendAudit?.({
      action: 'provider.execution.uncertain',
      workspaceId: request.workspaceId,
      requestId: request.id,
      providerInstanceId,
      attempt,
    });
    return { outcome: 'unknown', status: 'uncertain', providerInstanceId };
  }
}

function errorDetails(error: unknown): {
  status?: number;
  code?: string;
  outcome?: string;
  sideEffectStarted?: boolean;
} {
  if (typeof error !== 'object' || error === null) return {};
  const value = error as Record<string, unknown>;
  return {
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
    ...(typeof value.sideEffectStarted === 'boolean'
      ? { sideEffectStarted: value.sideEffectStarted }
      : {}),
  };
}

function errorCode(error: unknown): string {
  const code = errorDetails(error).code;
  return code && /^[a-z0-9_]{1,100}$/i.test(code)
    ? code.toLowerCase()
    : 'provider_execution_failed';
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required.`);
  return value.trim();
}
