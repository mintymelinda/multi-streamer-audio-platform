import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AccountExportsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async request(userId: string) {
    return this.database.transaction({ userId }, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
      const active = await client.query(
        `SELECT id, status, requested_at, completed_at, expires_at
           FROM user_data_exports
          WHERE user_id = $1 AND status IN ('queued', 'processing')
          ORDER BY requested_at DESC LIMIT 1`,
        [userId],
      );
      if (active.rows[0]) return { export: active.rows[0], reused: true };

      const recent = await client.query(
        `SELECT id FROM user_data_exports
          WHERE user_id = $1 AND requested_at > now() - interval '24 hours'
          ORDER BY requested_at DESC LIMIT 1`,
        [userId],
      );
      if (recent.rows[0]) {
        throw new HttpException('You can request one account export every 24 hours.', HttpStatus.TOO_MANY_REQUESTS);
      }

      const created = await client.query(
        `INSERT INTO user_data_exports (user_id)
         VALUES ($1)
         RETURNING id, status, requested_at, completed_at, expires_at`,
        [userId],
      );
      return { export: created.rows[0], reused: false };
    });
  }

  async list(userId: string) {
    const result = await this.database.transaction({ userId }, (client) =>
      client.query(
        `SELECT id, status, requested_at, completed_at, expires_at, downloaded_at, failure_code
           FROM user_data_exports
          WHERE user_id = $1
          ORDER BY requested_at DESC LIMIT 10`,
        [userId],
      ),
    );
    return result.rows;
  }

  async download(userId: string, exportId: string) {
    if (!UUID.test(exportId)) throw new BadRequestException('Export ID is invalid.');
    return this.database.transaction({ userId }, async (client) => {
      const result = await client.query(
        `SELECT id, status, export_data, expires_at
           FROM user_data_exports
          WHERE id = $1 AND user_id = $2`,
        [exportId, userId],
      );
      const record = result.rows[0];
      if (!record) throw new NotFoundException('Export not found.');
      if (record.status !== 'completed') {
        if (record.status === 'expired' || (record.expires_at && new Date(record.expires_at).getTime() <= Date.now())) {
          throw new GoneException('This export has expired. Request a new export when eligible.');
        }
        throw new ConflictException('This export is not ready to download.');
      }
      if (!record.export_data || !record.expires_at || new Date(record.expires_at).getTime() <= Date.now()) {
        throw new GoneException('This export has expired. Request a new export when eligible.');
      }
      await client.query(
        'UPDATE user_data_exports SET downloaded_at = now() WHERE id = $1 AND user_id = $2',
        [exportId, userId],
      );
      return { id: record.id, data: record.export_data };
    });
  }
}
