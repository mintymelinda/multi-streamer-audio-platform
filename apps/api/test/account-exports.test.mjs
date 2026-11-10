import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountExportsService } from '../dist/account-exports/account-exports.service.js';

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
  return { service: new AccountExportsService(database), calls };
}

test('queues a personal account export under the authenticated user context', async () => {
  const { service, calls } = harness((sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes("status IN ('queued', 'processing')")) return { rows: [] };
    if (sql.includes("requested_at > now()")) return { rows: [] };
    if (sql.includes('INSERT INTO user_data_exports')) return { rows: [{ id: 'export-1', status: 'queued' }] };
    return { rows: [] };
  });
  const result = await service.request('user-a');
  assert.equal(result.export.id, 'export-1');
  assert.equal(result.reused, false);
  assert.deepEqual(calls[0].context, { userId: 'user-a' });
  assert.ok(calls.some((call) => call.sql?.includes('pg_advisory_xact_lock')));
});

test('reuses an active export instead of creating competing jobs', async () => {
  const { service, calls } = harness((sql) => sql.includes("status IN ('queued', 'processing')")
    ? { rows: [{ id: 'export-active', status: 'processing' }] }
    : { rows: [] });
  const result = await service.request('user-a');
  assert.equal(result.export.id, 'export-active');
  assert.equal(result.reused, true);
  assert.equal(calls.some((call) => call.sql?.includes('INSERT INTO user_data_exports')), false);
});

test('rate limits repeated export requests', async () => {
  const { service } = harness((sql) => sql.includes("status IN ('queued', 'processing')")
    ? { rows: [] }
    : sql.includes('requested_at > now()') ? { rows: [{ id: 'recent' }] } : { rows: [] });
  await assert.rejects(service.request('user-a'), /one account export every 24 hours/);
});

test('lists export metadata without selecting private export payloads', async () => {
  const { service, calls } = harness(() => ({ rows: [{ id: 'export-1', status: 'completed' }] }));
  const result = await service.list('user-a');
  assert.equal(result[0].id, 'export-1');
  assert.ok(!calls[1].sql.includes('export_data'));
  assert.deepEqual(calls[0].context, { userId: 'user-a' });
});

test('downloads only a completed, unexpired export and records the download', async () => {
  const { service, calls } = harness((sql) => sql.includes('SELECT id, status, export_data')
    ? { rows: [{ id: 'export-1', status: 'completed', expires_at: new Date(Date.now() + 60_000), export_data: { format: 'account-export' } }] }
    : { rows: [] });
  const result = await service.download('user-a', '11111111-1111-4111-8111-111111111111');
  assert.equal(result.data.format, 'account-export');
  assert.ok(calls.some((call) => call.sql?.includes('SET downloaded_at = now()')));
});

test('refuses downloads that are not ready or have expired', async () => {
  const pending = harness((sql) => sql.includes('SELECT id, status, export_data')
    ? { rows: [{ id: 'export-1', status: 'processing', export_data: null }] } : { rows: [] });
  await assert.rejects(pending.service.download('user-a', '11111111-1111-4111-8111-111111111111'), /not ready/);
  const expired = harness((sql) => sql.includes('SELECT id, status, export_data')
    ? { rows: [{ id: 'export-1', status: 'expired', export_data: null }] } : { rows: [] });
  await assert.rejects(expired.service.download('user-a', '11111111-1111-4111-8111-111111111111'), /expired/);
});

test('rejects malformed export identifiers before querying the database', async () => {
  const { service, calls } = harness(() => ({ rows: [] }));
  await assert.rejects(service.download('user-a', 'not-a-uuid'), /Export ID is invalid/);
  assert.equal(calls.length, 0);
});
