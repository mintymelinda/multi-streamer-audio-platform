import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeletionLedgerS3Client } from '../lib/deletion-ledger-s3.mjs';

const baseOptions = {
  endpoint: 'http://object-storage:9000',
  bucket: 'platform-deletion-ledger',
  accessKey: 'local-access',
  secretKey: 'local-secret',
  allowInsecureHttp: true,
  nodeEnv: 'test',
};

test('uploads a signed conditional-create object to the dedicated bucket', async () => {
  const calls = [];
  const client = createDeletionLedgerS3Client({
    ...baseOptions,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 200 });
    },
  });
  await client.putObject('v1/exports/123/ledger.bundle.json', '{"signed":true}', 'application/json');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /platform-deletion-ledger\/v1\/exports\/123\/ledger\.bundle\.json$/);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers['if-none-match'], '*');
  assert.match(calls[0].init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=local-access\//);
  assert.match(calls[0].init.headers['x-amz-content-sha256'], /^[a-f0-9]{64}$/);
  assert.equal(calls[0].init.body.toString(), '{"signed":true}');
});

test('downloads a signed artifact with an authenticated GET', async () => {
  const calls = [];
  const client = createDeletionLedgerS3Client({
    ...baseOptions,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('artifact-bytes', { status: 200 });
    },
  });
  const artifact = await client.getObject('v1/exports/123/ledger.bundle.json');
  assert.equal(artifact.toString(), 'artifact-bytes');
  assert.equal(calls[0].init.method, 'GET');
  assert.match(calls[0].init.headers.Authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(calls[0].init.headers['if-none-match'], undefined);
});

test('rejects insecure remote endpoints in production even with the development opt-in', () => {
  assert.throws(
    () => createDeletionLedgerS3Client({ ...baseOptions, nodeEnv: 'production' }),
    /must use HTTPS/,
  );
});

test('refuses to overwrite an existing immutable export object', async () => {
  const client = createDeletionLedgerS3Client({
    ...baseOptions,
    fetchImpl: async () => new Response(null, { status: 412 }),
  });
  await assert.rejects(
    client.putObject('v1/exports/123/ledger.bundle.json', 'artifact'),
    /refusing to overwrite/,
  );
});

test('fails when an export object cannot be downloaded', async () => {
  const client = createDeletionLedgerS3Client({
    ...baseOptions,
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  await assert.rejects(client.getObject('v1/exports/missing/ledger.bundle.json'), /failed \(404\)/);
});
