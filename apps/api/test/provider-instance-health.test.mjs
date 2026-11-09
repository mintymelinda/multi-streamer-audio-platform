import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderInstanceService,
  ProviderHealthService,
} from '../dist/providers/provider-instance.service.js';

test('provider instance identity is workspace-scoped and stable across reconnects', async () => {
  const service = new ProviderInstanceService({
    findByIdentity: async ({ workspaceId, providerId, instanceKey }) => ({
      id: 'instance-a', workspaceId, providerId, instanceKey,
    }),
  });
  const first = await service.resolveIdentity({
    workspaceId: 'workspace-a', providerId: 'spotify', instanceKey: 'primary',
  });
  const second = await service.resolveIdentity({
    workspaceId: 'workspace-a', providerId: 'spotify', instanceKey: 'primary',
  });
  assert.equal(first.id, second.id);
  assert.equal(first.id, 'instance-a');
  await assert.rejects(service.resolveIdentity({
    workspaceId: '', providerId: 'spotify', instanceKey: 'primary',
  }));
});

test('health state distinguishes healthy, degraded, unavailable, and authorization-expired', async () => {
  const health = new ProviderHealthService();
  assert.equal(health.classify({ latencyMs: 100, authorizationValid: true, consecutiveFailures: 0 }), 'healthy');
  assert.equal(health.classify({ latencyMs: 2_000, authorizationValid: true, consecutiveFailures: 1 }), 'degraded');
  assert.equal(health.classify({ latencyMs: null, authorizationValid: true, consecutiveFailures: 5 }), 'unavailable');
  assert.equal(health.classify({ latencyMs: 100, authorizationValid: false, consecutiveFailures: 0 }), 'authorization_expired');
});

test('health probes never overwrite authorization-expired state with healthy status', async () => {
  const health = new ProviderHealthService();
  const result = await health.applyProbeResult({
    currentState: 'authorization_expired',
    probe: { reachable: true, latencyMs: 30 },
  });
  assert.equal(result.status, 'authorization_expired');
  assert.equal(result.requiresReconnect, true);
});

test('capability changes are versioned and stale adapter versions are rejected', async () => {
  const service = new ProviderInstanceService({
    currentContractVersion: 2,
  });
  await assert.rejects(service.validateContractVersion(1));
  assert.equal(await service.validateContractVersion(2), true);
});
