import test from 'node:test';
import assert from 'node:assert/strict';
import { DeletionLedgerService } from '../dist/deletion-ledger/deletion-ledger.service.js';

const workspaceId = '72000000-0000-4000-8000-000000000001';

function configureLedger() {
  process.env.DELETION_LEDGER_INTERNAL_ENDPOINT = 'http://127.0.0.1:9000';
  process.env.DELETION_LEDGER_BUCKET = 'deletion-ledger';
  process.env.DELETION_LEDGER_ACCESS_KEY = 'test-access';
  process.env.DELETION_LEDGER_SECRET_KEY = 'test-secret';
  process.env.DELETION_LEDGER_REGION = 'us-east-1';
}

test('deletion ledger writes one immutable workspace tombstone', async () => {
  configureLedger();
  const calls = [];
  const service = new DeletionLedgerService(async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === 'HEAD') return new Response(null, { status: 404 });
    return new Response(null, { status: 200 });
  });

  await service.append('workspace', workspaceId);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'HEAD');
  assert.equal(calls[1].init.method, 'PUT');
  assert.equal(calls[1].init.headers['If-None-Match'], '*');
  const record = JSON.parse(calls[1].init.body);
  assert.equal(record.format, 'multi-streamer-audio-platform.deletion-tombstone');
  assert.equal(record.version, 1);
  assert.equal(record.entityType, 'workspace');
  assert.equal(record.entityId, workspaceId);
  assert.ok(Number.isFinite(Date.parse(record.deletedAt)));
  assert.match(calls[1].url, /X-Amz-Signature=/);
});

test('deletion ledger treats an existing tombstone as an idempotent success', async () => {
  configureLedger();
  let calls = 0;
  const service = new DeletionLedgerService(async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  });
  await service.append('account', workspaceId);
  assert.equal(calls, 1);
});

test('deletion ledger fails closed when storage is not configured', async () => {
  delete process.env.DELETION_LEDGER_INTERNAL_ENDPOINT;
  delete process.env.DELETION_LEDGER_ENDPOINT;
  delete process.env.DELETION_LEDGER_BUCKET;
  delete process.env.DELETION_LEDGER_ACCESS_KEY;
  delete process.env.DELETION_LEDGER_SECRET_KEY;
  const service = new DeletionLedgerService(async () => new Response(null, { status: 404 }));
  await assert.rejects(service.append('account', workspaceId), /not configured/);
});

test('deletion ledger rejects invalid identities without writing', async () => {
  configureLedger();
  let calls = 0;
  const service = new DeletionLedgerService(async () => {
    calls += 1;
    return new Response(null, { status: 404 });
  });
  await assert.rejects(service.append('account', 'not-a-uuid'), /UUID/);
  assert.equal(calls, 0);
});
