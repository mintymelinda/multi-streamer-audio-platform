import assert from 'node:assert/strict';
import test from 'node:test';
import { QueueManagerService } from '../dist/queues/queue-manager.service.js';
import { ProviderRoutingError } from '../dist/providers/provider-routing.service.js';

function harness({ candidate, executionState, enqueueError } = {}) {
  const calls = [];
  const enqueueCalls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('FROM logical_queue_entries q')) {
        return { rows: candidate ? [candidate] : [], rowCount: candidate ? 1 : 0 };
      }
      if (sql.includes('FROM workspace_memberships m')) {
        return { rows: [{ one: 1 }], rowCount: 1 };
      }
      if (sql.includes('FROM provider_execution_states')) {
        return { rows: executionState ? [executionState] : [], rowCount: executionState ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const database = {
    transaction: async (_context, callback) => callback(client),
  };
  const executionQueue = {
    enqueue: async (input) => {
      enqueueCalls.push(input);
      if (enqueueError) throw enqueueError;
      return input;
    },
  };
  return {
    service: new QueueManagerService(database, executionQueue),
    calls,
    enqueueCalls,
  };
}

const workspaceId = '10000000-0000-4000-8000-000000000001';
const triggerActorId = '20000000-0000-4000-8000-000000000002';
const submitterId = '30000000-0000-4000-8000-000000000003';
const ownerId = '40000000-0000-4000-8000-000000000004';
const requestId = '50000000-0000-4000-8000-000000000005';

test('dispatches the first queued request under its original submitter identity', async () => {
  const h = harness({
    candidate: {
      id: requestId,
      status: 'queued',
      source: 'dashboard',
      submitted_by_user_id: submitterId,
      owner_user_id: ownerId,
    },
  });

  const result = await h.service.dispatchNext({ workspaceId, actorId: triggerActorId });

  assert.deepEqual(result, { status: 'dispatched', requestId });
  assert.deepEqual(h.enqueueCalls, [{ workspaceId, requestId, actorId: submitterId }]);
  assert.ok(h.calls.some(({ sql }) => sql.includes('FOR UPDATE')));
  assert.ok(h.calls.some(({ sql }) => /ORDER BY q\.priority DESC, q\.sequence ASC/.test(sql)));
});

test('uses the workspace owner as the actor for Twitch reward requests', async () => {
  const h = harness({
    candidate: {
      id: requestId,
      status: 'queued',
      source: 'twitch_reward',
      submitted_by_user_id: null,
      owner_user_id: ownerId,
    },
  });

  const result = await h.service.dispatchNext({ workspaceId, actorId: triggerActorId });

  assert.deepEqual(result, { status: 'dispatched', requestId });
  assert.equal(h.enqueueCalls[0]?.actorId, ownerId);
});

test('does not create a duplicate provider execution for an already scheduled request', async () => {
  const h = harness({
    candidate: {
      id: requestId,
      status: 'queued',
      source: 'dashboard',
      submitted_by_user_id: submitterId,
      owner_user_id: ownerId,
    },
    executionState: { state: 'playing' },
  });

  const result = await h.service.dispatchNext({ workspaceId, actorId: triggerActorId });

  assert.deepEqual(result, { status: 'already_scheduled', requestId });
  assert.equal(h.enqueueCalls.length, 0);
});

test('does not bypass a request that is still resolving at the queue head', async () => {
  const h = harness({
    candidate: {
      id: requestId,
      status: 'resolving',
      source: 'dashboard',
      submitted_by_user_id: submitterId,
      owner_user_id: ownerId,
    },
  });

  const result = await h.service.dispatchNext({ workspaceId, actorId: triggerActorId });

  assert.deepEqual(result, { status: 'already_scheduled', requestId });
  assert.equal(h.enqueueCalls.length, 0);
});

test('leaves a request queued when every assigned output is busy', async () => {
  const h = harness({
    candidate: {
      id: requestId,
      status: 'queued',
      source: 'dashboard',
      submitted_by_user_id: submitterId,
      owner_user_id: ownerId,
    },
    enqueueError: new ProviderRoutingError('No idle output is assigned.', 'OUTPUT_NOT_ASSIGNED', []),
  });

  const result = await h.service.dispatchNext({ workspaceId, actorId: triggerActorId });

  assert.deepEqual(result, { status: 'blocked', requestId, reason: 'output_not_assigned' });
  assert.equal(h.enqueueCalls.length, 1);
});

test('returns empty when no queued logical request remains', async () => {
  const h = harness({ candidate: null });

  assert.deepEqual(
    await h.service.dispatchNext({ workspaceId, actorId: triggerActorId }),
    { status: 'empty' },
  );
  assert.equal(h.enqueueCalls.length, 0);
});
