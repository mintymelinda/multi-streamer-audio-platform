import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceLifecycleService } from '../dist/workspaces/workspace-lifecycle.service.js';

const workspaceId = '75000000-0000-4000-8000-000000000002';
const userId = '74000000-0000-4000-8000-000000000002';

function harness({ ledgerFailure = false } = {}) {
  const calls = [];
  const database = {
    transaction: async (_context, operation) => {
      const result = await operation({
      query: async (sql) => {
        calls.push(sql);
        if (sql.startsWith('SELECT name,owner_user_id')) {
          return { rows: [{ name: 'Example workspace', owner_user_id: userId }] };
        }
        if (sql.startsWith('SELECT object_key,pending_object_key')) return { rows: [] };
        if (sql.startsWith('DELETE FROM workspaces')) return { rowCount: 1 };
        return { rows: [] };
      },
    });
      calls.push('commit');
      return result;
    },
  };
  const storage = { delete: async () => undefined };
  const ledger = {
    append: async (...args) => {
      calls.push(['ledger', ...args]);
      if (ledgerFailure) throw new Error('ledger unavailable');
    },
  };
  return { service: new WorkspaceLifecycleService(database, storage, ledger), calls };
}

test('workspace deletion appends a tombstone after the database delete and before commit', async () => {
  const { service, calls } = harness();
  const result = await service.delete(workspaceId, userId, 'Example workspace');
  assert.equal(result.deleted, true);
  assert.deepEqual(calls.at(-2), ['ledger', 'workspace', workspaceId]);
  assert.equal(calls.at(-1), 'commit');
});

test('workspace deletion fails closed when the independent ledger cannot be written', async () => {
  const { service } = harness({ ledgerFailure: true });
  await assert.rejects(
    service.delete(workspaceId, userId, 'Example workspace'),
    /ledger unavailable/,
  );
});

test('workspace deletion does not write a tombstone for a mismatched confirmation', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.delete(workspaceId, userId, 'wrong name'), /does not match/);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'ledger'), false);
});
