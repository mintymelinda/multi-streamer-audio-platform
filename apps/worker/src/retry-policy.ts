export type ProcessingFailureClass = 'retryable' | 'permanent' | 'uncertain';

export interface RetryDelayOptions {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio?: number;
  random?: () => number;
}

export function calculateRetryDelay(options: RetryDelayOptions): number {
  const { attempt, baseDelayMs, maxDelayMs, jitterRatio = 0, random = Math.random } = options;

  if (
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    !Number.isFinite(baseDelayMs) ||
    baseDelayMs <= 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < baseDelayMs ||
    !Number.isFinite(jitterRatio) ||
    jitterRatio < 0 ||
    jitterRatio > 1
  ) {
    throw new RangeError('Retry policy inputs are invalid.');
  }

  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new RangeError('Retry jitter source must return a value from 0 to 1.');
  }

  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = 1 + (randomValue * 2 - 1) * jitterRatio;
  return Math.min(maxDelayMs, Math.max(0, Math.round(exponential * jitter)));
}

export function classifyProcessingFailure(input: {
  kind: string;
  retryable: boolean;
  outcome?: 'failed' | 'unknown';
  externalSideEffectStarted?: boolean;
}): ProcessingFailureClass {
  if (input.outcome === 'unknown' && input.externalSideEffectStarted === true) {
    return 'uncertain';
  }
  return input.retryable ? 'retryable' : 'permanent';
}

export function isRetryEligible(input: {
  failureClass: ProcessingFailureClass;
  attempts: number;
  maxAttempts: number;
  ageMs: number;
  maxAgeMs: number;
}): boolean {
  return (
    input.failureClass === 'retryable' &&
    Number.isInteger(input.attempts) &&
    Number.isInteger(input.maxAttempts) &&
    input.attempts >= 0 &&
    input.maxAttempts > 0 &&
    input.attempts < input.maxAttempts &&
    Number.isFinite(input.ageMs) &&
    Number.isFinite(input.maxAgeMs) &&
    input.ageMs >= 0 &&
    input.maxAgeMs > 0 &&
    input.ageMs < input.maxAgeMs
  );
}

export function shouldRequireReconciliation(input: {
  outcome: 'failed' | 'unknown';
  externalSideEffectStarted: boolean;
}): boolean {
  return input.outcome === 'unknown' && input.externalSideEffectStarted;
}
