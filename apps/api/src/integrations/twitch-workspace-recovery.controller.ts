import {
  NotFoundException,
  Controller,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthenticatedUser,
  HttpRequest,
  WorkspaceRequestContext,
} from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import {
  RequireWorkspacePermission,
  WorkspacePermissionGuard,
} from '../workspaces/workspace-permission.guard.js';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard.js';
import { TwitchWorkspaceRecoveryService } from './twitch-workspace-recovery.service.js';

function actor(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new NotFoundException('Sign-in is required.');
  return request.user;
}

function workspace(request: HttpRequest): WorkspaceRequestContext {
  if (!request.workspace) throw new NotFoundException('Workspace access is required.');
  return request.workspace;
}

@Controller('workspaces/:workspaceId/twitch')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
export class TwitchWorkspaceRecoveryController {
  constructor(
    @Inject(TwitchWorkspaceRecoveryService)
    private readonly recovery: TwitchWorkspaceRecoveryService,
  ) {}

  @Post('recovery')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  recover(@Req() request: HttpRequest) {
    return this.recovery.recover(workspace(request), actor(request));
  }
}
