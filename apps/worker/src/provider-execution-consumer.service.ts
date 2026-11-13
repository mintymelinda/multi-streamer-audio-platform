import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { Pool } from 'pg';

export interface ProviderExecutionJob {
  executionStateId: string;
  workspaceId: string;
  requestId: string;
  providerInstanceId: string;
  dispatchGeneration: number;
}
export interface ValidatedProviderExecution {
  execution_state_id: string; workspace_id: string; request_id: string; provider_instance_id: string;
  state: 'queued' | 'retry_wait' | 'resolving'; attempt: number; dispatch_generation: number;
  request_source: 'twitch_reward' | 'dashboard' | 'moderator' | 'api'; request_status: 'queued';
  actor_user_id: string; provider_id: string; contract_version: number; capabilities: Record<string, unknown>;
  connection_health: 'healthy'; output_id: string; player_id: string; media_id: string | null;
  media_url: string | null; title: string; artist: string | null; duration_ms: string | null;
  metadata: Record<string, unknown>;
}
function readRequiredSetting(fileVariable: string, directVariable: string): string {
  const secretFile = process.env[fileVariable];
  if (secretFile) { const value = readFileSync(secretFile, 'utf8').trim(); if (value) return value; }
  if (process.env.NODE_ENV !== 'production') {
    const value = process.env[directVariable]?.trim(); if (value) return value;
  }
  throw new Error(`Provider execution worker configuration is missing. Set ${fileVariable} to a protected secret file.`);
}
function requiredUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new UnrecoverableError(`invalid_provider_execution_${field}`);
  }
  return value;
}
export function parseProviderExecutionJob(value: unknown): ProviderExecutionJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UnrecoverableError('invalid_provider_execution_job');
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.dispatchGeneration) || Number(input.dispatchGeneration) < 1) {
    throw new UnrecoverableError('invalid_provider_execution_generation');
  }
  return {
    executionStateId: requiredUuid(input.executionStateId, 'execution_state_id'),
    workspaceId: requiredUuid(input.workspaceId, 'workspace_id'),
    requestId: requiredUuid(input.requestId, 'request_id'),
    providerInstanceId: requiredUuid(input.providerInstanceId, 'provider_instance_id'),
    dispatchGeneration: Number(input.dispatchGeneration),
  };
}
export function createProviderExecutionHandoffSignature(
  secret: string,
  timestamp: string,
  body: unknown,
): string {
  return createHmac('sha256', secret).update(`${timestamp}.${JSON.stringify(body)}`).digest('hex');
}

export async function handoffValidatedProviderExecution(
  input: ValidatedProviderExecution,
  options: {
    url: string;
    secret: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
  },
): Promise<{ accepted: true; operationId: string | null; status: string }> {
  const body = {
    executionStateId: input.execution_state_id,
    workspaceId: input.workspace_id,
    requestId: input.request_id,
    providerInstanceId: input.provider_instance_id,
    dispatchGeneration: input.dispatch_generation,
    actorUserId: input.actor_user_id,
  };
  const timestamp = String(Math.floor((options.now?.() ?? Date.now()) / 1000));
  const signature = createProviderExecutionHandoffSignature(options.secret, timestamp, body);
  const response = await (options.fetchImpl ?? fetch)(options.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-provider-execution-timestamp': timestamp,
      'x-provider-execution-signature': signature,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`provider_execution_handoff_http_${response.status}`);
  }
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== 'object' ||
    (result as Record<string, unknown>).accepted !== true ||
    typeof (result as Record<string, unknown>).status !== 'string'
  ) {
    throw new Error('provider_execution_handoff_invalid_response');
  }
  return result as { accepted: true; operationId: string | null; status: string };
}

