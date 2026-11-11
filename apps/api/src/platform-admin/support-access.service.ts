import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

export const SUPPORT_ACCESS_SCOPES = [
  'workspace.read',
  'requests.read',
  'providers.read',
] as const;

export type SupportAccessScope = (typeof SUPPORT_ACCESS_SCOPES)[number];

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

@Injectable()
export class SupportAccessService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async diagnostics(userId: string, workspaceId: string) {
    if (!validUuid(workspaceId)) throw new BadRequestException('A valid workspace ID is required.');
    return this.database.transaction({ userId }, async (client) => {
      const result = await client.query<{ diagnostics: Record<string, unknown> }>(
        'SELECT get_workspace_technical_diagnostics($1) AS diagnostics',
        [workspaceId],
      );
      return result.rows[0]?.diagnostics ?? null;
    });
  }

  async create(
    userId: string,
    input: { workspaceId: unknown; scopes: unknown; reason: unknown; durationMinutes: unknown },
  ) {
    if (typeof input.workspaceId !== 'string' || !validUuid(input.workspaceId)) {
      throw new BadRequestException('A valid workspace ID is required.');
    }
    if (
      !Array.isArray(input.scopes) ||
      input.scopes.length < 1 ||
      input.scopes.length > SUPPORT_ACCESS_SCOPES.length ||
      input.scopes.some((scope) => !SUPPORT_ACCESS_SCOPES.includes(scope))
    ) {
      throw new BadRequestException('Select one or more valid read-only support scopes.');
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 1000) {
      throw new BadRequestException('A reason between 1 and 1,000 characters is required.');
    }
    if (
      typeof input.durationMinutes !== 'number' ||
      !Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < 5 ||
      input.durationMinutes > 240
    ) {
      throw new BadRequestException('Support access must last between 5 and 240 minutes.');
    }

    return this.database.transaction({ userId }, async (client) => {
      const result = await client.query(
        'SELECT * FROM create_workspace_support_access($1, $2::text[], $3, $4)',
        [input.workspaceId, [...new Set(input.scopes)], reason, input.durationMinutes],
      );
      return result.rows[0] ?? null;
    });
  }

  async readContent(userId: string, grantId: string) {
    if (!validUuid(grantId)) throw new BadRequestException('A valid support grant ID is required.');
    return this.database.transaction({ userId }, async (client) => {
      const result = await client.query<{ content: Record<string, unknown> }>(
        'SELECT read_support_workspace_content($1) AS content',
        [grantId],
      );
      return result.rows[0]?.content ?? null;
    });
  }

  async listForWorkspace(userId: string, workspaceId: string) {
    if (!validUuid(workspaceId)) throw new BadRequestException('A valid workspace ID is required.');
    return this.database.transaction({ userId }, async (client) => {
      const result = await client.query(
        'SELECT * FROM list_workspace_support_access($1)',
        [workspaceId],
      );
      return result.rows;
    });
  }

  async listAuditForWorkspace(userId: string, workspaceId: string) {
    if (!validUuid(workspaceId)) throw new BadRequestException('A valid workspace ID is required.');
    return this.database.transaction({ userId }, async (client) => {
      const result = await client.query(
        'SELECT * FROM list_workspace_support_access_audit($1)',
        [workspaceId],
      );
      return result.rows;
    });
  }

  async revokeForWorkspace(userId: string, workspaceId: string, grantId: string, reasonInput: unknown) {
    if (!validUuid(workspaceId)) throw new BadRequestException('A valid workspace ID is required.');
    if (!validUuid(grantId)) throw new BadRequestException('A valid support grant ID is required.');
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (!reason || reason.length > 1000) {
      throw new BadRequestException('A reason between 1 and 1,000 characters is required.');
    }
    await this.database.transaction({ userId }, async (client) => {
      await client.query('SELECT revoke_workspace_support_access($1, $2, $3)', [workspaceId, grantId, reason]);
    });
  }
}
