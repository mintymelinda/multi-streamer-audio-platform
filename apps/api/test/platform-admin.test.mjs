import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_PERMISSIONS, PlatformAdminService } from '../dist/platform-admin/platform-admin.service.js';

function harness(responses = {}) {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push({ context });
      return operation({
        query: async (sql, values = []) => {
          calls.push({ sql, values });
          if (sql.includes('get_current_platform_administrator')) {
            return { rows: responses.access ?? [], rowCount: responses.access?.length ?? 0 };
          }
          if (sql.includes('list_platform_administrators')) {
            return { rows: responses.administrators ?? [], rowCount: responses.administrators?.length ?? 0 };
          }
          if (sql.includes('list_platform_accounts')) {
            return { rows: responses.accounts ?? [], rowCount: responses.accounts?.length ?? 0 };
          }
          if (sql.includes('list_platform_workspaces')) {
            return { rows: responses.workspaces ?? [], rowCount: responses.workspaces?.length ?? 0 };
          }
          return { rows: [], rowCount: 1 };
        },
      });
    },
  };
  return { service: new PlatformAdminService(database), calls };
}

test('platform owner access resolves the complete permission set', async () => {
  const { service } = harness({ access: [{ role: 'owner', permissions: [] }] });
  const result = await service.access('owner-user');
  assert.equal(result.isPlatformAdministrator, true);
  assert.equal(result.role, 'owner');
  assert.deepEqual(result.permissions, [...PLATFORM_PERMISSIONS]);
});

test('ordinary workspace users receive no platform permissions', async () => {
  const { service } = harness();
  assert.deepEqual(await service.access('workspace-user'), {
    isPlatformAdministrator: false,
    role: null,
    permissions: [],
  });
});

test('administrator directory reads use the permission-checked database function', async () => {
  const assignment = {
    user_id: 'admin-user',
    twitch_user_id: '123456',
    role: 'admin',
    permissions: ['administrators.read'],
    appointed_at: new Date(),
    revoked_at: null,
  };
  const { service, calls } = harness({ administrators: [assignment] });
  assert.deepEqual(await service.listAdministrators('owner-user'), [assignment]);
  assert.deepEqual(calls[0].context, { userId: 'owner-user' });
  assert.ok(calls.some((call) => call.sql?.includes('list_platform_administrators()')));
  assert.ok(!calls.some((call) => call.sql?.includes('FROM platform_administrators')));
});

test('appointments use stable Twitch identity and the audited database function', async () => {
  const { service, calls } = harness();
  await service.appoint('owner-user', {
    twitchUserId: '123456',
    role: 'admin',
    permissions: ['administrators.read'],
    reason: 'Support operations coverage',
  });
  assert.deepEqual(calls[0].context, { userId: 'owner-user' });
  const appointment = calls.find((call) => call.sql?.includes('appoint_platform_administrator'));
  assert.deepEqual(appointment.values, [
    '123456',
    'admin',
    ['administrators.read'],
    'Support operations coverage',
  ]);
});

test('invalid appointment input is rejected before opening a database transaction', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.appoint('owner-user', {
      twitchUserId: 'not-a-numeric-id',
      role: 'admin',
      permissions: [],
      reason: 'Invalid identity',
    }),
    /numeric Twitch user ID/,
  );
  await assert.rejects(
    service.appoint('owner-user', {
      twitchUserId: '123456',
      role: 'admin',
      permissions: ['not-a-platform-permission'],
      reason: 'Invalid permission',
    }),
    /permissions are invalid/,
  );
  await assert.rejects(
    service.appoint('owner-user', {
      twitchUserId: '123456',
      role: 'admin',
      permissions: [],
      reason: ' ',
    }),
    /reason between 1 and 1,000/,
  );
  assert.equal(calls.length, 0);
});

