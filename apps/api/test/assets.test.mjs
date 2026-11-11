import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetsService } from '../dist/assets/assets.service.js';

function serviceHarness(queryHandler = async () => ({ rows: [], rowCount: 1 })) {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push({ context });
      return operation({
        query: async (sql, values = []) => {
          calls.push({ sql, values });
          return queryHandler(sql, values);
        },
      });
    },
  };
  const storage = {
    presign: (method, key, contentType, expires, internal) => `https://assets.example.test/${method}/${key}?type=${contentType ?? ''}&internal=${Boolean(internal)}`,
    delete: async () => undefined,
  };
  return { service: new AssetsService(database, storage), calls };
}

test('creates workspace-scoped upload intents with opaque object keys and constrained MIME types', async () => {
  const { service, calls } = serviceHarness();
  const result = await service.createUpload('workspace-a', 'user-a', {
    name: '  Stream Logo.png  ',
    folder: 'branding/stream',
    contentType: 'image/png',
  });
  assert.equal(result.method, 'PUT');
  assert.equal(result.headers['Content-Type'], 'image/png');
  assert.match(result.uploadUrl, /^https:\/\/assets\.example\.test\/PUT\/workspace-a\//);
  assert.equal(calls[0].context.userId, 'user-a');
  assert.equal(calls[0].context.verifiedWorkspaceId, 'workspace-a');
  const insert = calls.find((call) => call.sql?.includes('INSERT INTO workspace_assets'));
  assert.equal(insert.values[2], 'Stream Logo.png');
  assert.equal(insert.values[3], 'branding/stream');
  assert.ok(!insert.values[4].includes('..'));
});

test('rejects unsupported content types before writing an upload record', async () => {
  const { service, calls } = serviceHarness();
  await assert.rejects(
    service.createUpload('workspace-a', 'user-a', { name: 'payload.svg', contentType: 'image/svg+xml' }),
    /Only PNG, JPEG, WebP, and GIF/,
  );
  assert.equal(calls.length, 0);
});

test('rejects unsafe folder traversal', async () => {
  const { service, calls } = serviceHarness();
  await assert.rejects(
    service.createUpload('workspace-a', 'user-a', { name: 'logo.png', folder: '../other', contentType: 'image/png' }),
    /Folder path is invalid/,
  );
  assert.equal(calls.length, 0);
});

test('refuses to delete assets that remain referenced by scene drafts or publications', async () => {
  const { service } = serviceHarness(async (sql) => {
    if (sql.includes('FROM overlay_scenes')) {
      return { rows: [{ id: 'scene-a', name: 'Starting Soon', draft_used: true, published_used: false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  await assert.rejects(service.remove('workspace-a', 'user-a', 'asset-a'), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /still used/);
    assert.equal(error.response.usage[0].sceneName, 'Starting Soon');
    return true;
  });
});
