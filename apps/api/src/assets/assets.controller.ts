import { BadRequestException, UnauthorizedException, Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser, HttpRequest, WorkspaceRequestContext } from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard.js';
import { RequireWorkspacePermission, WorkspacePermissionGuard } from '../workspaces/workspace-permission.guard.js';
import { AssetsService } from './assets.service.js';

function identity(request: HttpRequest): { user: AuthenticatedUser; workspace: WorkspaceRequestContext } {
  if (!request.user || !request.workspace) throw new UnauthorizedException('Authenticated workspace access is required.');
  return { user: request.user, workspace: request.workspace };
}

@Controller('workspaces/:workspaceId/assets')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
export class AssetsController {
  constructor(@Inject(AssetsService) private readonly assets: AssetsService) {}

  @Get()
  @RequireWorkspacePermission('workspace:read')
  list(@Req() request: HttpRequest, @Query('folder') folder?: string) {
    const { user, workspace } = identity(request);
    return this.assets.list(workspace.id, user.id, folder);
  }

  @Post('upload-intent')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  createUpload(@Req() request: HttpRequest, @Body() body: unknown) {
    if (!body || typeof body !== 'object') throw new BadRequestException('Upload details are required.');
    const { user, workspace } = identity(request);
    const input = body as { name?: unknown; folder?: unknown; contentType?: unknown };
    return this.assets.createUpload(workspace.id, user.id, input as { name: unknown; folder?: unknown; contentType: unknown });
  }

  @Post(':assetId/replacement-upload')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  replace(@Req() request: HttpRequest, @Param('assetId') assetId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || !('contentType' in body)) throw new BadRequestException('Image contentType is required.');
    const { user, workspace } = identity(request);
    return this.assets.createReplacementUpload(workspace.id, user.id, assetId, (body as { contentType: unknown }).contentType);
  }

  @Post(':assetId/complete')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  complete(@Req() request: HttpRequest, @Param('assetId') assetId: string) {
    const { user, workspace } = identity(request);
    return this.assets.completeUpload(workspace.id, user.id, assetId);
  }

  @Put(':assetId')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  update(@Req() request: HttpRequest, @Param('assetId') assetId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object') throw new BadRequestException('Asset updates are required.');
    const { user, workspace } = identity(request);
    return this.assets.update(workspace.id, user.id, assetId, body as { name?: unknown; folder?: unknown });
  }

  @Get(':assetId/usage')
  @RequireWorkspacePermission('workspace:read')
  usage(@Req() request: HttpRequest, @Param('assetId') assetId: string) {
    const { user, workspace } = identity(request);
    return this.assets.usage(workspace.id, user.id, assetId);
  }

  @Delete(':assetId')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  remove(@Req() request: HttpRequest, @Param('assetId') assetId: string) {
    const { user, workspace } = identity(request);
    return this.assets.remove(workspace.id, user.id, assetId);
  }
}
