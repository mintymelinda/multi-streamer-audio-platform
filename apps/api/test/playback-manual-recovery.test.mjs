import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackRecoveryService } from '../dist/playback/playback-recovery.service.js';

function setup() {
  const actions = [];
  const request = { id: 'request-a', workspaceId: 'workspace-a', mediaId: 'media-original', status: 'approved' };
  const service = new PlaybackRecoveryService({
    authorize: async () => ({ allowed: true, role: 'admin' }),
    getRequest: async () => request,
    retry: async (id) => actions.push(['retry', id]),
    reroute: async (id, providerId) => actions.push(['reroute', id, providerId]),
    skip: async (id) => actions.push(['skip', id]),
    dismiss: async (id, reason) => actions.push(['dismiss', id, reason]),
    appendAudit: async (event) => actions.push(['audit', event.action]),
  });
  return { service, actions, request };
}

test('manual retry preserves the original request and media identity', async () => {
  const { service, request } = setup();
  const result = await service.retry({ workspaceId: 'workspace-a', requestId: 'request-a', actorId: 'admin-a', reason: 'Provider recovered' });
  assert.equal(result.requestId, request.id);
  assert.equal(result.mediaId, 'media-original');
});

test('manual reroute changes provider selection, never the requested media', async () => {
  const { service, request } = setup();
  const result = await service.reroute({
    workspaceId: 'workspace-a', requestId: 'request-a', actorId: 'admin-a',
    providerInstanceId: 'invidious-b', reason: 'Primary instance unavailable',
  });
  assert.equal(result.mediaId, request.mediaId);
  assert.equal(result.providerInstanceId, 'invidious-b');
});

test('manual skip and dismiss require actor attribution and a reason', async () => {
  const { service } = setup();
  await assert.rejects(service.skip({ workspaceId: 'workspace-a', requestId: 'request-a', actorId: 'admin-a', reason: ' ' }));
  await assert.rejects(service.dismiss({ workspaceId: 'workspace-a', requestId: 'request-a', actorId: 'admin-a', reason: '' }));
  await service.skip({ workspaceId: 'workspace-a', requestId: 'request-a', actorId: 'admin-a', reason: 'Streamer requested skip' });
  await service.dismiss({ workspaceId: 'workspace-a', requestId: 'request-a', actorId: 'admin-a', reason: 'Rights review' });
});

test('rejects manual recovery actions from unauthorized workspace members', async () => {
  const { service } = setup();
  service.setAuthorization?.(async () => ({ allowed: false }));
  await assert.rejects(service.retry({
    workspaceId: 'workspace-b', requestId: 'request-a', actorId: 'viewer-a', reason: 'retry',
  }));
});
