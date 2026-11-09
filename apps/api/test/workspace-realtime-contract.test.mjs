import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeWorkspaceSubscription,
  buildWorkspaceSnapshotCursor,
  isSafeWorkspaceEvent,
} from '../src/realtime/workspace-realtime.ts';

const session = { userId: 'user-a', authenticated: true };

test('derives room authorization from verified membership, never a client-supplied actor or room', async () => {
    const authorize = async ({ userId, workspaceId }) => ({
      userId,
      workspaceId,
      role: 'moderator',
      active: true,
    });
    const result = await authorizeWorkspaceSubscription({
      session,
      requestedWorkspaceId: 'workspace-a',
      authorizeMembership: authorize,
    });
    assert.deepEqual(result, {
      userId: 'user-a',
      workspaceId: 'workspace-a',
      role: 'moderator',
    });
});

test('rejects unauthenticated, inactive, and cross-workspace subscriptions', async () => {
  const membership = async () => ({
    userId: 'user-b',
    workspaceId: 'workspace-b',
    role: 'owner',
    active: true,
  });
  await assert.rejects(
    authorizeWorkspaceSubscription({
      session: { userId: 'user-a', authenticated: false },
      requestedWorkspaceId: 'workspace-b',
      authorizeMembership: membership,
    }),
  );
  await assert.rejects(
    authorizeWorkspaceSubscription({
      session,
      requestedWorkspaceId: 'workspace-b',
      authorizeMembership: membership,
    }),
  );
  await assert.rejects(
    authorizeWorkspaceSubscription({
      session,
      requestedWorkspaceId: 'workspace-a',
      authorizeMembership: async () => ({
        userId: 'user-a',
        workspaceId: 'workspace-a',
        role: 'viewer',
        active: false,
      }),
    }),
  );
});

test('creates a stable snapshot cursor for reconnect recovery', () => {
  assert.deepEqual(
    buildWorkspaceSnapshotCursor({
      workspaceId: 'workspace-a',
      eventId: 'event-123',
      sequence: 42,
    }),
    { workspaceId: 'workspace-a', eventId: 'event-123', sequence: 42 },
  );
  assert.throws(() =>
    buildWorkspaceSnapshotCursor({
      workspaceId: 'workspace-b',
      eventId: 'event-123',
      sequence: -1,
    }),
  );
});

test('rejects unsafe realtime payloads and events from another workspace', () => {
  const safe = {
    id: 'event-123',
    workspaceId: 'workspace-a',
    type: 'request.created',
    payload: { requestId: 'request-1', status: 'pending' },
  };
  assert.equal(isSafeWorkspaceEvent(safe, 'workspace-a'), true);
  assert.equal(isSafeWorkspaceEvent(safe, 'workspace-b'), false);
  assert.equal(
    isSafeWorkspaceEvent({ ...safe, payload: { accessToken: 'secret' } }, 'workspace-a'),
    false,
  );
  assert.equal(
    isSafeWorkspaceEvent({ ...safe, payload: { rawWebhookBody: '{}' } }, 'workspace-a'),
    false,
  );
});
