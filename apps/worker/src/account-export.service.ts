import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

interface ExportJob {
  id: string;
  user_id: string;
  attempt_count: number;
}
interface AccountExportInput {
  account: Record<string, unknown> | null;
  memberships: Record<string, unknown>[];
  receivedInvitations: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  notificationPreferences: Record<string, unknown> | null;
  emailPreferences: Record<string, unknown> | null;
  appearancePreferences: Record<string, unknown> | null;
  exportedAt: string;
}
export function buildAccountExportDocument(input: AccountExportInput) {
  return {
    format: 'multi-streamer-audio-platform.account-export',
    schemaVersion: 2,
    exportedAt: input.exportedAt,
    scope: 'personal-account-data',
    account: input.account,
    workspaceMemberships: input.memberships,
    invitationsReceived: input.receivedInvitations,
    notifications: input.notifications,
    notificationPreferences: input.notificationPreferences,
    emailNotificationPreferences: input.emailPreferences,
    appearancePreferences: input.appearancePreferences,
    exclusions: [
      'Workspace-owned content and configuration are not part of this personal account export.',
      'Authentication sessions, OAuth state, credential material, token hashes, and delivery secrets are never exported.',
      'Other users’ personal information and workspace member lists are not included.',
    ],
  };
}
export function accountExportRetryDelaySeconds(attemptCount: number): number {
  return Math.min(3600, 30 * (2 ** Math.min(Math.max(0, attemptCount - 1), 7)));
}
function requiredDatabaseUrl(): string {
  const file = process.env.DATABASE_URL_FILE;
  if (file) return readFileSync(file, 'utf8').trim();
  if (process.env.NODE_ENV !== 'production' && process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error('Worker database configuration is missing.');
}

@Injectable()
export class AccountExportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountExportService.name);
  private readonly pool = new Pool({
    connectionString: requiredDatabaseUrl(),
    max: 2,
    connectionTimeoutMillis: 5_000,
    application_name: 'multi-streamer-audio-platform-account-export',
  });
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    this.timer = setInterval(() => {
      void this.dispatch().catch((error: unknown) =>
        this.logger.error('Account export cycle failed', error instanceof Error ? error.stack : undefined));
    }, 5_000);
    void this.dispatch();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pool.end();
  }

  private async dispatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const client = await this.pool.connect();
      let jobs: ExportJob[];
      try {
        await client.query('BEGIN');
        const claimed = await client.query<ExportJob>(
          `WITH candidates AS (
             SELECT id FROM user_data_exports
              WHERE (status = 'queued' AND next_attempt_at <= now())
                 OR (status = 'processing' AND locked_at < now() - interval '10 minutes')
              ORDER BY requested_at
              FOR UPDATE SKIP LOCKED LIMIT 3
           )
           UPDATE user_data_exports e
              SET status = 'processing', locked_at = now(), started_at = COALESCE(started_at, now()), attempt_count = attempt_count + 1
             FROM candidates
            WHERE e.id = candidates.id
           RETURNING e.id, e.user_id, e.attempt_count`,
        );
        jobs = claimed.rows;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      for (const job of jobs) {
        try {
          await this.process(job);
        } catch (error) {
          await this.fail(job);
          this.logger.error(`Account export ${job.id} failed`, error instanceof Error ? error.stack : undefined);
        }
      }
      await this.expire();
    } finally {
      this.running = false;
    }
  }

  private async process(job: ExportJob): Promise<void> {
    const client = await this.pool.connect();
    let document: ReturnType<typeof buildAccountExportDocument>;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [job.user_id]);
      const [account, memberships, invitations, notifications, notificationPreferences, emailPreferences, appearancePreferences] = await Promise.all([
        client.query(
          'SELECT id, twitch_user_id, status, created_at, updated_at FROM platform_users WHERE id = $1',
          [job.user_id],
        ),
        client.query(
          `SELECT id, workspace_id, role, status, created_at, updated_at, revoked_at
             FROM workspace_memberships WHERE user_id = $1 ORDER BY created_at`,
          [job.user_id],
        ),
        client.query(
          `SELECT id, workspace_id, assigned_role, status, created_at, expires_at, responded_at
             FROM workspace_invitations
            WHERE invited_twitch_user_id = (SELECT twitch_user_id FROM platform_users WHERE id = $1)
            ORDER BY created_at`,
          [job.user_id],
        ),
        client.query(
          `SELECT id, workspace_id, category, priority, event_type, title, body, href, group_key,
                  group_window, created_at, read_at
             FROM user_notifications WHERE recipient_user_id = $1 ORDER BY created_at`,
          [job.user_id],
        ),
        client.query(
          'SELECT category_preferences, retention_days, updated_at FROM user_notification_preferences WHERE user_id = $1',
          [job.user_id],
        ),
        client.query(
          `SELECT email_address, verified_at, email_enabled, category_preferences, priority_preferences, updated_at
             FROM user_notification_email_settings WHERE user_id = $1`,
          [job.user_id],
        ),
        client.query(
          'SELECT theme, accent_color, updated_at FROM user_appearance_preferences WHERE user_id = $1',
          [job.user_id],
        ),
      ]);
      document = buildAccountExportDocument({
        account: account.rows[0] ?? null,
        memberships: memberships.rows,
        receivedInvitations: invitations.rows,
        notifications: notifications.rows,
        notificationPreferences: notificationPreferences.rows[0] ?? null,
        emailPreferences: emailPreferences.rows[0] ?? null,
        appearancePreferences: appearancePreferences.rows[0] ?? null,
        exportedAt: new Date().toISOString(),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized, 'utf8') > 25 * 1024 * 1024) {
      throw new Error('Account export exceeds the 25 MiB safety limit.');
    }

    const completion = await this.pool.connect();
    try {
      await completion.query('BEGIN');
      await completion.query("SELECT set_config('app.user_id', $1, true)", [job.user_id]);
      const updated = await completion.query(
        `UPDATE user_data_exports
            SET status = 'completed', export_data = $3::jsonb, completed_at = now(),
                expires_at = now() + interval '7 days', locked_at = NULL, failure_code = NULL
          WHERE id = $1 AND user_id = $2 AND status = 'processing'`,
        [job.id, job.user_id, serialized],
      );
      if (updated.rowCount) {
        await completion.query(
          `INSERT INTO user_notifications
            (recipient_user_id, category, priority, event_type, title, body, href, group_key)
           VALUES ($1, 'account', 'normal', 'account.data_export.completed',
             'Your account export is ready',
             'Your requested account data export is ready to download. The download expires in seven days.',
             '/account/data-exports', 'account:data-export')`,
          [job.user_id],
        );
      }
      await completion.query('COMMIT');
    } catch (error) {
      await completion.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      completion.release();
    }
  }

  private async fail(job: ExportJob): Promise<void> {
    const terminal = job.attempt_count >= 3;
    await this.pool.query(
      `UPDATE user_data_exports
          SET status = $2,
              next_attempt_at = now() + make_interval(secs => $3),
              locked_at = NULL,
              failure_code = CASE WHEN $2 = 'failed' THEN 'generation_failed' ELSE NULL END
        WHERE id = $1 AND status = 'processing'`,
      [job.id, terminal ? 'failed' : 'queued', accountExportRetryDelaySeconds(job.attempt_count)],
    );
  }

  private async expire(): Promise<void> {
    await this.pool.query(
      `UPDATE user_data_exports
          SET status = 'expired', export_data = NULL, locked_at = NULL
        WHERE status = 'completed' AND expires_at <= now()`,
    );
    await this.pool.query(
      `DELETE FROM user_data_exports
        WHERE status IN ('expired', 'failed') AND requested_at < now() - interval '30 days'`,
    );
  }
}
