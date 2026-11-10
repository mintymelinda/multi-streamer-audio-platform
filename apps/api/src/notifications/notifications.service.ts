import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';

const CATEGORIES = ['account', 'platform', 'security', 'team', 'provider', 'playback', 'queue', 'system'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;

export type NotificationFilters = {
  category?: string;
  priority?: string;
  workspaceId?: string;
  unread?: string | boolean;
  limit?: string | number;
  offset?: string | number;
};

function boundedInteger(value: string | number | undefined, fallback: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw new BadRequestException('Pagination values must be non-negative integers.');
  return Math.min(parsed, maximum);
}

function addFilter(values: unknown[], clauses: string[], expression: string, value: unknown) {
  values.push(value);
  clauses.push(expression.replace('?', '$' + values.length));
}

@Injectable()
export class NotificationsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(userId: string, filters: NotificationFilters = {}) {
    const values: unknown[] = [userId];
    const clauses = ['recipient_user_id = $1'];
    if (filters.category) {
      if (!(CATEGORIES as readonly string[]).includes(filters.category)) throw new BadRequestException('Unknown notification category.');
      addFilter(values, clauses, 'category = ?', filters.category);
    }
    if (filters.priority) {
      if (!(PRIORITIES as readonly string[]).includes(filters.priority)) throw new BadRequestException('Unknown notification priority.');
      addFilter(values, clauses, 'priority = ?', filters.priority);
    }
    if (filters.workspaceId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(filters.workspaceId)) {
        throw new BadRequestException('Workspace filter is invalid.');
      }
      addFilter(values, clauses, 'workspace_id = ?', filters.workspaceId);
    }
    if (filters.unread === true || filters.unread === 'true') clauses.push('read_at IS NULL');
    const limit = boundedInteger(filters.limit, 50, 100);
    const offset = boundedInteger(filters.offset, 0, 10000);
    values.push(limit, offset);
    const result = await this.database.transaction({ userId }, (client) => client.query(
      `WITH filtered AS (
        SELECT *, CASE WHEN group_key IS NULL THEN 'notification:' || id::text ELSE 'group:' || group_key || ':' || group_window::text END AS grouping_key
        FROM user_notifications WHERE ${clauses.join(' AND ')}
      ), latest AS (
        SELECT DISTINCT ON (grouping_key) grouping_key, id, workspace_id, category, priority, event_type,
          title, body, href, group_key, group_window::integer AS group_window, created_at
        FROM filtered ORDER BY grouping_key, created_at DESC, id DESC
      ), totals AS (
        SELECT grouping_key, count(*)::int AS notification_count,
          count(*) FILTER (WHERE read_at IS NULL)::int AS unread_count
        FROM filtered GROUP BY grouping_key
      )
      SELECT latest.*, totals.notification_count, totals.unread_count,
        (totals.unread_count = 0) AS is_read,
        delivery.status AS email_delivery_status,
        delivery.attempt_count AS email_delivery_attempt_count,
        delivery.next_attempt_at AS email_delivery_next_attempt_at,
        delivery.sent_at AS email_delivery_sent_at
      FROM latest JOIN totals USING (grouping_key)
      LEFT JOIN LATERAL (
        SELECT status, attempt_count, next_attempt_at, sent_at
          FROM email_outbox WHERE notification_id = latest.id
         ORDER BY created_at DESC LIMIT 1
      ) delivery ON true
      ORDER BY latest.created_at DESC, latest.id DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    ));
    return result.rows;
  }

  async preferences(userId: string) {
    const result = await this.database.transaction({ userId }, (client) =>
      client.query(
        `SELECT category_preferences, retention_days FROM user_notification_preferences WHERE user_id = $1`,
        [userId],
      ),
    );
    return result.rows[0] ?? { category_preferences: {}, retention_days: 90 };
  }

  async updatePreferences(userId: string, input: { categoryPreferences?: unknown; retentionDays?: unknown }) {
    const allowed = ['platform', 'team', 'provider', 'playback', 'queue', 'system'];
    const current = await this.preferences(userId) as { category_preferences: Record<string, boolean>; retention_days: number };
    const categories = { ...current.category_preferences };
    if (input.categoryPreferences !== undefined) {
      if (typeof input.categoryPreferences !== 'object' || input.categoryPreferences === null || Array.isArray(input.categoryPreferences)) {
        throw new BadRequestException('Category preferences must be an object.');
      }
      for (const [category, enabled] of Object.entries(input.categoryPreferences as Record<string, unknown>)) {
        if (!allowed.includes(category) || typeof enabled !== 'boolean') {
          throw new BadRequestException('Category preferences contain an unsupported category or value.');
        }
        categories[category] = enabled;
      }
    }
    const retentionDays = input.retentionDays === undefined ? current.retention_days : input.retentionDays;
    if (![30, 90, 180, 365].includes(retentionDays as number)) {
      throw new BadRequestException('Retention must be 30, 90, 180, or 365 days.');
    }
    const result = await this.database.transaction({ userId }, (client) =>
      client.query(
        `INSERT INTO user_notification_preferences (user_id, category_preferences, retention_days, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (user_id) DO UPDATE SET category_preferences = EXCLUDED.category_preferences,
           retention_days = EXCLUDED.retention_days, updated_at = now()
         RETURNING category_preferences, retention_days`,
        [userId, JSON.stringify(categories), retentionDays],
      ),
    );
    return result.rows[0];
  }


  async emailSettings(userId: string) {
    const result = await this.database.transaction({ userId }, (client) =>
      client.query(`SELECT email_address, verified_at, email_enabled, category_preferences, priority_preferences
        FROM user_notification_email_settings WHERE user_id = $1`, [userId]),
    );
    const row = result.rows[0];
    if (!row) return { emailAddress: null, verified: false, emailEnabled: false, categoryPreferences: {}, priorityPreferences: {} };
    const address = row.email_address ? String(row.email_address) : null;
    const parts = address?.split('@') ?? [];
    const local = parts[0] ?? '';
    const domain = parts[1] ?? '';
    const masked = address ? (local.length < 3 ? `${local[0] ?? '*'}***@${domain}` : `${local.slice(0, 2)}***@${domain}`) : null;
    return { emailAddress: masked, verified: Boolean(row.verified_at), emailEnabled: row.email_enabled,
      categoryPreferences: row.category_preferences, priorityPreferences: row.priority_preferences };
  }

  async requestEmailVerification(userId: string, rawAddress: unknown) {
    if (typeof rawAddress !== 'string') throw new BadRequestException('Enter a valid email address.');
    const emailAddress = rawAddress.trim().toLowerCase();
    if (emailAddress.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
      throw new BadRequestException('Enter a valid email address.');
    }
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.database.transaction({ userId }, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
      const previous = await client.query<{ verification_requested_at: Date | null }>(
        'SELECT verification_requested_at FROM user_notification_email_settings WHERE user_id = $1 FOR UPDATE', [userId],
      );
      if (previous.rows[0]?.verification_requested_at &&
          Date.now() - new Date(previous.rows[0].verification_requested_at).getTime() < 60_000) {
        throw new BadRequestException('Please wait before requesting another verification email.');
      }
      await client.query(
        `INSERT INTO user_notification_email_settings
          (user_id, email_address, verified_at, verification_token_hash, verification_expires_at,
           verification_requested_at, email_enabled, updated_at)
         VALUES ($1, $2, NULL, $3, now() + interval '30 minutes', now(), false, now())
         ON CONFLICT (user_id) DO UPDATE SET email_address = EXCLUDED.email_address, verified_at = NULL,
           verification_token_hash = EXCLUDED.verification_token_hash,
           verification_expires_at = EXCLUDED.verification_expires_at,
           verification_requested_at = now(), email_enabled = false, updated_at = now()`,
        [userId, emailAddress, tokenHash],
      );
      await client.query(
        `INSERT INTO email_outbox (user_id, recipient_email, subject, text_body, html_body, unique_key)
         VALUES ($1, $2, 'Verify your notification email', $3, $4, $5)
         ON CONFLICT (unique_key) DO NOTHING`,
        [userId, emailAddress, `Your email verification code is:\\n\\n${token}\\n\\nIt expires in 30 minutes. If you did not request this, ignore this email.`,
          `<p>Your email verification code is:</p><p><strong>${token}</strong></p><p>It expires in 30 minutes. If you did not request this, ignore this email.</p>`,
          `email-verification:${userId}:${tokenHash}`],
      );
    });
    return { verificationQueued: true, expiresInSeconds: 1800 };
  }

  async verifyEmailAddress(userId: string, rawToken: unknown) {
    if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(rawToken)) {
      throw new BadRequestException('The verification code is invalid or expired.');
    }
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const result = await this.database.transaction({ userId }, (client) => client.query(
      `UPDATE user_notification_email_settings SET verified_at = now(), verification_token_hash = NULL,
         verification_expires_at = NULL, email_enabled = false, updated_at = now()
       WHERE user_id = $1 AND verification_token_hash = $2 AND verification_expires_at > now()
       RETURNING email_address`,
      [userId, tokenHash],
    ));
    if (!result.rowCount) throw new BadRequestException('The verification code is invalid or expired.');
    return { verified: true };
  }

  async updateEmailSettings(userId: string, input: { emailEnabled?: unknown; categoryPreferences?: unknown; priorityPreferences?: unknown }) {
    const categories = ['account', 'platform', 'security', 'team', 'provider', 'playback', 'queue', 'system'];
    const priorities = ['low', 'normal', 'high', 'critical'];
    const currentResult = await this.database.transaction({ userId }, (client) => client.query(
      'SELECT email_address, verified_at, email_enabled, category_preferences, priority_preferences FROM user_notification_email_settings WHERE user_id = $1',
      [userId],
    ));
    const current = currentResult.rows[0];
    const categoryPreferences = { ...(current?.category_preferences ?? {}) } as Record<string, boolean>;
    const priorityPreferences = { ...(current?.priority_preferences ?? {}) } as Record<string, boolean>;
    for (const [source, target, allowed] of [
      [input.categoryPreferences, categoryPreferences, categories],
      [input.priorityPreferences, priorityPreferences, priorities],
    ] as const) {
      if (source === undefined) continue;
      if (typeof source !== 'object' || source === null || Array.isArray(source)) throw new BadRequestException('Email preferences must be objects.');
      for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        const allowedValues: readonly string[] = allowed;
        if (!allowedValues.includes(key) || typeof value !== 'boolean') throw new BadRequestException('Email preferences contain an unsupported value.');
        target[key] = value;
      }
    }
    const enabled = input.emailEnabled === undefined ? Boolean(current?.email_enabled) : input.emailEnabled;
    if (typeof enabled !== 'boolean') throw new BadRequestException('Email notifications must be enabled or disabled.');
    if (enabled && !current?.verified_at) throw new BadRequestException('Verify an email address before enabling email notifications.');
    const result = await this.database.transaction({ userId }, (client) => client.query(
      `INSERT INTO user_notification_email_settings
        (user_id, email_address, email_enabled, category_preferences, priority_preferences, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET email_enabled = EXCLUDED.email_enabled,
         category_preferences = EXCLUDED.category_preferences, priority_preferences = EXCLUDED.priority_preferences,
         updated_at = now()
       RETURNING email_enabled, category_preferences, priority_preferences, verified_at`,
      [userId, current?.email_address ?? null, enabled, JSON.stringify(categoryPreferences), JSON.stringify(priorityPreferences)],
    ));
    const row = result.rows[0];
    return { emailEnabled: row.email_enabled, verified: Boolean(row.verified_at),
      categoryPreferences: row.category_preferences, priorityPreferences: row.priority_preferences };
  }

  async unreadCount(userId: string) {
    const result = await this.database.transaction({ userId }, (client) =>
      client.query<{ unread_count: number }>('SELECT count(*)::int AS unread_count FROM user_notifications WHERE recipient_user_id = $1 AND read_at IS NULL', [userId]),
    );
    return { unreadCount: result.rows[0]?.unread_count ?? 0 };
  }

  async markRead(userId: string, notificationId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(notificationId)) {
      throw new BadRequestException('Notification ID is invalid.');
    }
    const result = await this.database.transaction({ userId }, (client) =>
      client.query('UPDATE user_notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND recipient_user_id = $2 RETURNING id', [notificationId, userId]),
    );
    if (!result.rowCount) throw new NotFoundException('Notification not found.');
    return { id: notificationId, read: true };
  }

  async markGroupRead(userId: string, groupKey: unknown, groupWindow?: unknown) {
    if (typeof groupKey !== 'string' || groupKey.length < 1 || groupKey.length > 160) {
      throw new BadRequestException('Notification group key is invalid.');
    }
    if (groupWindow !== undefined && (!Number.isSafeInteger(groupWindow) || Number(groupWindow) < 0)) {
      throw new BadRequestException('Notification group window is invalid.');
    }
    const result = await this.database.transaction({ userId }, (client) =>
      groupWindow === undefined
        ? client.query('UPDATE user_notifications SET read_at = COALESCE(read_at, now()) WHERE recipient_user_id = $1 AND group_key = $2 AND read_at IS NULL RETURNING id', [userId, groupKey])
        : client.query('UPDATE user_notifications SET read_at = COALESCE(read_at, now()) WHERE recipient_user_id = $1 AND group_key = $2 AND group_window = $3 AND read_at IS NULL RETURNING id', [userId, groupKey, groupWindow]),
    );
    return { markedRead: result.rowCount ?? 0 };
  }

  async markAllRead(userId: string, filters: Pick<NotificationFilters, 'category' | 'priority' | 'workspaceId'> = {}) {
    const values: unknown[] = [userId];
    const clauses = ['recipient_user_id = $1', 'read_at IS NULL'];
    if (filters.category) {
      if (!(CATEGORIES as readonly string[]).includes(filters.category)) throw new BadRequestException('Unknown notification category.');
      addFilter(values, clauses, 'category = ?', filters.category);
    }
    if (filters.priority) {
      if (!(PRIORITIES as readonly string[]).includes(filters.priority)) throw new BadRequestException('Unknown notification priority.');
      addFilter(values, clauses, 'priority = ?', filters.priority);
    }
    if (filters.workspaceId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(filters.workspaceId)) throw new BadRequestException('Workspace filter is invalid.');
      addFilter(values, clauses, 'workspace_id = ?', filters.workspaceId);
    }
    const result = await this.database.transaction({ userId }, (client) =>
      client.query(`UPDATE user_notifications SET read_at = now() WHERE ${clauses.join(' AND ')} RETURNING id`, values),
    );
    return { markedRead: result.rowCount ?? 0 };
  }

  // Producers call this inside the same transaction as the business event.
  // The recipient is explicit; workspace membership is not used as a visibility grant.
  async createWithinTransaction(client: PoolClient, input: {
    recipientUserId: string; workspaceId?: string | null; category: typeof CATEGORIES[number];
    priority?: typeof PRIORITIES[number]; eventType: string; title: string; body?: string;
    href?: string | null; groupKey?: string | null; dedupeKey?: string | null;
  }) {
    if (!['account', 'security'].includes(input.category)) {
      const preference = await client.query<{ enabled: boolean | null }>(
        `SELECT (category_preferences ->> $2)::boolean AS enabled
           FROM user_notification_preferences WHERE user_id = $1`,
        [input.recipientUserId, input.category],
      );
      if (preference.rows[0]?.enabled === false) return { rows: [], rowCount: 0 };
    }
    if (input.href && (!input.href.startsWith('/') || input.href.startsWith('//'))) {
      throw new BadRequestException('Notification links must be relative application paths.');
    }
    if (input.dedupeKey !== undefined && input.dedupeKey !== null &&
        (typeof input.dedupeKey !== 'string' || input.dedupeKey.length < 1 || input.dedupeKey.length > 200)) {
      throw new BadRequestException('Notification deduplication key is invalid.');
    }
    const priority = input.priority ?? 'normal';
    const notificationId = randomUUID();
    if (input.dedupeKey) {
      const claimed = await client.query(
        `INSERT INTO user_notification_deduplication
          (recipient_user_id, workspace_id, dedupe_key, notification_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING
         RETURNING notification_id`,
        [input.recipientUserId, input.workspaceId ?? null, input.dedupeKey, notificationId],
      );
      if (!claimed.rows[0]) return { rows: [], rowCount: 0, duplicate: true };
    }
    const notification = await client.query(
      `INSERT INTO user_notifications
        (id, recipient_user_id, workspace_id, category, priority, event_type, title, body, href, group_key, group_window)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         CASE WHEN $10::text IS NULL THEN NULL ELSE floor(extract(epoch FROM now()) / 300)::bigint END)
       RETURNING id`,
      [notificationId, input.recipientUserId, input.workspaceId ?? null, input.category, priority,
        input.eventType, input.title, input.body ?? '', input.href ?? null, input.groupKey ?? null],
    );
    if (notification.rows[0]?.id) {
      const email = await client.query<{ email_address: string; category_preferences: Record<string, boolean>; priority_preferences: Record<string, boolean> }>(
        `SELECT email_address, category_preferences, priority_preferences
           FROM user_notification_email_settings
          WHERE user_id = $1 AND verified_at IS NOT NULL AND email_enabled = true`,
        [input.recipientUserId],
      );
      const settings = email.rows[0];
      if (settings?.category_preferences?.[input.category] === true && settings.priority_preferences?.[priority] === true) {
        const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[character] ?? character);
        const body = input.body ?? '';
        await client.query(
          `INSERT INTO email_outbox (user_id, workspace_id, notification_id, recipient_email, subject, text_body, html_body, unique_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (unique_key) DO NOTHING`,
          [input.recipientUserId, input.workspaceId ?? null, notification.rows[0].id, settings.email_address, input.title,
            `${input.title}\\n\\n${body}`,
            `<h2>${escapeHtml(input.title)}</h2><p>${escapeHtml(body)}</p>`,
            `notification:${notification.rows[0].id}`],
        );
      }
    }
    return notification;
  }
}
