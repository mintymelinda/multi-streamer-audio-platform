import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
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
    const user = requireAuthenticatedUser(request);
    const workspace = requireWorkspaceContext(request);
    return this.team.listMembers(user.id, workspace.id);
  }

  @Get('invitations')
  listInvitations(@Req() request: HttpRequest) {
    const user = requireAuthenticatedUser(request);
    const workspace = requireWorkspaceContext(request);
    return this.team.listWorkspaceInvitations(user.id, workspace.id);
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
    const workspace = requireWorkspaceContext(request);
    return this.team.createInvitation(
      user,
      workspace.id,
      username,
      role,
      workspace.role,
    );
  }

  @Delete('invitations/:invitationId')
  cancelInvitation(
    @Req() request: HttpRequest,
    @Param('invitationId') invitationId: string,
  ) {
    const user = requireAuthenticatedUser(request);
    const workspace = requireWorkspaceContext(request);
    return this.team.cancelInvitation(user, workspace.id, invitationId);
  }

  @Patch('members/:memberUserId')
  changeMemberRole(
    @Req() request: HttpRequest,
    @Param('memberUserId') memberUserId: string,
    @Body() body: unknown,
  ) {
    const role =
      typeof body === 'object' && body !== null && 'role' in body ? body.role : undefined;
    const user = requireAuthenticatedUser(request);
    const workspace = requireWorkspaceContext(request);
    return this.team.changeMemberRole(
      user,
      workspace.id,
      memberUserId,
      role,
      workspace.role,
    );
  }

  @Delete('members/:memberUserId')
  revokeMember(
    @Req() request: HttpRequest,
    @Param('memberUserId') memberUserId: string,
  ) {
    const user = requireAuthenticatedUser(request);
    const workspace = requireWorkspaceContext(request);
    return this.team.revokeMember(user, workspace.id, memberUserId);
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
