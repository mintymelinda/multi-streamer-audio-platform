import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthenticatedUser,
  HttpReply,
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
import { TwitchIntegrationService } from './twitch-integration.service.js';

function actor(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new UnauthorizedException('Sign-in is required.');
  return request.user;
}

function workspace(request: HttpRequest): WorkspaceRequestContext {
  if (!request.workspace) throw new UnauthorizedException('Workspace access is required.');
  return request.workspace;
}

@Controller()
export class TwitchIntegrationController {
  constructor(
    @Inject(TwitchIntegrationService) private readonly integration: TwitchIntegrationService,
  ) {}

  @Post('workspaces/:workspaceId/twitch/authorization')
  @UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard, CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  async beginAuthorization(
    @Req() request: HttpRequest,
    @Res() reply: HttpReply,
  ): Promise<HttpReply> {
    const context = workspace(request);
    if (context.role !== 'owner') {
      throw new ForbiddenException('Only the workspace owner can authorize its Twitch channel.');
    }
    const url = await this.integration.beginAuthorization(context, actor(request), '/');
    return reply.code(302).redirect(url);
  }

  @Get('auth/twitch/integration/callback')
  @UseGuards(SessionGuard)
  async completeAuthorization(
    @Req() request: HttpRequest,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() reply: HttpReply,
  ): Promise<HttpReply> {
    if (error) throw new UnauthorizedException('Twitch channel authorization was cancelled.');
    const returnPath = await this.integration.completeAuthorization(actor(request), code, state);
    return reply.code(302).redirect(returnPath);
  }

  @Get('workspaces/:workspaceId/twitch/authorization')
  @UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
  @RequireWorkspacePermission('workspace:read')
  getStatus(@Req() request: HttpRequest) {
    return this.integration.getStatus(workspace(request), actor(request));
  }
}
