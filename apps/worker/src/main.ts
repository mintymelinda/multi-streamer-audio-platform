import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { WorkerModule } from './worker.module.js';
import {
  closeWorkerHealthServer,
  createWorkerHealthServer,
  listenWorkerHealthServer,
} from './worker-health.server.js';

function readHealthSetting(fileVariable: string, directVariable: string): string {
  const file = process.env[fileVariable];
  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  if (process.env.NODE_ENV !== 'production') {
    const value = process.env[directVariable]?.trim();
    if (value) return value;
  }
  throw new Error(`Worker health configuration is missing. Set ${fileVariable} to a protected secret file.`);
}

async function bootstrap(): Promise<void> {
  const logger = new ConsoleLogger({ json: true });
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger });
  const healthPool = new Pool({
    connectionString: readHealthSetting('DATABASE_URL_FILE', 'DATABASE_URL'),
    max: 1,
    connectionTimeoutMillis: 1_500,
    idleTimeoutMillis: 5_000,
    application_name: 'multi-streamer-audio-platform-worker-health',
  });
  const healthRedis = new Redis(readHealthSetting('REDIS_URL_FILE', 'REDIS_URL'), {
    maxRetriesPerRequest: 1,
    connectTimeout: 1_500,
    commandTimeout: 1_500,
    enableReadyCheck: true,
  });
  const healthServer = createWorkerHealthServer({
    postgres: async () => {
      await healthPool.query('SELECT 1');
    },
    redis: async () => {
      const response = await healthRedis.ping();
      if (response !== 'PONG') throw new Error('worker_redis_ping_failed');
    },
  });

  try {
    const configuredPort = Number(process.env.WORKER_HEALTH_PORT ?? 3002);
    await listenWorkerHealthServer(healthServer, configuredPort);
  } catch (error) {
    await app.close();
    await Promise.allSettled([healthPool.end(), Promise.resolve(healthRedis.disconnect())]);
    throw error;
  }

  logger.log(`Worker health endpoint listening on 127.0.0.1:${process.env.WORKER_HEALTH_PORT ?? '3002'}`);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeWorkerHealthServer(healthServer).catch(() => undefined);
    await app.close();
    await Promise.allSettled([healthPool.end(), healthRedis.quit()]);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void bootstrap();
