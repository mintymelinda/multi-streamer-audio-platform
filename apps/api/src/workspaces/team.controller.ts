import {
  Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { CsrfGuard } from '../identity/csrf.guard.js';
import type { HttpRequest } from '../identity/http.types.js';
import { SessionGuard } from '../identity/session.guard.js';
import { WorkspaceAccessGuard } from './workspace-access.guard.js';
import {
  RequireWorkspacePermission, WorkspacePermissionGuard,
} from './workspace-permission.guard.js';
import { TeamService } from './team.service.js';

@Controller('workspaces/:workspaceId')
@UseGuards(SessionGuard, WorkspaceAccessGuard, CsrfGuard, WorkspacePermissionGuard)
@RequireWorkspacePermission('team:manage')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('members')
  listMembers(@Req() request: HttpRequest, @Param('workspaceId') workspaceId: string) {
    return this.team.listMembers(request.user!.id, workspaceId);
  }

  @Get('invitations')
  listInvitations(@Req() request: HttpRequest, @Param('workspaceId') workspaceId: string) {
    return this.team.listWorkspaceInvitations(request.user!.id, workspaceId);
  }

  @Post('invitations')
  createInvitation(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const value = typeof body === 'object' && body !== null ? body : {};
    const username = 'twitchUsername' in value ? value.twitchUsername : undefined;
    const role = 'role' in value ? value.role : undefined;
    return this.team.createInvitation(
      request.user!, workspaceId, username, role, request.workspace!.role,
    );
  }

  @Delete('invitations/:invitationId')
  cancelInvitation(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.team.cancelInvitation(request.user!, workspaceId, invitationId);
  }

  @Patch('members/:memberUserId')
  changeMemberRole(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('memberUserId') memberUserId: string,
    @Body() body: unknown,
  ) {
    const role = typeof body === 'object' && body !== null && 'role' in body ? body.role : undefined;
    return this.team.changeMemberRole(
      request.user!, workspaceId, memberUserId, role, request.workspace!.role,
    );
  }

  @Delete('members/:memberUserId')
  revokeMember(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('memberUserId') memberUserId: string,
  ) {
    return this.team.revokeMember(request.user!, workspaceId, memberUserId);
  }
}

@Controller('me/invitations')
@UseGuards(SessionGuard, CsrfGuard)
export class MyInvitationsController {
  constructor(private readonly team: TeamService) {}

  @Get()
  list(@Req() request: HttpRequest) {
    return this.team.listMyInvitations(request.user!);
  }

  @Post(':invitationId/accept')
  accept(@Req() request: HttpRequest, @Param('invitationId') invitationId: string) {
    return this.team.respondToInvitation(request.user!, invitationId, true);
  }

  @Post(':invitationId/decline')
  decline(@Req() request: HttpRequest, @Param('invitationId') invitationId: string) {
    return this.team.respondToInvitation(request.user!, invitationId, false);
  }
}
