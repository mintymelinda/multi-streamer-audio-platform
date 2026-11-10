import assert from 'node:assert/strict';
import test from 'node:test';
import { accountExportRetryDelaySeconds, buildAccountExportDocument } from '../dist/account-export.service.js';

test('exports only explicitly selected personal account fields and states its exclusions', () => {
  const document = buildAccountExportDocument({
    account: { id: 'user-1', twitch_user_id: '123', status: 'active' },
    memberships: [{ workspace_id: 'workspace-1', role: 'moderator' }],
    receivedInvitations: [{ workspace_id: 'workspace-2', assigned_role: 'viewer' }],
    notifications: [{ id: 'notification-1', title: 'Welcome' }],
    notificationPreferences: { retention_days: 90 },
    emailPreferences: { email_address: 'user@example.test', email_enabled: true },
    exportedAt: '2026-11-10T12:00:00.000Z',
  });
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.scope, 'personal-account-data');
  assert.equal(document.account.twitch_user_id, '123');
  assert.equal(document.emailNotificationPreferences.email_address, 'user@example.test');
  assert.equal(Object.hasOwn(document, 'sessions'), false);
  assert.ok(document.exclusions.some((value) => value.includes('credential material')));
});

test('uses bounded retry delays for failed export jobs', () => {
  assert.equal(accountExportRetryDelaySeconds(1), 30);
  assert.equal(accountExportRetryDelaySeconds(2), 60);
  assert.equal(accountExportRetryDelaySeconds(20), 3600);
});
