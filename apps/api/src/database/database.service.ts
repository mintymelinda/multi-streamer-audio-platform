import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export interface DatabaseContext {
  userId?: string;
  workspaceId?: string;
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
      if (context.workspaceId) {
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [
          context.workspaceId,
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
