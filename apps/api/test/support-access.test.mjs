import assert from 'node:assert/strict';
import test from 'node:test';
import { SUPPORT_ACCESS_SCOPES, SupportAccessService } from '../dist/platform-admin/support-access.service.js';

function harness(responses = {}) {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push({ context });
      return operation({
        query: async (sql, values = []) => {
          calls.push({ sql, values });
          if (sql.includes('get_workspace_technical_diagnostics')) {
            return { rows: [{ diagnostics: responses.diagnostics ?? { status: 'active' } }] };
          }
          if (sql.includes('create_workspace_support_access')) {
            return { rows: [responses.grant ?? { id: 'grant-id' }] };
          }
          if (sql.includes('read_support_workspace_content')) {
            return { rows: [{ content: responses.content ?? { workspace: { name: 'Test' } } }] };
          }
          if (sql.includes('list_workspace_support_access')) {
            return { rows: responses.grants ?? [] };
          }
          return { rows: [], rowCount: 1 };
        },
      });
    },
  };
  return { service: new SupportAccessService(database), calls };
}

const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
const grantId = '123e4567-e89b-42d3-a456-426614174001';

test('support scopes are read-only and limited to approved workspace content', () => {
  assert.deepEqual(SUPPORT_ACCESS_SCOPES, ['workspace.read', 'requests.read', 'providers.read']);
});

test('technical diagnostics do not require or return workspace content access', async () => {
  const { service, calls } = harness({ diagnostics: { status: 'active', requestCounts: { queued: 2 } } });
  assert.deepEqual(await service.diagnostics('admin-user', workspaceId), {
    status: 'active',
    requestCounts: { queued: 2 },
  });
  assert.deepEqual(calls[0].context, { userId: 'admin-user' });
  assert.match(calls[1].sql, /get_workspace_technical_diagnostics/);
});

test('support access grants require valid identity, read scopes, reason, and bounded expiry', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.create('admin-user', {
      workspaceId: 'invalid',
      scopes: ['requests.read'],
      reason: 'Support investigation',
      durationMinutes: 30,
    }),
    /valid workspace ID/,
  );
  await assert.rejects(
    service.create('admin-user', {
      workspaceId,
      scopes: ['requests.write'],
      reason: 'Support investigation',
      durationMinutes: 30,
    }),
    /valid read-only support scopes/,
  );
  await assert.rejects(
    service.create('admin-user', {
      workspaceId,
      scopes: ['requests.read'],
      reason: ' ',
      durationMinutes: 30,
    }),
    /reason between 1 and 1,000/,
  );
  await assert.rejects(
    service.create('admin-user', {
      workspaceId,
      scopes: ['requests.read'],
      reason: 'Support investigation',
      durationMinutes: 241,
    }),
    /between 5 and 240 minutes/,
  );
  assert.equal(calls.length, 0);
});

test('valid support grant uses the audited database function', async () => {
  const { service, calls } = harness({ grant: { id: grantId, scopes: ['requests.read'] } });
  const result = await service.create('admin-user', {
    workspaceId,
    scopes: ['requests.read', 'requests.read'],
    reason: 'Investigate request submission failure',
    durationMinutes: 30,
  });
  assert.deepEqual(result, { id: grantId, scopes: ['requests.read'] });
  assert.deepEqual(calls[0].context, { userId: 'admin-user' });
  assert.deepEqual(calls[1].values, [
    workspaceId,
    ['requests.read'],
    'Investigate request submission failure',
    30,
  ]);
});

test('support content reads require a valid grant identifier and use the scoped database function', async () => {
  const { service, calls } = harness({ content: { recentRequests: [] } });
  await assert.rejects(service.readContent('admin-user', 'not-a-uuid'), /valid support grant ID/);
  assert.deepEqual(await service.readContent('admin-user', grantId), { recentRequests: [] });
  assert.deepEqual(calls[0].context, { userId: 'admin-user' });
  assert.deepEqual(calls[1].values, [grantId]);
});

test('workspace owner grant listing and revocation carry verified workspace context', async () => {
  const { service, calls } = harness({ grants: [{ id: grantId, active: true }] });
  assert.deepEqual(await service.listForWorkspace('owner-user', workspaceId), [{ id: grantId, active: true }]);
  await service.revokeForWorkspace('owner-user', workspaceId, grantId, 'Support session no longer needed');
  assert.deepEqual(calls[0].context, { userId: 'owner-user', verifiedWorkspaceId: workspaceId });
  assert.deepEqual(calls[2].context, { userId: 'owner-user' });
  assert.deepEqual(calls[3].values, [workspaceId, grantId, 'Support session no longer needed']);
  await assert.rejects(
    service.revokeForWorkspace('owner-user', workspaceId, grantId, ''),
    /reason between 1 and 1,000/,
  );
});
