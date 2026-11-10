import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationsService } from '../dist/notifications/notifications.service.js';

function harness(rows = []) {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push({ context });
      return operation({ query: async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes('count(*)::int AS unread_count')) return { rows: [{ unread_count: 3 }], rowCount: 1 };
        if (sql.includes('RETURNING id')) return { rows: [{ id: values[0] }], rowCount: rows.length || 1 };
        return { rows, rowCount: rows.length };
      } });
    },
  };
  return { service: new NotificationsService(database), calls };
}

test('lists recipient-wide notifications with filters and grouping query', async () => {
  const { service, calls } = harness([{ id: 'n1', notification_count: 3, unread_count: 2, is_read: false }]);
  const result = await service.list('user-a', { category: 'team', unread: 'false', limit: '25' });
  assert.equal(result[0].notification_count, 3);
  assert.match(calls[1].sql, /DISTINCT ON \(grouping_key\)/);
  assert.match(calls[1].sql, /category = \$2/);
  assert.equal(calls[1].values[0], 'user-a');
});

test('reports unread count without requiring a workspace context', async () => {
  const { service, calls } = harness();
  assert.deepEqual(await service.unreadCount('user-a'), { unreadCount: 3 });
  assert.deepEqual(calls[0].context, { userId: 'user-a' });
});

test('marks individual and grouped notifications read only for their recipient', async () => {
  const { service, calls } = harness();
  await service.markRead('user-a', '11111111-1111-4111-8111-111111111111');
  await service.markGroupRead('user-a', 'provider:offline');
  assert.match(calls[1].sql, /recipient_user_id = \$2/);
  assert.match(calls[3].sql, /recipient_user_id = \$1 AND group_key = \$2/);
});

test('rejects invalid filters and unsafe notification links', async () => {
  const { service } = harness();
  await assert.rejects(service.list('user-a', { category: 'made-up' }), /Unknown notification category/);
  await assert.rejects(service.markRead('user-a', 'not-a-uuid'), /Notification ID is invalid/);
  await assert.rejects(service.createWithinTransaction({ query: async () => ({ rows: [] }) }, {
    recipientUserId: 'user-a', category: 'team', eventType: 'team.invited', title: 'Invite', href: 'https://example.com',
  }), /relative application paths/);
});

test('loads default notification preferences and persists validated user settings', async () => {
  const { service, calls } = harness();
  assert.deepEqual(await service.preferences('user-a'), { category_preferences: {}, retention_days: 90 });
  await service.updatePreferences('user-a', { categoryPreferences: { team: false }, retentionDays: 180 });
  assert.match(calls.at(-1).sql, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.deepEqual(calls.at(-1).values.slice(0, 1), ['user-a']);
});

test('rejects attempts to disable mandatory categories or choose unsupported retention', async () => {
  const { service } = harness();
  await assert.rejects(service.updatePreferences('user-a', { categoryPreferences: { security: false } }), /unsupported category/);
  await assert.rejects(service.updatePreferences('user-a', { retentionDays: 45 }), /Retention must be/);
});

test('requires a separately verified address before email opt-in', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.updateEmailSettings('user-a', { emailEnabled: true }), /Verify an email address/);
  assert.equal(calls.length, 1);
});

test('validates email address input before creating a verification request', async () => {
  const { service } = harness();
  await assert.rejects(service.requestEmailVerification('user-a', 'not-an-email'), /valid email address/);
});
