import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

interface OutboxRow {
  id: string;
  workspace_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  lock_token: string;
}

function readRequiredSetting(fileVariable: string, directVariable: string): string {
  const secretFile = process.env[fileVariable];
  if (secretFile) {
    const value = readFileSync(secretFile, 'utf8').trim();
    if (value) return value;
  }
  if (process.env.NODE_ENV !== 'production') {
    const value = process.env[directVariable]?.trim();
    if (value) return value;
  }
  throw new Error(
    `Worker configuration is missing. Set ${fileVariable} to a protected secret file.`,
  );
}

function retryDelaySeconds(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  return Math.min(3600, 5 * 2 ** exponent);
}

@Injectable()
export class OutboxDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private readonly pool = new Pool({
    connectionString: readRequiredSetting('DATABASE_URL_FILE', 'DATABASE_URL'),
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'multi-streamer-audio-platform-outbox-dispatcher',
  });
  private readonly redis = new Redis(readRequiredSetting('REDIS_URL_FILE', 'REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  private readonly queue = new Queue('platform-outbox', { connection: this.redis });
  private timer: NodeJS.Timeout | undefined;
  private dispatchInFlight = false;

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    await this.queue.waitUntilReady();
    this.logger.log('Outbox dispatcher connected to PostgreSQL and Redis');
    this.timer = setInterval(() => {
      void this.dispatchBatch().catch((error: unknown) => {
        this.logger.error(
          'Outbox dispatch cycle failed',
          error instanceof Error ? error.stack : undefined,
        );
      });
    }, 1_000);
    void this.dispatchBatch();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.queue.close();
    await this.redis.quit();
    await this.pool.end();
  }

  private async dispatchBatch(): Promise<void> {
    if (this.dispatchInFlight) return;
    this.dispatchInFlight = true;
    try {
      const rows = await this.claimBatch();
      for (const row of rows) await this.publish(row);
    } finally {
      this.dispatchInFlight = false;
    }
  }

  private async claimBatch(): Promise<OutboxRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<OutboxRow>(
        `WITH candidates AS (
           SELECT id
             FROM outbox_events
            WHERE published_at IS NULL
              AND available_at <= now()
              AND (locked_at IS NULL OR locked_at < now() - interval '60 seconds')
            ORDER BY occurred_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 25
         )
         UPDATE outbox_events AS event
            SET locked_at = now(),
                lock_token = gen_random_uuid(),
                attempt_count = event.attempt_count + 1
           FROM candidates
          WHERE event.id = candidates.id
         RETURNING event.id, event.workspace_id, event.event_type,
                   event.aggregate_type, event.aggregate_id, event.payload,
                   event.attempt_count, event.lock_token`,
      );
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async publish(row: OutboxRow): Promise<void> {
    try {
      await this.queue.add(
        'outbox-event',
        {
          eventId: row.id,
          workspaceId: row.workspace_id,
          eventType: row.event_type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          payload: row.payload,
        },
        {
          jobId: row.id,
          attempts: 8,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { age: 30 * 24 * 60 * 60, count: 10_000 },
          removeOnFail: false,
        },
      );
      await this.pool.query(
        `UPDATE outbox_events
            SET published_at = now(), locked_at = NULL, lock_token = NULL,
                last_error_code = NULL
          WHERE id = $1 AND published_at IS NULL AND lock_token = $2`,
        [row.id, row.lock_token],
      );
    } catch {
      const delay = retryDelaySeconds(row.attempt_count);
      await this.pool.query(
        `UPDATE outbox_events
            SET available_at = now() + ($2::text || ' seconds')::interval,
                locked_at = NULL, lock_token = NULL,
                last_error_code = 'redis_enqueue_failed'
          WHERE id = $1 AND published_at IS NULL AND lock_token = $3`,
        [row.id, delay, row.lock_token],
      );
      this.logger.warn(`Outbox event ${row.id} enqueue failed; retry scheduled.`);
    }
  }
}
