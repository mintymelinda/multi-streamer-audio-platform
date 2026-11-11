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
  'status.manage',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
export type PlatformAdminRole = 'owner' | 'admin';


export interface ServiceIncidentRecord {
  id: string;
  title: string;
  summary: string;
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  impact: 'degraded' | 'partial_outage' | 'major_outage';
  affected_services: string[];
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

export interface PlatformAccountRecord {
  user_id: string;
  twitch_user_id: string;
  status: 'active' | 'suspended';
  created_at: Date;
  suspended_at: Date | null;
  suspension_reason: string | null;
}

export interface PlatformWorkspaceRecord {
  workspace_id: string;
  name: string;
  broadcaster_twitch_user_id: string;
  status: 'active' | 'restricted' | 'suspended';
  restriction_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

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


  async listAccounts(actorUserId: string, searchInput?: unknown): Promise<PlatformAccountRecord[]> {
    const search = this.validateSearch(searchInput);
    return this.database.transaction({ userId: actorUserId }, async (client) => {
      const result = await client.query<PlatformAccountRecord>(
        'SELECT * FROM list_platform_accounts($1)',
        [search],
      );
      return result.rows;
    });
  }

  async listWorkspaces(actorUserId: string, searchInput?: unknown): Promise<PlatformWorkspaceRecord[]> {
    const search = this.validateSearch(searchInput);
    return this.database.transaction({ userId: actorUserId }, async (client) => {
      const result = await client.query<PlatformWorkspaceRecord>(
        'SELECT * FROM list_platform_workspaces($1)',
        [search],
      );
      return result.rows;
    });
  }

  async setAccountStatus(
    actorUserId: string,
    targetUserId: string,
    statusInput: unknown,
    reasonInput: unknown,
  ): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId)) {
      throw new BadRequestException('A valid target account ID is required.');
    }
    if (statusInput !== 'active' && statusInput !== 'suspended') {
      throw new BadRequestException('Account status must be active or suspended.');
    }
    const reason = this.validateReason(reasonInput);
    await this.database.transaction({ userId: actorUserId }, async (client) => {
      await client.query(
        'SELECT set_platform_account_status($1, $2::account_status, $3)',
        [targetUserId, statusInput, reason],
      );
    });
  }

  async setWorkspaceStatus(
    actorUserId: string,
    workspaceId: string,
    statusInput: unknown,
    reasonInput: unknown,
  ): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
      throw new BadRequestException('A valid workspace ID is required.');
    }
    if (statusInput !== 'active' && statusInput !== 'restricted' && statusInput !== 'suspended') {
      throw new BadRequestException('Workspace status must be active, restricted, or suspended.');
    }
    const reason = this.validateReason(reasonInput);
    await this.database.transaction({ userId: actorUserId }, async (client) => {
      await client.query(
        'SELECT set_platform_workspace_status($1, $2::workspace_status, $3)',
        [workspaceId, statusInput, reason],
      );
    });
  }

  private validateSearch(searchInput: unknown): string | null {
    if (searchInput === undefined || searchInput === null || searchInput === '') return null;
    if (typeof searchInput !== 'string' || searchInput.trim().length > 120) {
      throw new BadRequestException('Search must be 120 characters or fewer.');
    }
    return searchInput.trim() || null;
  }

  private validateReason(reasonInput: unknown): string {
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (reason.length < 1 || reason.length > 1000) {
      throw new BadRequestException('A reason between 1 and 1,000 characters is required.');
    }
    return reason;
  }


  async listServiceIncidents(actorUserId: string): Promise<ServiceIncidentRecord[]> {
    return this.database.transaction({ userId: actorUserId }, async (client) => {
      const result = await client.query<ServiceIncidentRecord>(
        'SELECT * FROM list_platform_service_incidents()',
      );
      return result.rows;
    });
  }

  async saveServiceIncident(
    actorUserId: string,
    input: {
      id?: unknown;
      title?: unknown;
      summary?: unknown;
      status?: unknown;
      impact?: unknown;
      affectedServices?: unknown;
    },
  ): Promise<{ id: string }> {
    const id = input.id === undefined || input.id === null ? null : input.id;
    if (id !== null && (
      typeof id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    )) {
      throw new BadRequestException('A valid incident ID is required.');
    }
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (title.length < 5 || title.length > 160) {
      throw new BadRequestException('Incident title must be between 5 and 160 characters.');
    }
    if (summary.length < 10 || summary.length > 2000) {
      throw new BadRequestException('Incident summary must be between 10 and 2,000 characters.');
    }
    const statuses = ['investigating', 'identified', 'monitoring', 'resolved'];
    const impacts = ['degraded', 'partial_outage', 'major_outage'];
    const services = ['all', 'api', 'dashboard', 'overlay', 'playback', 'authentication', 'twitch', 'spotify', 'lyrion'];
    if (typeof input.status !== 'string' || !statuses.includes(input.status)) {
      throw new BadRequestException('Incident status is invalid.');
    }
    if (typeof input.impact !== 'string' || !impacts.includes(input.impact)) {
      throw new BadRequestException('Incident impact is invalid.');
    }
    if (
      !Array.isArray(input.affectedServices)
      || input.affectedServices.length < 1
      || input.affectedServices.length > 9
      || input.affectedServices.some((service) => typeof service !== 'string' || !services.includes(service))
      || new Set(input.affectedServices).size !== input.affectedServices.length
    ) {
      throw new BadRequestException('Select one or more valid affected services.');
    }
    return this.database.transaction({ userId: actorUserId }, async (client) => {
      const result = await client.query<{ id: string }>(
        'SELECT set_platform_service_incident($1::uuid, $2, $3, $4::service_incident_status, $5::service_incident_impact, $6::text[]) AS id',
        [id, title, summary, input.status, input.impact, input.affectedServices],
      );
      const saved = result.rows[0];
      if (!saved) throw new Error('Incident save returned no record.');
      return { id: saved.id };
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
