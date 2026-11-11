import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

export const PLATFORM_PERMISSIONS = [
  'accounts.read',
  'accounts.suspend',
  'workspaces.read',
  'workspaces.restrict',
  'settings.read',
  'settings.write',
  'support_access.manage',
  'administrators.read',
  'administrators.manage',
  'rights_reports.manage',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
export type PlatformAdminRole = 'owner' | 'admin';

export interface PlatformAdminAssignment {
  user_id: string;
  twitch_user_id: string;
  role: PlatformAdminRole;
  permissions: PlatformPermission[];
  appointed_at: Date;
  revoked_at: Date | null;
}

@Injectable()
export class PlatformAdminService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async access(userId: string) {
    const result = await this.database.transaction({ userId }, (client) =>
      client.query<{ role: PlatformAdminRole; permissions: PlatformPermission[] }>(
        "SELECT role, permissions FROM get_current_platform_administrator()",
      ),
    );
    const assignment = result.rows[0];
    return {
      isPlatformAdministrator: Boolean(assignment),
      role: assignment?.role ?? null,
      permissions: assignment?.role === 'owner' ? [...PLATFORM_PERMISSIONS] : assignment?.permissions ?? [],
    };
  }

  async listAdministrators(userId: string): Promise<PlatformAdminAssignment[]> {
    return this.database.transaction({ userId }, async (client) => {
      const result = await client.query<PlatformAdminAssignment>(
        'SELECT * FROM list_platform_administrators()',
      );
      return result.rows;
    });
  }

  async appoint(
    actorUserId: string,
    input: { twitchUserId: unknown; role: unknown; permissions: unknown; reason: unknown },
  ): Promise<void> {
    if (typeof input.twitchUserId !== 'string' || !/^[0-9]{1,32}$/.test(input.twitchUserId)) {
      throw new BadRequestException('A valid numeric Twitch user ID is required.');
    }
    if (input.role !== 'owner' && input.role !== 'admin') {
      throw new BadRequestException('Role must be owner or admin.');
    }
    if (
      !Array.isArray(input.permissions) ||
      input.permissions.some((permission) => !PLATFORM_PERMISSIONS.includes(permission))
    ) {
      throw new BadRequestException('One or more platform permissions are invalid.');
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 1 || reason.length > 1000) {
      throw new BadRequestException('A reason between 1 and 1,000 characters is required.');
    }

    await this.database.transaction({ userId: actorUserId }, async (client) => {
      await client.query(
        'SELECT appoint_platform_administrator($1, $2::platform_administrator_role, $3::text[], $4)',
        [input.twitchUserId, input.role, input.permissions, reason],
      );
    });
  }

  async revoke(actorUserId: string, targetUserId: string, reasonInput: unknown): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(targetUserId)) {
      throw new BadRequestException('A valid target account ID is required.');
    }
    if (typeof reasonInput !== 'string' || reasonInput.trim().length < 1 || reasonInput.trim().length > 1000) {
      throw new BadRequestException('A reason between 1 and 1,000 characters is required.');
    }
    await this.database.transaction({ userId: actorUserId }, async (client) => {
      await client.query('SELECT revoke_platform_administrator($1, $2)', [
        targetUserId,
        reasonInput.trim(),
      ]);
    });
  }
}
