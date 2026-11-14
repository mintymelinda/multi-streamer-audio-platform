import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';

export interface WorkspaceRecord {
  id: string;
  name: string;
  status: 'active' | 'restricted' | 'suspended';
  role: 'owner' | 'admin' | 'moderator' | 'viewer';
  created_at: Date;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

@Injectable()
export class WorkspacesService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(userId: string): Promise<WorkspaceRecord[]> {
    const result = await this.database.transaction({ userId }, (client) =>
      client.query<WorkspaceRecord>(
        "SELECT w.id, w.name, w.status, m.role, w.created_at FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 AND m.status = 'active' ORDER BY w.created_at ASC",
        [userId],
      ),
    );
    return result.rows;
  }

  async create(userId: string, nameInput: unknown): Promise<WorkspaceRecord> {
    if (typeof nameInput !== 'string')
      throw new BadRequestException('A workspace name is required.');
    const name = nameInput.trim();
    if (name.length < 1 || name.length > 80) {
      throw new BadRequestException('Workspace names must contain between 1 and 80 characters.');
    }
    try {
      return await this.database.transaction({ userId }, async (client: PoolClient) => {
        const account = await client.query<{ twitch_user_id: string; status: string }>(
          'SELECT twitch_user_id, status FROM platform_users WHERE id = $1',
          [userId],
        );
        const owner = account.rows[0];
        if (owner?.status !== 'active') {
          throw new ForbiddenException(
            'An active Twitch account is required to create a workspace.',
          );
        }
        const workspaceId = randomUUID();
        const created = await client.query<Omit<WorkspaceRecord, 'role'>>(
          'INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES ($1, $2, $3, $4) RETURNING id, name, status, created_at',
          [workspaceId, name, userId, owner.twitch_user_id],
        );
        await client.query(
          "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
          [workspaceId, userId],
        );
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        await client.query('INSERT INTO workspace_onboarding (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING', [workspaceId]);
        await client.query(
          "INSERT INTO audit_events (workspace_id, actor_user_id, event_type, target_type, target_id) VALUES ($1, $2, 'workspace.created', 'workspace', $3)",
          [workspaceId, userId, workspaceId],
        );
        const workspace = created.rows[0];
        if (!workspace) throw new Error('Workspace creation did not return a record.');
        return { ...workspace, role: 'owner' };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'This Twitch account already owns a workspace or the broadcaster identity is in use.',
        );
      }
      throw error;
    }
  }
}
