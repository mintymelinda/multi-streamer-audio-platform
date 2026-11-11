import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { calculateRetryDelay } from './retry-policy.js';

interface OutboxRow {
  id: string;
  workspace_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  dispatch_generation: number;
  lock_token: string;
}

interface EventSubDeliveryRow {
  id: string;
  workspace_id: string;
  subscription_id: string;
  message_id: string;
  message_type: 'notification' | 'revocation';
  payload: Record<string, unknown>;
  dispatch_attempts: number;
  dispatch_generation: number;
  dispatch_lock_token: string;
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
  return Math.ceil(
    calculateRetryDelay({
      attempt: Math.max(1, attempt),
      baseDelayMs: 5_000,
      maxDelayMs: 3_600_000,
      jitterRatio: 0.2,
    }) / 1_000,
  );
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
  private readonly eventSubQueue = new Queue('twitch-eventsub', { connection: this.redis });
  private readonly providerExecutionQueue = new Queue('provider-execution', { connection: this.redis });
  private timer: NodeJS.Timeout | undefined;
  private dispatchInFlight = false;

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    await Promise.all([this.queue.waitUntilReady(), this.eventSubQueue.waitUntilReady(), this.providerExecutionQueue.waitUntilReady()]);
    this.logger.log('Outbox and EventSub dispatchers connected to PostgreSQL and Redis');
    this.timer = setInterval(() => {
      void this.dispatchBatch().catch((error: unknown) => {
        this.logger.error(
          'Background dispatch cycle failed',
          error instanceof Error ? error.stack : undefined,
        );
      });
    }, 1_000);
    void this.dispatchBatch();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([this.queue.close(), this.eventSubQueue.close(), this.providerExecutionQueue.close()]);
    await this.redis.quit();
    await this.pool.end();
  }

  private async dispatchBatch(): Promise<void> {
    if (this.dispatchInFlight) return;
    this.dispatchInFlight = true;
    try {
      const outboxRows = await this.claimBatch();
      for (const row of outboxRows) await this.publish(row);
      const eventSubRows = await this.claimEventSubBatch();
      for (const row of eventSubRows) await this.publishEventSub(row);
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
            WHERE dispatch_status = 'pending'
              AND published_at IS NULL
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
                   event.attempt_count, event.dispatch_generation, event.lock_token`,
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

  private async claimEventSubBatch(): Promise<EventSubDeliveryRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<EventSubDeliveryRow>(
        `WITH candidates AS (
           SELECT id
             FROM twitch_eventsub_deliveries
            WHERE status = 'accepted'
              AND dispatch_published_at IS NULL
              AND next_dispatch_at <= now()
              AND (
                dispatch_locked_at IS NULL
                OR dispatch_locked_at < now() - interval '60 seconds'
              )
            ORDER BY received_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 25
         )
         UPDATE twitch_eventsub_deliveries AS delivery
            SET dispatch_locked_at = now(),
                dispatch_lock_token = gen_random_uuid(),
                dispatch_attempts = delivery.dispatch_attempts + 1
           FROM candidates
          WHERE delivery.id = candidates.id
         RETURNING delivery.id, delivery.workspace_id, delivery.subscription_id,
                   delivery.message_id, delivery.message_type, delivery.payload,
                   delivery.dispatch_attempts, delivery.dispatch_generation,
                   delivery.dispatch_lock_token`,
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

  private async publishEventSub(row: EventSubDeliveryRow): Promise<void> {
    try {
      await this.eventSubQueue.add(
        'eventsub-delivery',
        {
          deliveryId: row.id,
          workspaceId: row.workspace_id,
          messageId: row.message_id,
        },
        {
          jobId: `eventsub-${row.id}-${row.dispatch_generation}-${row.dispatch_attempts}`,
          attempts: 8,
          backoff: { type: 'phase2-exponential', delay: 1_000 },
          removeOnComplete: { age: 30 * 24 * 60 * 60, count: 10_000 },
          removeOnFail: false,
        },
      );
      await this.pool.query(
        `UPDATE twitch_eventsub_deliveries
            SET dispatch_published_at = now(),
                dispatch_locked_at = NULL,
                dispatch_lock_token = NULL,
                dispatch_error_code = NULL
          WHERE id = $1 AND status = 'accepted'
            AND dispatch_published_at IS NULL AND dispatch_lock_token = $2`,
        [row.id, row.dispatch_lock_token],
      );
    } catch {
      const delay = retryDelaySeconds(row.dispatch_attempts);
      await this.pool.query(
        `UPDATE twitch_eventsub_deliveries
            SET dispatch_locked_at = NULL,
                dispatch_lock_token = NULL,
                dispatch_error_code = CASE
                  WHEN dispatch_attempts >= 8 OR COALESCE(last_retried_at, received_at) < now() - interval '24 hours'
                    THEN 'eventsub_dispatch_exhausted'
                  ELSE 'redis_enqueue_failed' END,
                status = CASE
                  WHEN dispatch_attempts >= 8 OR COALESCE(last_retried_at, received_at) < now() - interval '24 hours'
                    THEN 'failed' ELSE status END,
                next_dispatch_at = CASE
                  WHEN dispatch_attempts >= 8 OR COALESCE(last_retried_at, received_at) < now() - interval '24 hours'
                    THEN next_dispatch_at
                  ELSE now() + ($2::text || ' seconds')::interval END
          WHERE id = $1 AND status = 'accepted'
            AND dispatch_published_at IS NULL AND dispatch_lock_token = $3`,
        [row.id, delay, row.dispatch_lock_token],
      );
      this.logger.warn(`EventSub delivery ${row.message_id} enqueue failed; retry scheduled.`);
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
          jobId: `${row.id}-${row.dispatch_generation}-${row.attempt_count}`,
          attempts: 8,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { age: 30 * 24 * 60 * 60, count: 10_000 },
          removeOnFail: false,
        },
      );
      if (row.event_type === 'provider.execution.queued') {
        const executionStateId = row.aggregate_id;
        const requestId = row.payload.requestId;
        const providerInstanceId = row.payload.providerInstanceId;
        const dispatchGeneration = row.payload.dispatchGeneration;
        if (typeof executionStateId !== 'string' || typeof requestId !== 'string' ||
            typeof providerInstanceId !== 'string' || !Number.isSafeInteger(dispatchGeneration) ||
            Number(dispatchGeneration) < 1) throw new Error('Provider execution outbox payload is invalid.');
        await this.providerExecutionQueue.add('provider-execution',
          { executionStateId, workspaceId: row.workspace_id, requestId, providerInstanceId, dispatchGeneration },
          { jobId: `provider-${executionStateId}-${dispatchGeneration}`, attempts: 8,
            backoff: { type: 'exponential', delay: 1_000 },
            removeOnComplete: { age: 30 * 24 * 60 * 60, count: 10_000 }, removeOnFail: false });
      }
      const event = {
        id: row.id,
        workspaceId: row.workspace_id,
        type: row.event_type,
        payload: row.payload,
      };
      const serialized = JSON.stringify(event);
      const notification =
        serialized.length <= 7_000
          ? serialized
          : JSON.stringify({ ...event, payload: {}, refreshRequired: true });
      await this.pool.query("SELECT pg_notify('platform_outbox_event', $1)", [notification]);
      await this.pool.query(
        `UPDATE outbox_events
            SET published_at = now(), dispatch_status = 'published',
                locked_at = NULL, lock_token = NULL, last_error_code = NULL
          WHERE id = $1 AND published_at IS NULL AND lock_token = $2`,
        [row.id, row.lock_token],
      );
    } catch {
      const delay = retryDelaySeconds(row.attempt_count);
      await this.pool.query(
        `UPDATE outbox_events
            SET dispatch_status = CASE
                  WHEN attempt_count >= 8 OR COALESCE(last_retried_at, created_at) < now() - interval '24 hours'
                    THEN 'failed' ELSE 'pending' END,
                available_at = CASE
                  WHEN attempt_count >= 8 OR COALESCE(last_retried_at, created_at) < now() - interval '24 hours'
                    THEN available_at
                  ELSE now() + ($2::text || ' seconds')::interval END,
                locked_at = NULL, lock_token = NULL,
                last_error_code = CASE
                  WHEN attempt_count >= 8 OR COALESCE(last_retried_at, created_at) < now() - interval '24 hours'
                    THEN 'outbox_dispatch_exhausted'
                  ELSE 'redis_enqueue_failed' END
          WHERE id = $1 AND published_at IS NULL
            AND dispatch_status = 'pending' AND lock_token = $3`,
        [row.id, delay, row.lock_token],
      );
      this.logger.warn(`Outbox event ${row.id} enqueue failed; retry scheduled.`);
    }
  }
}
