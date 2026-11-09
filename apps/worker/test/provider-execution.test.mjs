import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyProviderFailure,
  isProviderFailoverAllowed,
  selectFailoverCandidate,
  shouldReconcilePlayback,
} from '../src/provider-execution-policy.ts';

test('classifies transient, authorization, permanent, and uncertain provider failures distinctly', () => {
  assert.equal(classifyProviderFailure({ status: 503 }), 'transient');
  assert.equal(classifyProviderFailure({ status: 401 }), 'authorization');
  assert.equal(classifyProviderFailure({ code: 'unsupported_media' }), 'permanent');
  assert.equal(classifyProviderFailure({ outcome: 'unknown', sideEffectStarted: true }), 'uncertain');
});

test('does not fail over on authorization loss or uncertain playback outcomes', () => {
  assert.equal(isProviderFailoverAllowed({ failureClass: 'authorization' }), false);
  assert.equal(isProviderFailoverAllowed({ failureClass: 'uncertain' }), false);
  assert.equal(isProviderFailoverAllowed({ failureClass: 'transient', retryBudgetRemaining: true }), true);
});

test('selects a deterministic eligible failover candidate without changing requested media', () => {
  const candidates = [
    { providerInstanceId: 'provider-z', eligible: true, priority: 5 },
    { providerInstanceId: 'provider-a', eligible: true, priority: 5 },
    { providerInstanceId: 'provider-b', eligible: false, priority: 1 },
  ];
  const selected = selectFailoverCandidate(candidates, {
    excludedProviderInstanceIds: ['provider-z'],
    requestId: 'request-a',
  });
  assert.equal(selected.providerInstanceId, 'provider-a');
  assert.equal(selected.requestId, 'request-a');
});

test('requires playback reconciliation whenever an external start may have occurred', () => {
  assert.equal(shouldReconcilePlayback({ outcome: 'unknown', sideEffectStarted: true }), true);
  assert.equal(shouldReconcilePlayback({ outcome: 'failed', sideEffectStarted: false }), false);
});
