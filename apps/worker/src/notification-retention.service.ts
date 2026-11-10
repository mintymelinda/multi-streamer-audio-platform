import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

function setting(fileVariable: string, directVariable: string): string {
  const file = process.env[fileVariable];
  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  if (process.env.NODE_ENV !== 'production') {
    const value = process.env[directVariable]?.trim();
    if (value) return value;
  }
  throw new Error(`Worker configuration is missing. Set ${fileVariable} to a protected secret file.`);
}

@Injectable()
export class NotificationRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationRetentionService.name);
  private readonly pool = new Pool({
    connectionString: setting('DATABASE_URL_FILE', 'DATABASE_URL'),
    max: 2,
    connectionTimeoutMillis: 5_000,
    application_name: 'multi-streamer-audio-platform-notification-retention',
  });
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    void this.prune().catch((error: unknown) => this.logger.error('Notification retention failed', error instanceof Error ? error.stack : undefined));
    this.timer = setInterval(() => {
      void this.prune().catch((error: unknown) => this.logger.error('Notification retention failed', error instanceof Error ? error.stack : undefined));
    }, 24 * 60 * 60 * 1_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pool.end();
  }

  private async prune(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let deleted = 0;
    try {
      const users = await this.pool.query<{ id: string }>('SELECT id FROM platform_users');
      for (const user of users.rows) {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
          const result = await client.query(
            `DELETE FROM user_notifications
              WHERE recipient_user_id = $1
                AND category NOT IN ('account', 'security')
                AND created_at < now() - make_interval(days => COALESCE(
                  (SELECT retention_days FROM user_notification_preferences WHERE user_id = $1), 90
                ))`,
            [user.id],
          );
          deleted += result.rowCount ?? 0;
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
      if (deleted) this.logger.log(`Pruned ${deleted} expired non-mandatory notifications`);
    } finally {
      this.running = false;
    }
  }
}
