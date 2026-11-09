export type ProviderFailureClass = 'transient' | 'authorization' | 'permanent' | 'uncertain';

export interface ProviderFailureInput {
  status?: number;
  code?: string;
  outcome?: string;
  sideEffectStarted?: boolean;
}

export interface ProviderRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  failoverEnabled: boolean;
  failoverOnPermanentFailure: boolean;
}

export const DEFAULT_PROVIDER_RETRY_POLICY: Readonly<ProviderRetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 300_000,
  failoverEnabled: true,
  failoverOnPermanentFailure: false,
};

export function classifyProviderFailure(input: ProviderFailureInput): ProviderFailureClass {
  if (input.outcome === 'unknown' || input.sideEffectStarted === true) return 'uncertain';
  if (input.status === 401 || input.status === 403) return 'authorization';
  if (
    input.code &&
    /^(unsupported_media|invalid_media|not_found|region_blocked)$/i.test(input.code)
  ) {
    return 'permanent';
  }
  if (
    input.status === 408 ||
    input.status === 425 ||
    input.status === 429 ||
    (input.status !== undefined && input.status >= 500)
  ) {
    return 'transient';
  }
  if (input.status !== undefined && input.status >= 400) return 'permanent';
  return 'transient';
}

export function isProviderFailoverAllowed(input: {
  failureClass: ProviderFailureClass;
  retryBudgetRemaining: boolean;
  policy?: Partial<ProviderRetryPolicy>;
}): boolean {
  const policy = { ...DEFAULT_PROVIDER_RETRY_POLICY, ...input.policy };
  if (!policy.failoverEnabled || !input.retryBudgetRemaining) return false;
  if (input.failureClass === 'authorization' || input.failureClass === 'uncertain') return false;
  return input.failureClass === 'transient' || policy.failoverOnPermanentFailure;
}

export interface FailoverCandidate {
  providerInstanceId: string;
  eligible: boolean;
  priority: number;
  requestId?: string;
}

export function selectFailoverCandidate<T extends FailoverCandidate>(
  candidates: readonly T[],
  input: { excludedProviderInstanceIds?: readonly string[]; requestId: string },
): (T & { requestId: string }) | null {
  const excluded = new Set(input.excludedProviderInstanceIds ?? []);
  const selected = candidates
    .filter((candidate) => candidate.eligible && !excluded.has(candidate.providerInstanceId))
    .slice()
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        compareStable(left.providerInstanceId, right.providerInstanceId),
    )[0];
  return selected ? { ...selected, requestId: input.requestId } : null;
}

export function shouldReconcilePlayback(input: ProviderFailureInput): boolean {
  return input.outcome === 'unknown' || input.sideEffectStarted === true;
}

export function providerRetryDelayMs(
  attempt: number,
  policy: Partial<ProviderRetryPolicy> = {},
): number {
  const resolved = { ...DEFAULT_PROVIDER_RETRY_POLICY, ...policy };
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError('attempt must be a positive integer.');
  }
  return Math.min(resolved.maxDelayMs, resolved.baseDelayMs * 2 ** (attempt - 1));
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
