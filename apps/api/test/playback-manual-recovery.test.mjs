import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackRecoveryService } from '../dist/playback/playback-recovery.service.js';

function setup(allowed = true) {
  const actions = [];
  let policy = {
    automaticRetryEnabled: true,
    failoverEnabled: true,
    failoverOnPermanentFailure: false,
    maxAttempts: 3,
    baseDelayMs: 5000,
    maxDelayMs: 300000,
  };
  const request = {
    id: 'request-a',
    workspaceId: 'workspace-a',
    mediaId: 'media-original',
    status: 'failed',
    providerInstanceId: 'primary',
  };
  const service = new PlaybackRecoveryService({
    authorize: async () => ({ allowed }),
    getPolicy: async () => policy,
    updatePolicy: async (_workspaceId, _actorId, nextPolicy) => {
      policy = nextPolicy;
      return policy;
    },
    getRequest: async () => request,
    retry: async (item) => actions.push(['retry', item.id]),
    reroute: async (item, providerId) => actions.push(['reroute', item.id, providerId]),
    skip: async (item) => actions.push(['skip', item.id]),
    dismiss: async (item) => actions.push(['dismiss', item.id]),
    appendAudit: async (event) => actions.push(['audit', event.action]),
  });
  return { service, actions, request };
}

test('workspace recovery policy is configurable within safe retry bounds', async () => {
  const { service } = setup();
  const current = await service.getPolicy({
    workspaceId: 'workspace-a',
    actorId: 'admin-a',
  });
  assert.equal(current.maxAttempts, 3);

  const updated = await service.updatePolicy({
    workspaceId: 'workspace-a',
    actorId: 'admin-a',
    reason: 'Tune provider outage recovery',
    policy: {
      automaticRetryEnabled: false,
      failoverEnabled: true,
      failoverOnPermanentFailure: false,
      maxAttempts: 5,
      baseDelayMs: 10000,
      maxDelayMs: 600000,
    },
  });
  assert.equal(updated.automaticRetryEnabled, false);
  assert.equal(updated.maxAttempts, 5);

  await assert.rejects(
    service.updatePolicy({
      workspaceId: 'workspace-a',
      actorId: 'admin-a',
      reason: 'Invalid retry limit',
      policy: {
        automaticRetryEnabled: true,
        failoverEnabled: true,
        failoverOnPermanentFailure: false,
        maxAttempts: 11,
        baseDelayMs: 10000,
        maxDelayMs: 600000,
      },
    }),
  );
});

test('manual retry preserves the original request and media identity', async () => {
  const { service, request } = setup();
  const result = await service.retry({
    workspaceId: 'workspace-a',
    requestId: 'request-a',
    actorId: 'admin-a',
    reason: 'Provider recovered',
  });
  assert.equal(result.requestId, request.id);
  assert.equal(result.mediaId, 'media-original');
});

test('manual reroute changes provider selection, never requested media', async () => {
  const { service, request } = setup();
  const result = await service.reroute({
    workspaceId: 'workspace-a',
    requestId: 'request-a',
    actorId: 'admin-a',
    providerInstanceId: 'invidious-b',
    reason: 'Primary instance unavailable',
  });
  assert.equal(result.mediaId, request.mediaId);
  assert.equal(result.providerInstanceId, 'invidious-b');
});

test('skip and dismiss require actor attribution and a meaningful reason', async () => {
  const { service } = setup();
  await assert.rejects(
    service.skip({
      workspaceId: 'workspace-a',
      requestId: 'request-a',
      actorId: 'admin-a',
      reason: ' ',
    }),
  );
  await assert.rejects(
    service.dismiss({
      workspaceId: 'workspace-a',
      requestId: 'request-a',
      actorId: 'admin-a',
      reason: '',
    }),
  );
  await service.skip({
    workspaceId: 'workspace-a',
    requestId: 'request-a',
    actorId: 'admin-a',
    reason: 'Streamer requested skip',
  });
  await service.dismiss({
    workspaceId: 'workspace-a',
    requestId: 'request-a',
    actorId: 'admin-a',
    reason: 'Rights review',
  });
});

test('rejects recovery actions from unauthorized workspace members', async () => {
  const { service } = setup(false);
  await assert.rejects(
    service.retry({
      workspaceId: 'workspace-a',
      requestId: 'request-a',
      actorId: 'viewer-a',
      reason: 'Provider recovered',
    }),
  );
});


test('does not audit or close a playing request when the provider skip is unconfirmed', async () => {
  const request = {
    id: 'request-playing',
    workspaceId: 'workspace-a',
    mediaId: 'media-original',
    status: 'playing',
    providerInstanceId: 'lyrion-a',
    providerExecutionState: 'playing',
  };
  const actions = [];
  const service = new PlaybackRecoveryService({
    authorize: async () => ({ allowed: true }),
    getRequest: async () => request,
    skip: async (item) => {
      actions.push(['skip', item.id]);
      throw new Error('Provider outcome is uncertain.');
    },
    dismiss: async () => undefined,
    retry: async () => undefined,
    reroute: async () => undefined,
    appendAudit: async (event) => actions.push(['audit', event.action]),
  });

  await assert.rejects(
    service.skip({
      workspaceId: 'workspace-a',
      requestId: request.id,
      actorId: 'admin-a',
      reason: 'Skip requested by streamer',
    }),
    /uncertain/,
  );
  assert.deepEqual(actions, [['skip', 'request-playing']]);
  assert.equal(request.status, 'playing');
});
