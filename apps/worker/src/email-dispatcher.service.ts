import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

interface EmailRow {
  id: string; recipient_email: string; subject: string; text_body: string; html_body: string; attempt_count: number;
}
function optionalSecret(fileVariable: string, directVariable: string): string | undefined {
  const file = process.env[fileVariable];
  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  if (process.env.NODE_ENV !== 'production') return process.env[directVariable]?.trim() || undefined;
  return undefined;
}
function requiredDatabaseUrl(): string {
  const file = process.env.DATABASE_URL_FILE;
  if (file) return readFileSync(file, 'utf8').trim();
  if (process.env.NODE_ENV !== 'production' && process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error('Worker database configuration is missing.');
}
@Injectable()
export class EmailDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailDispatcherService.name);
  private readonly pool = new Pool({ connectionString: requiredDatabaseUrl(), max: 2, connectionTimeoutMillis: 5_000,
    application_name: 'multi-streamer-audio-platform-email-dispatcher' });
  private readonly apiKey = optionalSecret('RESEND_API_KEY_FILE', 'RESEND_API_KEY');
  private readonly from = process.env.EMAIL_FROM?.trim();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    if (!this.apiKey || !this.from) {
      this.logger.warn('Email delivery is disabled until RESEND_API_KEY_FILE and EMAIL_FROM are configured');
      return;
    }
    this.timer = setInterval(() => { void this.dispatch().catch((error: unknown) =>
      this.logger.error('Email dispatch cycle failed', error instanceof Error ? error.stack : undefined)); }, 10_000);
    void this.dispatch();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pool.end();
  }
  private async dispatch(): Promise<void> {
    if (this.running || !this.apiKey || !this.from) return;
    this.running = true;
    try {
      const client = await this.pool.connect();
      let rows: EmailRow[];
      try {
        await client.query('BEGIN');
        const claimed = await client.query<EmailRow>(
          `WITH candidates AS (
             SELECT id FROM email_outbox
              WHERE (status = 'pending' AND next_attempt_at <= now())
                 OR (status = 'sending' AND locked_at < now() - interval '5 minutes')
              ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10
           )
           UPDATE email_outbox e SET status = 'sending', locked_at = now(), attempt_count = attempt_count + 1
            FROM candidates WHERE e.id = candidates.id
           RETURNING e.id, e.recipient_email, e.subject, e.text_body, e.html_body, e.attempt_count`,
        );
        rows = claimed.rows;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { client.release(); }
      for (const row of rows) await this.deliver(row);
    } finally { this.running = false; }
  }
  private async deliver(row: EmailRow): Promise<void> {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [row.recipient_email], subject: row.subject, text: row.text_body, html: row.html_body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
      await this.pool.query(
        `UPDATE email_outbox SET status = 'sent', sent_at = now(), locked_at = NULL,
           recipient_email = '', subject = '', text_body = '', html_body = '', last_error = NULL WHERE id = $1`, [row.id],
      );
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Unknown email delivery error').slice(0, 500);
      const terminal = row.attempt_count >= 10;
      const delaySeconds = Math.min(86_400, 30 * (2 ** Math.min(row.attempt_count - 1, 11)));
      await this.pool.query(
        `UPDATE email_outbox SET status = $2, locked_at = NULL, next_attempt_at = now() + make_interval(secs => $3),
           last_error = $4 WHERE id = $1`,
        [row.id, terminal ? 'failed' : 'pending', delaySeconds, message],
      );
      this.logger.warn(`Email delivery ${row.id} ${terminal ? 'exhausted retries' : 'will retry'}: ${message}`);
    }
  }
}
