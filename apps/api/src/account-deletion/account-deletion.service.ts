import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

interface PostgresFailure {
  code?: string;
}

@Injectable()
export class AccountDeletionService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async delete(userId: string) {
    try {
      return await this.database.transaction({ userId }, async (client) => {
        const result = await client.query<{ deleted_user_id: string }>(
          'SELECT delete_current_platform_account() AS deleted_user_id',
        );
        const deletedUserId = result.rows[0]?.deleted_user_id;
        if (!deletedUserId) throw new NotFoundException('Account not found.');
        return {
          deleted: true,
          message: 'Your platform account and personal data have been permanently deleted.',
        };
      });
    } catch (error) {
      const code = (error as PostgresFailure).code;
      if (code === '23503') {
        throw new ConflictException('Delete your owned workspace before deleting this account.');
      }
      if (code === '42501') {
        throw new ConflictException('Platform administrator access must be revoked before deleting this account.');
      }
      if (code === 'P0002') throw new NotFoundException('Account not found.');
      throw error;
    }
  }
}