export async function deferProviderExecutionJob(pool: Pool, value: unknown): Promise<boolean> {
  const job = parseProviderExecutionJob(value);
  const result = await pool.query<{ deferred: boolean }>(
    'SELECT public.platform_defer_provider_execution_job($1, $2, $3, $4, $5) AS deferred',
    [job.executionStateId, job.workspaceId, job.requestId, job.providerInstanceId, job.dispatchGeneration],
  );
  return result.rows[0]?.deferred === true;
}

export async function validateProviderExecutionJob(pool: Pool, value: unknown): Promise<ValidatedProviderExecution | null> {
  const job = parseProviderExecutionJob(value);
  const result = await pool.query<ValidatedProviderExecution>(
    'SELECT * FROM public.platform_validate_provider_execution_job($1, $2, $3, $4, $5)',
    [job.executionStateId, job.workspaceId, job.requestId, job.providerInstanceId, job.dispatchGeneration],
  );
  return result.rows[0] ?? null;
}
@Injectable()
export class ProviderExecutionConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProviderExecutionConsumerService.name);
  private readonly pool = new Pool({
    connectionString: readRequiredSetting('PROVIDER_EXECUTION_DATABASE_URL_FILE', 'PROVIDER_EXECUTION_DATABASE_URL'),
    max: 4, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
    application_name: 'multi-streamer-audio-platform-provider-execution-consumer',
  });
  private readonly redis = new Redis(readRequiredSetting('REDIS_URL_FILE', 'REDIS_URL'), {
    maxRetriesPerRequest: null, enableReadyCheck: true,
  });
  private worker: Worker<ProviderExecutionJob> | undefined;
  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    const permission = await this.pool.query<{ can_validate: boolean; can_defer: boolean }>(
      `SELECT
         has_function_privilege(current_user, 'public.platform_validate_provider_execution_job(uuid,uuid,uuid,uuid,integer)', 'EXECUTE') AS can_validate,
         has_function_privilege(current_user, 'public.platform_defer_provider_execution_job(uuid,uuid,uuid,uuid,integer)', 'EXECUTE') AS can_defer`,
    );
    if (permission.rows[0]?.can_validate !== true || permission.rows[0]?.can_defer !== true) {
      throw new Error('Provider execution database identity cannot validate and defer jobs.');
    }
    this.worker = new Worker<ProviderExecutionJob>(
      'provider-execution', async (job: Job<ProviderExecutionJob>) => this.process(job),
      { connection: this.redis, concurrency: 4, lockDuration: 30_000, limiter: { max: 20, duration: 1_000 } },
    );
    this.worker.on('failed', (job, error) => this.logger.error(
      `Provider execution validation job ${job?.id ?? 'unknown'} failed: ${error.message}`,
    ));
    await this.worker.waitUntilReady();
    this.logger.log('Provider execution validation consumer is ready');
  }
  async onModuleDestroy(): Promise<void> {
    await this.worker?.close(); await this.redis.quit(); await this.pool.end();
  }
  private async process(job: Job<ProviderExecutionJob>): Promise<void> {
    const validated = await validateProviderExecutionJob(this.pool, job.data);
    if (!validated) {
      const deferred = await deferProviderExecutionJob(this.pool, job.data);
      if (deferred) {
        this.logger.log(`Deferred blocked provider execution job ${job.id ?? 'unknown'} for Queue Manager rescheduling.`);
      } else {
        this.logger.warn(`Discarded stale or unauthorized provider execution job ${job.id ?? 'unknown'}.`);
      }
      return;
    }
    const url = process.env.PROVIDER_EXECUTION_HANDOFF_URL?.trim();
    if (!url) throw new Error('PROVIDER_EXECUTION_HANDOFF_URL is required.');
    const secret = readRequiredSetting(
      'PROVIDER_EXECUTION_HANDOFF_SECRET_FILE',
      'PROVIDER_EXECUTION_HANDOFF_SECRET',
    );
    const result = await handoffValidatedProviderExecution(validated, { url, secret });
    this.logger.log(
      `Provider execution ${validated.execution_state_id} handed to coordinator: ${result.status}.`,
    );
  }
}
