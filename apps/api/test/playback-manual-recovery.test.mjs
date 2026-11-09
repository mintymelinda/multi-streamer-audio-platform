import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackRecoveryService } from '../dist/playback/playback-recovery.service.js';

function setup(allowed = true) {
  const actions = [];
  const request = {
    id: 'request-a',
    workspaceId: 'workspace-a',
    mediaId: 'media-original',
    status: 'failed',
    providerInstanceId: 'primary',
  };
  const service = new PlaybackRecoveryService({
    authorize: async () => ({ allowed }),
    getRequest: async () => request,
    retry: async (item) => actions.push(['retry', item.id]),
    reroute: async (item, providerId) => actions.push(['reroute', item.id, providerId]),
    skip: async (item) => actions.push(['skip', item.id]),
    dismiss: async (item) => actions.push(['dismiss', item.id]),
    appendAudit: async (event) => actions.push(['audit', event.action]),
  });
  return { service, actions, request };
}

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
