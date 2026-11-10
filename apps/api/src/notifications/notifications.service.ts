import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
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
        SELECT *, CASE WHEN group_key IS NULL THEN 'notification:' || id::text ELSE 'group:' || group_key END AS grouping_key
        FROM user_notifications WHERE ${clauses.join(' AND ')}
      ), latest AS (
        SELECT DISTINCT ON (grouping_key) grouping_key, id, workspace_id, category, priority, event_type,
          title, body, href, group_key, created_at
        FROM filtered ORDER BY grouping_key, created_at DESC, id DESC
      ), totals AS (
        SELECT grouping_key, count(*)::int AS notification_count,
          count(*) FILTER (WHERE read_at IS NULL)::int AS unread_count
        FROM filtered GROUP BY grouping_key
      )
      SELECT latest.*, totals.notification_count, totals.unread_count,
        (totals.unread_count = 0) AS is_read
      FROM latest JOIN totals USING (grouping_key)
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

  async markGroupRead(userId: string, groupKey: unknown) {
    if (typeof groupKey !== 'string' || groupKey.length < 1 || groupKey.length > 160) {
      throw new BadRequestException('Notification group key is invalid.');
    }
    const result = await this.database.transaction({ userId }, (client) =>
      client.query('UPDATE user_notifications SET read_at = COALESCE(read_at, now()) WHERE recipient_user_id = $1 AND group_key = $2 AND read_at IS NULL RETURNING id', [userId, groupKey]),
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
    href?: string | null; groupKey?: string | null;
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
    return client.query(
      `INSERT INTO user_notifications
        (recipient_user_id, workspace_id, category, priority, event_type, title, body, href, group_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [input.recipientUserId, input.workspaceId ?? null, input.category, input.priority ?? 'normal',
        input.eventType, input.title, input.body ?? '', input.href ?? null, input.groupKey ?? null],
    );
  }
}
