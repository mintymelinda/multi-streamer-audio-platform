import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthenticatedUser,
  HttpRequest,
  WorkspaceRequestContext,
} from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { WorkspaceAccessGuard } from './workspace-access.guard.js';
import {
  RequireWorkspacePermission,
  WorkspacePermissionGuard,
} from './workspace-permission.guard.js';
import { TeamService } from './team.service.js';

function requireAuthenticatedUser(request: HttpRequest): AuthenticatedUser {
  const user = request.user;
  if (!user) throw new UnauthorizedException('Sign-in is required.');
  return user;
}

function requireWorkspaceContext(request: HttpRequest): WorkspaceRequestContext {
  const workspace = request.workspace;
  if (!workspace) throw new NotFoundException('Workspace not found.');
  return workspace;
}

@Controller('workspaces/:workspaceId')
@UseGuards(SessionGuard, WorkspaceAccessGuard, CsrfGuard, WorkspacePermissionGuard)
@RequireWorkspacePermission('team:manage')
export class TeamController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  @Get('members')
  listMembers(@Req() request: HttpRequest) {
    return this.team.listMembers(requireAuthenticatedUser(request).id, requireWorkspaceContext(request).id);
  }

  @Get('invitations')
  listInvitations(@Req() request: HttpRequest) {
    return this.team.listWorkspaceInvitations(requireAuthenticatedUser(request).id, requireWorkspaceContext(request).id);
  }

  @Post('invitations')
  createInvitation(
    @Req() request: HttpRequest,
    @Body() body: unknown,
  ) {
    const value = typeof body === 'object' && body !== null ? body : {};
    const username = 'twitchUsername' in value ? value.twitchUsername : undefined;
    const role = 'role' in value ? value.role : undefined;
    const user = requireAuthenticatedUser(request);
    const workspaceRole = requireWorkspaceContext(request).role;
    return this.team.createInvitation(user, requireWorkspaceContext(request).id, username, role, workspaceRole);
  }

  @Delete('invitations/:invitationId')
  cancelInvitation(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.team.cancelInvitation(requireAuthenticatedUser(request), requireWorkspaceContext(request).id, invitationId);
  }

  @Patch('members/:memberUserId')
  changeMemberRole(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('memberUserId') memberUserId: string,
    @Body() body: unknown,
  ) {
    const role =
      typeof body === 'object' && body !== null && 'role' in body ? body.role : undefined;
    const user = requireAuthenticatedUser(request);
    const workspaceRole = requireWorkspaceContext(request).role;
    return this.team.changeMemberRole(user, requireWorkspaceContext(request).id, memberUserId, role, workspaceRole);
  }

  @Delete('members/:memberUserId')
  revokeMember(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('memberUserId') memberUserId: string,
  ) {
    return this.team.revokeMember(requireAuthenticatedUser(request), requireWorkspaceContext(request).id, memberUserId);
  }
}

@Controller('me/invitations')
@UseGuards(SessionGuard, CsrfGuard)
export class MyInvitationsController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  @Get()
  list(@Req() request: HttpRequest) {
    return this.team.listMyInvitations(requireAuthenticatedUser(request));
  }

  @Post(':invitationId/accept')
  accept(@Req() request: HttpRequest, @Param('invitationId') invitationId: string) {
    return this.team.respondToInvitation(requireAuthenticatedUser(request), invitationId, true);
  }

  @Post(':invitationId/decline')
  decline(@Req() request: HttpRequest, @Param('invitationId') invitationId: string) {
    return this.team.respondToInvitation(requireAuthenticatedUser(request), invitationId, false);
  }
}
