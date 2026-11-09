import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { classifyProcessingFailure, isRetryEligible } from './retry-policy.js';
import { calculateRetryDelay } from './retry-policy.js';

interface EventSubJob {
  deliveryId: string;
  workspaceId: string;
  messageId: string;
}
interface DeliveryRow {
  id: string;
  workspace_id: string;
  subscription_id: string;
  message_id: string;
  message_type: 'notification' | 'revocation';
  service_actor_user_id: string | null;
  payload: Record<string, unknown>;
  status: 'accepted' | 'processing' | 'processed' | 'failed' | 'dismissed';
  attempts: number;
}
interface EventSubEnvelope {
  subscription?: Record<string, unknown>;
  event?: Record<string, unknown>;
}
function readSetting(fileVariable: string, directVariable: string): string {
  const file = process.env[fileVariable];
  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  if (process.env.NODE_ENV !== 'production') {
    const value = process.env[directVariable]?.trim();
    if (value) return value;
  }
  throw new Error(`Worker configuration missing: set ${fileVariable} to a protected secret file.`);
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) {
    throw new Error(`invalid_eventsub_${field}`);
  }
  return value;
}

@Injectable()
export class EventSubConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventSubConsumerService.name);
  private readonly pool = new Pool({
    connectionString: readSetting('DATABASE_URL_FILE', 'DATABASE_URL'),
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'multi-streamer-audio-platform-eventsub-consumer',
  });
  private readonly redis = new Redis(readSetting('REDIS_URL_FILE', 'REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  private worker: Worker<EventSubJob> | undefined;

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    this.worker = new Worker<EventSubJob>(
      'twitch-eventsub',
      async (job: Job<EventSubJob>) => this.processDelivery(job),
      {
        connection: this.redis,
        concurrency: 8,
        lockDuration: 30_000,
        limiter: { max: 20, duration: 1_000 },
        settings: {
          backoffStrategy: (attemptsMade: number, type: string) => {
            if (type !== 'phase2-exponential') return -1;
            return calculateRetryDelay({
              attempt: Math.max(1, attemptsMade),
              baseDelayMs: 1_000,
              maxDelayMs: 60_000,
              jitterRatio: 0.2,
            });
          },
        },
      },
    );
    this.worker.on('failed', (job) => {
      if (job && job.attemptsMade >= Number(job.opts.attempts ?? 1)) {
        // Fallback for failures outside the processor's catch path (for example,
        // a worker crash after BullMQ exhausts a stalled job).
        void this.markTerminalFailure(job.data.deliveryId).catch((error: unknown) => {
          this.logger.error(
            'Unable to mark terminal EventSub delivery failure',
            error instanceof Error ? error.stack : undefined,
          );
        });
      }
      this.logger.warn(`EventSub job ${job?.id ?? 'unknown'} failed.`);
    });
    await this.worker.waitUntilReady();
    this.logger.log('Twitch EventSub queue consumer is ready');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.redis.quit();
    await this.pool.end();
  }

  private async processDelivery(job: Job<EventSubJob>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<DeliveryRow>(
        'SELECT id, workspace_id, subscription_id, message_id, message_type, service_actor_user_id, payload, status, attempts FROM twitch_eventsub_deliveries WHERE id = $1 AND workspace_id = $2 AND message_id = $3 FOR UPDATE',
        [job.data.deliveryId, job.data.workspaceId, job.data.messageId],
      );
      const delivery = result.rows[0];
      if (!delivery) throw new Error('eventsub_delivery_not_found');
      if (
        delivery.status === 'processed' ||
        delivery.status === 'failed' ||
        delivery.status === 'dismissed'
      ) {
        await client.query('COMMIT');
        return;
      }

      const envelope = delivery.payload as EventSubEnvelope;
      const eventType = requiredString(envelope.subscription?.type, 'subscription_type');
      const eventVersion =
        typeof envelope.subscription?.version === 'string' ? envelope.subscription.version : '1';
      const eventPayload =
        delivery.message_type === 'notification' ? envelope.event : envelope.subscription;
      if (!eventPayload || typeof eventPayload !== 'object' || Array.isArray(eventPayload)) {
        throw new Error('invalid_eventsub_payload');
      }
      // Use Twitch's redemption ID for redemption dedupe; use message ID for
      // other notifications and revocations. No feature handler is called here.
      const eventId =
        delivery.message_type === 'notification' &&
        eventType === 'channel.channel_points_custom_reward_redemption.add'
          ? requiredString(eventPayload.id, 'redemption_id')
          : delivery.message_id;

      await client.query(
        'INSERT INTO twitch_eventsub_intake (workspace_id, delivery_id, subscription_id, message_id, message_type, event_type, event_version, event_id, event_payload, service_actor_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (workspace_id, event_type, event_id) DO NOTHING',
        [
          delivery.workspace_id,
          delivery.id,
          delivery.subscription_id,
          delivery.message_id,
          delivery.message_type,
          eventType,
          eventVersion,
          eventId,
          JSON.stringify(eventPayload),
          delivery.service_actor_user_id,
        ],
      );
      await client.query(
        "UPDATE twitch_eventsub_deliveries SET status = 'processed', processed_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1 AND workspace_id = $2",
        [delivery.id, delivery.workspace_id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const maxAttempts = Number(job.opts.attempts ?? 1);
      const message = error instanceof Error ? error.message : 'eventsub_processing_failed';
      const permanent = message.startsWith('invalid_eventsub_') || message === 'eventsub_delivery_not_found';
      const failureClass = classifyProcessingFailure({
        kind: message,
        retryable: !permanent,
        outcome: 'failed',
        externalSideEffectStarted: false,
      });
      const terminal = !isRetryEligible({
        failureClass,
        attempts: job.attemptsMade + 1,
        maxAttempts,
        ageMs: Math.max(0, Date.now() - job.timestamp),
        maxAgeMs: 24 * 60 * 60 * 1_000,
      });
      // Persist exhaustion before throwing the final error. The previous
      // implementation relied only on BullMQ's async "failed" event, leaving
      // a crash window where a permanently failed job remained "accepted".
      await this.recordAttemptFailure(job.data.deliveryId, terminal);
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordAttemptFailure(deliveryId: string, terminal: boolean): Promise<void> {
    await this.pool.query(
      "UPDATE twitch_eventsub_deliveries SET attempts = attempts + 1, status = CASE WHEN $2 THEN 'failed' ELSE status END, last_error = CASE WHEN $2 THEN 'eventsub_processing_exhausted' ELSE 'eventsub_processing_failed' END WHERE id = $1 AND status IN ('accepted','processing')",
      [deliveryId, terminal],
    );
  }
  private async markTerminalFailure(deliveryId: string): Promise<void> {
    await this.pool.query(
      "UPDATE twitch_eventsub_deliveries SET status = 'failed', last_error = 'eventsub_processing_exhausted' WHERE id = $1 AND status IN ('accepted','processing')",
      [deliveryId],
    );
  }
}
