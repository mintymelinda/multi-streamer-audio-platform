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
  assert.ok(calls.some((call) => call.sql?.includes('verified_at')));
});

test('validates email address input before creating a verification request', async () => {
  const { service } = harness();
  await assert.rejects(service.requestEmailVerification('user-a', 'not-an-email'), /valid email address/);
});

test('queues email verification without exposing an email permission in Twitch sign-in', async () => {
  const { service, calls } = harness();
  const result = await service.requestEmailVerification('user-a', ' Person@Example.com ');
  assert.deepEqual(result, { verificationQueued: true, expiresInSeconds: 1800 });
  assert.ok(calls.some((call) => call.sql?.includes('pg_advisory_xact_lock')));
  const outbox = calls.find((call) => call.sql?.includes('INSERT INTO email_outbox'));
  assert.ok(outbox);
  assert.equal(outbox.values[1], 'person@example.com');
  assert.match(outbox.values[4], /^email-verification:user-a:/);
});

test('rejects invalid verification tokens and email preference keys', async () => {
  const { service } = harness();
  await assert.rejects(service.verifyEmailAddress('user-a', 'bad'), /invalid or expired/);
  await assert.rejects(service.updateEmailSettings('user-a', { categoryPreferences: { unknown: true } }), /unsupported value/);
  await assert.rejects(service.updateEmailSettings('user-a', { priorityPreferences: { urgent: true } }), /unsupported value/);
});


test('uses a five-minute group window and claims recipient-scoped deduplication keys', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('INSERT INTO user_notification_deduplication')) return { rows: [{ notification_id: 'notification-1' }], rowCount: 1 };
    if (sql.includes('INSERT INTO user_notifications')) return { rows: [{ id: 'notification-1' }], rowCount: 1 };
    return { rows: [] };
  } };
  const { service } = harness();
  await service.createWithinTransaction(client, {
    recipientUserId: 'user-a', category: 'team', eventType: 'team.invited', title: 'Invitation',
    groupKey: 'team:invites', dedupeKey: 'invite:event-123',
  });
  const claim = calls.find((call) => call.sql.includes('INSERT INTO user_notification_deduplication'));
  const notification = calls.find((call) => call.sql.includes('INSERT INTO user_notifications'));
  assert.ok(claim);
  assert.ok(claim.sql.includes('ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING'));
  assert.equal(claim.values[0], 'user-a');
  assert.equal(claim.values[1], null);
  assert.equal(claim.values[2], 'invite:event-123');
  assert.match(claim.values[3], /^[0-9a-f-]{36}$/i);
  assert.ok(notification);
  assert.ok(notification.sql.includes('floor(extract(epoch FROM now()) / 300)'));
});

test('suppresses duplicate notification delivery before inserting inbox or email rows', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('INSERT INTO user_notification_deduplication')) return { rows: [], rowCount: 0 };
    return { rows: [] };
  } };
  const { service } = harness();
  const result = await service.createWithinTransaction(client, {
    recipientUserId: 'user-a', category: 'team', eventType: 'team.invited', title: 'Invitation',
    dedupeKey: 'invite:event-123',
  });
  assert.equal(result.duplicate, true);
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO user_notifications')).length, 0);
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO email_outbox')).length, 0);
});

test('returns delivery status with the recipient notification list', async () => {
  const { service, calls } = harness([{ id: 'n1', email_delivery_status: 'pending', email_delivery_attempt_count: 2 }]);
  const result = await service.list('user-a');
  assert.equal(result[0].email_delivery_status, 'pending');
  assert.match(calls[1].sql, /LEFT JOIN LATERAL/);
  assert.match(calls[1].sql, /notification_id = latest.id/);
});

test('marks only the selected five-minute notification group as read', async () => {
  const { service, calls } = harness();
  await service.markGroupRead('user-a', 'provider:offline', 5900000);
  assert.match(calls[1].sql, /group_window = \$3/);
  assert.deepEqual(calls[1].values, ['user-a', 'provider:offline', 5900000]);
});
