import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRoutingService } from '../dist/providers/provider-routing.service.js';

const request = {
  id: 'request-a',
  workspaceId: 'workspace-a',
  mediaType: 'audio',
  durationSeconds: 210,
  sourceProviderId: null,
};

const provider = (overrides = {}) => ({
  providerId: 'youtube',
  instanceId: 'youtube-a',
  enabled: true,
  health: 'healthy',
  priority: 10,
  capabilities: {
    search: true,
    resolve: true,
    playback: true,
    pause: false,
    resume: false,
    seek: false,
    queue: false,
    maxDurationSeconds: 900,
    mediaTypes: ['audio', 'video'],
  },
  ...overrides,
});

test('routes only to enabled, healthy providers that satisfy request and workspace policy', async () => {
  const service = new ProviderRoutingService({
    listProviderInstances: async () => [
      provider({ instanceId: 'disabled', enabled: false, priority: 1 }),
      provider({ instanceId: 'unhealthy', health: 'unavailable', priority: 2 }),
      provider({
        instanceId: 'too-short',
        priority: 3,
        capabilities: { ...provider().capabilities, maxDurationSeconds: 60 },
      }),
      provider({ instanceId: 'eligible', priority: 4 }),
    ],
    getWorkspaceRules: async () => ({
      allowedProviderIds: ['youtube'],
      blockedProviderIds: [],
      preferredProviderIds: [],
    }),
    getOutputAssignment: async () => ({
      outputId: 'output-a',
      providerInstanceId: 'eligible',
      playerId: 'player-a',
    }),
  });

  const result = await service.route({ workspaceId: 'workspace-a', request });
  assert.equal(result.providerInstanceId, 'eligible');
  assert.equal(result.outputId, 'output-a');
  assert.ok(result.reason);
  assert.ok(Array.isArray(result.considered));
});

test('uses deterministic tie-breaking when eligible providers have equal priority', async () => {
  const service = new ProviderRoutingService({
    listProviderInstances: async () => [
      provider({ instanceId: 'provider-z', priority: 5 }),
      provider({ instanceId: 'provider-a', priority: 5 }),
    ],
    getWorkspaceRules: async () => ({
      allowedProviderIds: ['youtube'],
      blockedProviderIds: [],
      preferredProviderIds: [],
    }),
    getOutputAssignment: async (_workspaceId, instanceId) => ({
      outputId: 'output-a',
      providerInstanceId: instanceId,
      playerId: 'player-a',
    }),
  });

  const first = await service.route({ workspaceId: 'workspace-a', request });
  const second = await service.route({ workspaceId: 'workspace-a', request });
  assert.equal(first.providerInstanceId, second.providerInstanceId);
  assert.equal(first.providerInstanceId, 'provider-a');
});

test('does not route when workspace policy blocks every otherwise-capable provider', async () => {
  const service = new ProviderRoutingService({
    listProviderInstances: async () => [provider()],
    getWorkspaceRules: async () => ({
      allowedProviderIds: [],
      blockedProviderIds: ['youtube'],
      preferredProviderIds: [],
    }),
    getOutputAssignment: async () => null,
  });

  await assert.rejects(
    service.route({ workspaceId: 'workspace-a', request }),
    (error) => error.code === 'NO_ELIGIBLE_PROVIDER',
  );
});

test('rejects ambiguous or missing output assignments instead of implicitly mixing audio', async () => {
  const service = new ProviderRoutingService({
    listProviderInstances: async () => [provider()],
    getWorkspaceRules: async () => ({
      allowedProviderIds: ['youtube'],
      blockedProviderIds: [],
      preferredProviderIds: [],
    }),
    getOutputAssignment: async () => null,
  });

  await assert.rejects(
    service.route({ workspaceId: 'workspace-a', request }),
    (error) => error.code === 'OUTPUT_NOT_ASSIGNED',
  );
});
