import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
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
import { OverlayScenesService } from './overlay-scenes.service.js';

function user(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new UnauthorizedException('Sign-in is required.');
  return request.user;
}

function workspace(request: HttpRequest): WorkspaceRequestContext {
  if (!request.workspace) throw new UnauthorizedException('Workspace access is required.');
  return request.workspace;
}

function protectTokenResponse(reply: HttpReply): void {
  reply.header('Cache-Control', 'no-store, private');
  reply.header('Referrer-Policy', 'no-referrer');
}

@Controller('workspaces/:workspaceId/scenes')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
export class OverlayScenesController {
  constructor(@Inject(OverlayScenesService) private readonly scenes: OverlayScenesService) {}

  @Get()
  @RequireWorkspacePermission('workspace:read')
  list(@Req() request: HttpRequest) {
    return this.scenes.list(workspace(request).id, user(request).id);
  }


  @Post('starter')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  ensureStarter(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    protectTokenResponse(reply);
    return this.scenes.ensureStarter(workspace(request).id, user(request).id);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  create(
    @Req() request: HttpRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    const name =
      typeof body === 'object' && body !== null && 'name' in body
        ? (body as { name?: unknown }).name
        : undefined;
    if (typeof name !== 'string') throw new BadRequestException('A scene name is required.');
    protectTokenResponse(reply);
    return this.scenes.create(workspace(request).id, user(request).id, name);
  }

  @Put('order')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  reorder(@Req() request: HttpRequest, @Body() body: unknown) {
    const sceneIds = typeof body === 'object' && body !== null && 'sceneIds' in body
      ? (body as { sceneIds?: unknown }).sceneIds
      : undefined;
    return this.scenes.reorder(workspace(request).id, user(request).id, sceneIds);
  }

  @Patch(':sceneId')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  rename(@Req() request: HttpRequest, @Param('sceneId') sceneId: string, @Body() body: unknown) {
    const name = typeof body === 'object' && body !== null && 'name' in body
      ? (body as { name?: unknown }).name
      : undefined;
    return this.scenes.rename(workspace(request).id, user(request).id, sceneId, name);
  }

  @Delete(':sceneId')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  delete(@Req() request: HttpRequest, @Param('sceneId') sceneId: string) {
    return this.scenes.delete(workspace(request).id, user(request).id, sceneId);
  }

  @Get(':sceneId/editor')
  @RequireWorkspacePermission('workspace:read')
  editorState(@Req() request: HttpRequest, @Param('sceneId') sceneId: string) {
    return this.scenes.editorState(workspace(request).id, user(request).id, sceneId);
  }

  @Post(':sceneId/restore-defaults')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  restoreDefaults(
    @Req() request: HttpRequest,
    @Param('sceneId') sceneId: string,
    @Body() body: unknown,
  ) {
    if (!body || typeof body !== 'object' || !('expectedRevision' in body)) {
      throw new BadRequestException('expectedRevision is required.');
    }
    return this.scenes.restoreDefaults(
      workspace(request).id,
      user(request).id,
      sceneId,
      (body as { expectedRevision: unknown }).expectedRevision,
    );
  }

  @Put(':sceneId/draft')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  saveDraft(
    @Req() request: HttpRequest,
    @Param('sceneId') sceneId: string,
    @Body() body: unknown,
  ) {
    if (!body || typeof body !== 'object' || !('state' in body) || !('expectedRevision' in body)) {
      throw new BadRequestException('Scene state and expectedRevision are required.');
    }
    const input = body as { state: unknown; expectedRevision: unknown };
    return this.scenes.saveDraft(
      workspace(request).id,
      user(request).id,
      sceneId,
      input.state,
      input.expectedRevision,
    );
  }

  @Post(':sceneId/publish')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  publishDraft(
    @Req() request: HttpRequest,
    @Param('sceneId') sceneId: string,
    @Body() body: unknown,
  ) {
    if (!body || typeof body !== 'object' || !('expectedRevision' in body)) {
      throw new BadRequestException('expectedRevision is required.');
    }
    return this.scenes.publishDraft(
      workspace(request).id,
      user(request).id,
      sceneId,
      (body as { expectedRevision: unknown }).expectedRevision,
    );
  }

  @Post(':sceneId/access-token')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  rotateAccessToken(
    @Req() request: HttpRequest,
    @Param('sceneId') sceneId: string,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    protectTokenResponse(reply);
    return this.scenes.rotateAccessToken(workspace(request).id, user(request).id, sceneId);
  }

  @Delete(':sceneId/access-token')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  revokeAccessToken(
    @Req() request: HttpRequest,
    @Param('sceneId') sceneId: string,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    protectTokenResponse(reply);
    return this.scenes.revokeAccessToken(workspace(request).id, user(request).id, sceneId);
  }
}
