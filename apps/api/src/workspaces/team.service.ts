import type { VerifiedWorkspaceId } from '@platform/contracts';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedUser } from '../identity/http.types.js';
import { newOpaqueToken, sha256 } from '../identity/security.js';
import type { WorkspaceRole } from './workspace-permissions.js';
import { TwitchDirectoryService } from './twitch-directory.service.js';

export interface InvitationRecord {
  id: string;
  workspace_id: string;
  assigned_role: Exclude<WorkspaceRole, 'owner'>;
  status: string;
  created_at: Date;
  expires_at: Date;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

@Injectable()
export class TeamService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TwitchDirectoryService) private readonly twitchDirectory: TwitchDirectoryService,
  ) {}

  async listMembers(userId: string, workspaceId: VerifiedWorkspaceId) {
    const result = await this.database.transaction(
      { userId, verifiedWorkspaceId: workspaceId },
      (client) =>
      client.query(
        "SELECT m.user_id, u.twitch_user_id, m.role, m.status, m.created_at, m.revoked_at FROM workspace_memberships m JOIN platform_users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, m.created_at ASC",
        [workspaceId],
      ),
    );
    return result.rows;
  }

  async listWorkspaceInvitations(userId: string, workspaceId: VerifiedWorkspaceId) {
    const result = await this.database.transaction(
      { userId, verifiedWorkspaceId: workspaceId },
      (client) =>
      client.query<InvitationRecord>(
        "SELECT id, workspace_id, assigned_role, status, created_at, expires_at FROM workspace_invitations WHERE workspace_id = $1 AND status = 'pending' ORDER BY created_at DESC",
        [workspaceId],
      ),
    );
    return result.rows;
  }

  async createInvitation(
    actor: AuthenticatedUser,
    workspaceId: VerifiedWorkspaceId,
    username: unknown,
    roleInput: unknown,
    actorRole: WorkspaceRole,
  ) {
    if (typeof username !== 'string' || username.trim().length === 0) {
      throw new ConflictException('A Twitch username is required.');
    }
    const role = (roleInput ?? 'moderator') as string;
    if (!['admin', 'moderator', 'viewer'].includes(role)) {
      throw new ConflictException('Invitations can assign Admin, Moderator, or Viewer only.');
    }
    if (role === 'admin' && actorRole !== 'owner') {
      throw new ForbiddenException('Only the workspace owner can invite an Admin.');
    }
    const invitedTwitchUserId = await this.twitchDirectory.resolveUsername(username);
    if (invitedTwitchUserId === actor.twitchUserId) {
      throw new ConflictException('You already have access as the workspace owner or member.');
    }

    try {
      return await this.database.transaction(
        { userId: actor.id, verifiedWorkspaceId: workspaceId },
        async (client) => {
        const existingMembership = await client.query(
          "SELECT 1 FROM workspace_memberships m JOIN platform_users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.twitch_user_id = $2 AND m.status = 'active' LIMIT 1",
          [workspaceId, invitedTwitchUserId],
        );
        if (existingMembership.rowCount) {
          throw new ConflictException('That Twitch account is already a workspace member.');
        }
        const invitationId = randomUUID();
        const result = await client.query<InvitationRecord>(
          "INSERT INTO workspace_invitations (id, workspace_id, invited_twitch_user_id, assigned_role, token_hash, invited_by_user_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days') RETURNING id, workspace_id, assigned_role, status, created_at, expires_at",
          [
            invitationId,
            workspaceId,
            invitedTwitchUserId,
            role,
            sha256(newOpaqueToken()),
            actor.id,
          ],
        );
        await this.audit(
          client,
          workspaceId,
          actor.id,
          'team.invitation_created',
          'invitation',
          invitationId,
          { invitedTwitchUserId, assignedRole: role },
        );
        return result.rows[0];
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A pending invitation already exists for that Twitch account.');
      }
      throw error;
    }
  }

  async cancelInvitation(actor: AuthenticatedUser, workspaceId: VerifiedWorkspaceId, invitationId: string) {
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspaceId },
      async (client) => {
      const result = await client.query(
        "UPDATE workspace_invitations SET status = 'cancelled', responded_at = now() WHERE id = $1 AND workspace_id = $2 AND status = 'pending' RETURNING id",
        [invitationId, workspaceId],
      );
      if (!result.rowCount) throw new NotFoundException('Pending invitation not found.');
      await this.audit(
        client,
        workspaceId,
        actor.id,
        'team.invitation_cancelled',
        'invitation',
        invitationId,
      );
      return { cancelled: true };
    });
  }

  async changeMemberRole(
    actor: AuthenticatedUser,
    workspaceId: VerifiedWorkspaceId,
    memberUserId: string,
    roleInput: unknown,
    actorRole: WorkspaceRole,
  ) {
    if (!['admin', 'moderator', 'viewer'].includes(String(roleInput))) {
      throw new ConflictException('A member role must be Admin, Moderator, or Viewer.');
    }
    if (roleInput === 'admin' && actorRole !== 'owner') {
      throw new ForbiddenException('Only the workspace owner can assign Admin.');
    }
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspaceId },
      async (client) => {
      const result = await client.query(
        "UPDATE workspace_memberships SET role = $1, updated_at = now() WHERE workspace_id = $2 AND user_id = $3 AND status = 'active' AND role <> 'owner' RETURNING user_id",
        [roleInput, workspaceId, memberUserId],
      );
      if (!result.rowCount) throw new NotFoundException('Active non-owner member not found.');
      await this.audit(
        client,
        workspaceId,
        actor.id,
        'team.member_role_changed',
        'user',
        memberUserId,
        {
          role: roleInput,
        },
      );
      return { userId: memberUserId, role: roleInput };
    });
  }

  async revokeMember(actor: AuthenticatedUser, workspaceId: VerifiedWorkspaceId, memberUserId: string) {
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspaceId },
      async (client) => {
      const result = await client.query(
        "UPDATE workspace_memberships SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' AND role <> 'owner' RETURNING user_id",
        [workspaceId, memberUserId],
      );
      if (!result.rowCount) throw new NotFoundException('Active non-owner member not found.');
      await this.audit(
        client,
        workspaceId,
        actor.id,
        'team.member_access_revoked',
        'user',
        memberUserId,
      );
      return { revoked: true };
    });
  }

  async listMyInvitations(user: AuthenticatedUser) {
    const result = await this.database.transaction({ userId: user.id }, (client) =>
      client.query(
        "SELECT i.id, i.workspace_id, w.name AS workspace_name, i.assigned_role, i.created_at, i.expires_at FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE i.invited_twitch_user_id = $1 AND i.status = 'pending' AND i.expires_at > now() ORDER BY i.created_at DESC",
        [user.twitchUserId],
      ),
    );
    return result.rows;
  }

  async respondToInvitation(user: AuthenticatedUser, invitationId: string, accept: boolean) {
    return this.database.transaction({ userId: user.id }, async (client) => {
      const found = await client.query<{
        id: string;
        workspace_id: string;
        assigned_role: Exclude<WorkspaceRole, 'owner'>;
        status: string;
        expires_at: Date;
      }>(
        'SELECT id, workspace_id, assigned_role, status, expires_at FROM workspace_invitations WHERE id = $1 AND invited_twitch_user_id = $2 FOR UPDATE',
        [invitationId, user.twitchUserId],
      );
      const invitation = found.rows[0];
      if (!invitation) throw new NotFoundException('Invitation not found.');
      if (invitation.status !== 'pending') {
        throw new ConflictException('This invitation has already been answered or cancelled.');
      }
      if (invitation.expires_at.getTime() <= Date.now()) {
        await client.query(
          "UPDATE workspace_invitations SET status = 'expired', responded_at = now() WHERE id = $1",
          [invitationId],
        );
        return { expired: true };
      }
      await client.query(
        'UPDATE workspace_invitations SET status = $1, responded_at = now() WHERE id = $2',
        [accept ? 'accepted' : 'declined', invitationId],
      );
      if (!accept) return { accepted: false };

      const membership = await client.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', revoked_at = NULL, updated_at = now() WHERE workspace_memberships.status = 'revoked' RETURNING id",
        [invitation.workspace_id, user.id, invitation.assigned_role],
      );
      if (!membership.rowCount) {
        throw new ConflictException('You already have active access to this workspace.');
      }
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [
        invitation.workspace_id,
      ]);
      await this.audit(
        client,
        invitation.workspace_id,
        user.id,
        'team.invitation_accepted',
        'invitation',
        invitationId,
      );
      return {
        accepted: true,
        workspaceId: invitation.workspace_id,
        role: invitation.assigned_role,
      };
    });
  }

  private async audit(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
    eventType: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await client.query(
      'INSERT INTO audit_events (workspace_id, actor_user_id, event_type, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      [workspaceId, actorId, eventType, targetType, targetId, JSON.stringify(details)],
    );
  }
}
