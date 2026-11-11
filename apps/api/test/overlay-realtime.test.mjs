import assert from 'node:assert/strict';
import test from 'node:test';
import { OverlayRealtimeGateway } from '../dist/overlay-scenes/overlay-realtime.gateway.js';

test('forwards the outbox event type to authenticated overlay clients without exposing payloads', async () => {
  const sceneId = '11111111-1111-4111-8111-111111111111';
  const emitted = [];
  const socket = {
    data: { sceneId, token: 'a'.repeat(43), workspaceId: 'workspace-a' },
    emit: (eventName, payload) => emitted.push({ eventName, payload }),
    disconnect: () => assert.fail('A valid overlay socket should remain connected'),
  };
  const runtime = {
    activeSceneIds: async (workspaceId) => {
      assert.equal(workspaceId, 'workspace-a');
      return [sceneId];
    },
    authenticate: async (id, token) => {
      assert.equal(id, sceneId);
      assert.equal(token, 'a'.repeat(43));
      return { sceneId, workspaceId: 'workspace-a' };
    },
  };
  const gateway = new OverlayRealtimeGateway({}, runtime);
  gateway.server = {
    in: (room) => {
      assert.equal(room, `scene:${sceneId}`);
      return { fetchSockets: async () => [socket] };
    },
  };

  await gateway.broadcastInvalidation(JSON.stringify({
    workspaceId: 'workspace-a',
    type: 'playback.session.started',
    payload: { privateTrackMetadata: 'must-not-be-forwarded' },
  }));

  assert.deepEqual(emitted, [{
    eventName: 'overlay:invalidate',
    payload: { sceneId, eventType: 'playback.session.started' },
  }]);
});