test('revocation uses the audited database function and requires a reason', async () => {
  const { service, calls } = harness();
  await service.revoke('owner-user', '123e4567-e89b-12d3-a456-426614174000', 'Role no longer required');
  const revocation = calls.find((call) => call.sql?.includes('revoke_platform_administrator'));
  assert.deepEqual(revocation.values, [
    '123e4567-e89b-12d3-a456-426614174000',
    'Role no longer required',
  ]);
  await assert.rejects(
    service.revoke('owner-user', '123e4567-e89b-12d3-a456-426614174000', ''),
    /reason between 1 and 1,000/,
  );
});

test('platform account directory uses the permission-checked database function', async () => {
  const account = { user_id: 'account-id', twitch_user_id: '123456', status: 'active' };
  const { service, calls } = harness({ accounts: [account] });
  assert.deepEqual(await service.listAccounts('admin-user', '123456'), [account]);
  assert.deepEqual(calls[0].context, { userId: 'admin-user' });
  assert.deepEqual(calls[1].values, ['123456']);
  assert.match(calls[1].sql, /list_platform_accounts/);
});

test('platform workspace directory uses the permission-checked database function', async () => {
  const workspace = { workspace_id: 'workspace-id', name: 'Test workspace', status: 'active' };
  const { service, calls } = harness({ workspaces: [workspace] });
  assert.deepEqual(await service.listWorkspaces('admin-user'), [workspace]);
  assert.deepEqual(calls[0].context, { userId: 'admin-user' });
  assert.deepEqual(calls[1].values, [null]);
  assert.match(calls[1].sql, /list_platform_workspaces/);
});

test('account suspension and reinstatement use audited database transitions', async () => {
  const { service, calls } = harness();
  const targetId = '123e4567-e89b-42d3-a456-426614174000';
  await service.setAccountStatus('admin-user', targetId, 'suspended', 'Abuse investigation');
  await service.setAccountStatus('admin-user', targetId, 'active', 'Investigation concluded');
  assert.deepEqual(calls.filter((call) => call.sql?.includes('set_platform_account_status')).map((call) => call.values), [
    [targetId, 'suspended', 'Abuse investigation'],
    [targetId, 'active', 'Investigation concluded'],
  ]);
  assert.deepEqual(calls[0].context, { userId: 'admin-user' });
});

test('workspace restriction, suspension, and restoration use audited database transitions', async () => {
  const { service, calls } = harness();
  const workspaceId = '123e4567-e89b-42d3-a456-426614174001';
  await service.setWorkspaceStatus('admin-user', workspaceId, 'restricted', 'Policy review');
  await service.setWorkspaceStatus('admin-user', workspaceId, 'suspended', 'Continued abuse');
  await service.setWorkspaceStatus('admin-user', workspaceId, 'active', 'Review completed');
  assert.deepEqual(calls.filter((call) => call.sql?.includes('set_platform_workspace_status')).map((call) => call.values), [
    [workspaceId, 'restricted', 'Policy review'],
    [workspaceId, 'suspended', 'Continued abuse'],
    [workspaceId, 'active', 'Review completed'],
  ]);
});

test('restriction operations reject invalid targets, states, and missing reasons before database access', async () => {
  const { service, calls } = harness();
  const validId = '123e4567-e89b-42d3-a456-426614174000';
  await assert.rejects(service.setAccountStatus('admin-user', 'not-a-uuid', 'suspended', 'Reason'), /valid target account/);
  await assert.rejects(service.setAccountStatus('admin-user', validId, 'restricted', 'Reason'), /Account status/);
  await assert.rejects(service.setAccountStatus('admin-user', validId, 'suspended', ' '), /reason between 1 and 1,000/);
  await assert.rejects(service.setWorkspaceStatus('admin-user', validId, 'deleted', 'Reason'), /Workspace status/);
  await assert.rejects(service.setWorkspaceStatus('admin-user', validId, 'suspended', ''), /reason between 1 and 1,000/);
  assert.equal(calls.length, 0);
});
