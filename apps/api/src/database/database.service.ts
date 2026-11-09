import type { VerifiedWorkspaceId } from '@platform/contracts';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export interface DatabaseContext {
  userId?: string;
  verifiedWorkspaceId?: VerifiedWorkspaceId;
  twitchLookupId?: string;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: this.readConnectionString(),
      max: 12,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      application_name: 'multi-streamer-audio-platform-api',
    });
    this.pool.on('error', (error: Error) => {
      this.logger.error('Unexpected idle PostgreSQL client error', error.stack);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    this.logger.log('PostgreSQL connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Executes only pre-authentication or session-infrastructure SQL against
   * tables that intentionally do not use tenant RLS. Tenant-owned business
   * data must always use transaction() with a verified DatabaseContext.
   */
  queryInfrastructure<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, values);
  }

  async listen(
    channel: string,
    handler: (payload: string | undefined) => void,
  ): Promise<() => Promise<void>> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(channel)) {
      throw new Error('PostgreSQL notification channel name is invalid.');
    }
    const client = await this.pool.connect();
    const onNotification = (message: { channel?: string; payload?: string }) => {
      if (message.channel === channel) handler(message.payload);
    };
    try {
      client.on('notification', onNotification);
      await client.query(`LISTEN ${channel}`);
    } catch (error) {
      client.removeListener('notification', onNotification);
      client.release();
      throw error;
    }
    return async () => {
      client.removeListener('notification', onNotification);
      await client.query(`UNLISTEN ${channel}`).catch(() => undefined);
      client.release();
    };
  }

  async transaction<T>(
    context: DatabaseContext,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.user_id', '', true), set_config('app.workspace_id', '', true), set_config('app.twitch_lookup_id', '', true)",
      );
      if (context.userId) {
        await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
      }
      if (context.verifiedWorkspaceId) {
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [
          context.verifiedWorkspaceId,
        ]);
      }
      if (context.twitchLookupId) {
        await client.query("SELECT set_config('app.twitch_lookup_id', $1, true)", [
          context.twitchLookupId,
        ]);
      }
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private readConnectionString(): string {
    const secretFile = process.env.DATABASE_URL_FILE;
    if (secretFile) {
      const value = readFileSync(secretFile, 'utf8').trim();
      if (value.length > 0) return value;
    }
    if (process.env.NODE_ENV !== 'production' && process.env.DATABASE_URL) {
      return process.env.DATABASE_URL;
    }
    throw new Error(
      'Database connection is not configured. Set DATABASE_URL_FILE to a protected secret file.',
    );
  }
}
