import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateRetryDelay,
  classifyProcessingFailure,
  isRetryEligible,
  shouldRequireReconciliation,
} from '../src/retry-policy.ts';

test('uses bounded exponential backoff and applies injected jitter deterministically', () => {
  const options = {
    attempt: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
    jitterRatio: 0.2,
    random: () => 0.75,
  };
  assert.equal(calculateRetryDelay(options), 5_200);
  assert.equal(
    calculateRetryDelay({ ...options, attempt: 20 }),
    10_000,
  );
});

test('rejects invalid retry policy inputs instead of producing unbounded delays', () => {
  assert.throws(() => calculateRetryDelay({ attempt: 0, baseDelayMs: 100, maxDelayMs: 1_000 }));
  assert.throws(() => calculateRetryDelay({ attempt: 1, baseDelayMs: -1, maxDelayMs: 1_000 }));
  assert.throws(() => calculateRetryDelay({ attempt: 1, baseDelayMs: 100, maxDelayMs: 50 }));
});

test('retries transient failures but never retries permanent failures', () => {
  assert.equal(classifyProcessingFailure({ kind: 'network', retryable: true }), 'retryable');
  assert.equal(classifyProcessingFailure({ kind: 'invalid_payload', retryable: false }), 'permanent');
  assert.equal(isRetryEligible({ failureClass: 'retryable', attempts: 2, maxAttempts: 5, ageMs: 100, maxAgeMs: 10_000 }), true);
  assert.equal(isRetryEligible({ failureClass: 'permanent', attempts: 0, maxAttempts: 5, ageMs: 0, maxAgeMs: 10_000 }), false);
});

test('enforces attempt and maximum-age limits', () => {
  const base = { failureClass: 'retryable', attempts: 2, maxAttempts: 3, ageMs: 100, maxAgeMs: 1_000 };
  assert.equal(isRetryEligible(base), true);
  assert.equal(isRetryEligible({ ...base, attempts: 3 }), false);
  assert.equal(isRetryEligible({ ...base, ageMs: 1_000 }), false);
});

test('ambiguous external side effects require reconciliation and are not blindly retried', () => {
  assert.equal(shouldRequireReconciliation({ outcome: 'unknown', externalSideEffectStarted: true }), true);
  assert.equal(shouldRequireReconciliation({ outcome: 'failed', externalSideEffectStarted: false }), false);
  assert.equal(isRetryEligible({ failureClass: 'uncertain', attempts: 0, maxAttempts: 5, ageMs: 0, maxAgeMs: 1_000 }), false);
});
