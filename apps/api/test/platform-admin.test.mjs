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
