import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountDeletionService } from '../dist/account-deletion/account-deletion.service.js';

function harness(handler) {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push({ context });
      return operation({ query: async (sql, values = []) => {
        calls.push({ sql, values });
        return handler(sql, values, calls);
      } });
    },
  };
  return { service: new AccountDeletionService(database), calls };
}

test('deletes only the authenticated account through the database-owned deletion function', async () => {
  const { service, calls } = harness((sql) => sql.includes('delete_current_platform_account')
    ? { rows: [{ deleted_user_id: 'user-a' }] }
    : { rows: [] });
  const result = await service.delete('user-a');
  assert.equal(result.deleted, true);
  assert.deepEqual(calls[0].context, { userId: 'user-a' });
  assert.equal(calls[1].sql, 'SELECT delete_current_platform_account() AS deleted_user_id');
});

test('requires owned workspace deletion before account deletion', async () => {
  const { service } = harness(() => {
    const error = new Error('delete your owned workspace before deleting this account');
    error.code = '23503';
    throw error;
  });
  await assert.rejects(service.delete('owner-a'), /Delete your owned workspace/);
});

test('requires platform administrator access to be revoked first', async () => {
  const { service } = harness(() => {
    const error = new Error('platform administrator access must be revoked');
    error.code = '42501';
    throw error;
  });
  await assert.rejects(service.delete('admin-a'), /Platform administrator access must be revoked/);
});

test('reports an account that no longer exists', async () => {
  const { service } = harness(() => {
    const error = new Error('account was not found');
    error.code = 'P0002';
    throw error;
  });
  await assert.rejects(service.delete('missing-user'), /Account not found/);
});
