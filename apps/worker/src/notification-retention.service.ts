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
    application_name: 'multi-streamer-audio-platform-retention',
  });
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    void this.prune().catch((error: unknown) =>
      this.logger.error('Data retention failed', error instanceof Error ? error.stack : undefined));
    this.timer = setInterval(() => {
      void this.prune().catch((error: unknown) =>
        this.logger.error('Data retention failed', error instanceof Error ? error.stack : undefined));
    }, 24 * 60 * 60 * 1_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pool.end();
  }

  private async prune(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.pool.query<{ run_platform_retention: Record<string, number> }>(
        'SELECT run_platform_retention() AS run_platform_retention',
      );
      const counts = result.rows[0]?.run_platform_retention;
      if (counts && Object.values(counts).some((count) => count > 0)) {
        this.logger.log(`Applied data retention cleanup: ${JSON.stringify(counts)}`);
      }
    } finally {
      this.running = false;
    }
  }
}
