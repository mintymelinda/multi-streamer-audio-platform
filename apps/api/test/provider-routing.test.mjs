import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRoutingService } from '../dist/providers/provider-routing.service.js';

const request = {
  id: 'request-a',
  workspaceId: 'workspace-a',
  mediaType: 'audio',
  durationSeconds: 210,
  sourceProviderId: 'youtube',
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

test('routes YouTube source resolution to a separate Lyrion playback output', async () => {
  const youtube = provider({
    providerId: 'youtube',
    instanceId: 'youtube-source',
    priority: 5,
    capabilities: { ...provider().capabilities, playback: false },
  });
  const lyrion = provider({
    providerId: 'lyrion',
    instanceId: 'lyrion-output',
    priority: 10,
    capabilities: {
      search: false,
      resolve: false,
      playback: true,
      pause: true,
      resume: true,
      seek: true,
      queue: false,
      maxDurationSeconds: null,
      mediaTypes: ['audio'],
    },
  });
  const service = new ProviderRoutingService({
    listProviderInstances: async () => [youtube, lyrion],
    getWorkspaceRules: async () => ({
      allowedProviderIds: ['youtube', 'lyrion'],
      blockedProviderIds: [],
      preferredProviderIds: ['lyrion'],
    }),
    getOutputAssignment: async (_workspaceId, instanceId) => instanceId === 'lyrion-output'
      ? { outputId: 'output-a', providerInstanceId: instanceId, playerId: 'player-a' }
      : null,
  });
  const result = await service.route({
    workspaceId: 'workspace-a',
    request: { ...request, sourceProviderId: 'youtube' },
  });
  assert.equal(result.sourceProviderId, 'youtube');
  assert.equal(result.sourceProviderInstanceId, 'youtube-source');
  assert.equal(result.providerId, 'lyrion');
  assert.equal(result.providerInstanceId, 'lyrion-output');
  assert.equal(result.outputId, 'output-a');
});

test('blocks routing when the source provider is restricted even if an output is available', async () => {
  const youtube = provider({
    providerId: 'youtube',
    instanceId: 'youtube-source',
    capabilities: { ...provider().capabilities, playback: false },
  });
  const lyrion = provider({
    providerId: 'lyrion',
    instanceId: 'lyrion-output',
    capabilities: { ...provider().capabilities, resolve: false },
  });
  const service = new ProviderRoutingService({
    listProviderInstances: async () => [youtube, lyrion],
    getWorkspaceRules: async () => ({
      allowedProviderIds: ['lyrion'],
      blockedProviderIds: ['youtube'],
      preferredProviderIds: [],
    }),
    getOutputAssignment: async (_workspaceId, instanceId) => ({
      outputId: 'output-a',
      providerInstanceId: instanceId,
      playerId: 'player-a',
    }),
  });
  await assert.rejects(
    service.route({
      workspaceId: 'workspace-a',
      request: { ...request, sourceProviderId: 'youtube' },
    }),
    (error) => error.code === 'NO_ELIGIBLE_PROVIDER',
  );
});

test('does not route Spotify source media to a YouTube-only Lyrion output', async () => {
  const spotify = provider({
    providerId: 'spotify',
    instanceId: 'spotify-source',
    capabilities: { ...provider().capabilities, playback: false },
  });
  const lyrion = provider({
    providerId: 'lyrion',
    instanceId: 'lyrion-output',
    capabilities: {
      search: false,
      resolve: false,
      playback: true,
      pause: true,
      resume: true,
      seek: true,
      queue: false,
      maxDurationSeconds: null,
      mediaTypes: ['audio'],
      supportedSourceProviderIds: ['youtube'],
    },
  });
  const service = new ProviderRoutingService({
    listProviderInstances: async () => [spotify, lyrion],
    getWorkspaceRules: async () => ({
      allowedProviderIds: ['spotify', 'lyrion'],
      blockedProviderIds: [],
      preferredProviderIds: [],
    }),
    getOutputAssignment: async () => ({
      outputId: 'output-a',
      providerInstanceId: 'lyrion-output',
      playerId: 'player-a',
    }),
  });
  await assert.rejects(
    service.route({
      workspaceId: 'workspace-a',
      request: { ...request, sourceProviderId: 'spotify' },
    }),
    (error) => error.code === 'NO_ELIGIBLE_PROVIDER',
  );
});
