import { BadRequestException, Controller, Get, Inject, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { HttpReply, HttpRequest } from '../identity/http.types.js';
import { SessionGuard } from '../identity/session.guard.js';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard.js';
import { RequireWorkspacePermission, WorkspacePermissionGuard } from '../workspaces/workspace-permission.guard.js';
import { SpotifyConnectOAuthService } from './spotify-connect-oauth.service.js';

@Controller()
export class SpotifyConnectOAuthController {
  constructor(@Inject(SpotifyConnectOAuthService) private readonly oauth: SpotifyConnectOAuthService) {}

  @Get('workspaces/:workspaceId/providers/spotify/connect')
  @UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
  @RequireWorkspacePermission('workspace:manage')
  async start(@Req() request: HttpRequest, @Res() reply: HttpReply): Promise<HttpReply> {
    if (!request.user || !request.workspace) throw new BadRequestException('Authenticated workspace required.');
    const url = await this.oauth.begin({
      workspaceId: request.workspace.id, userId: request.user.id, sessionId: request.user.sessionId,
    });
    return reply.code(302).redirect(url);
  }

  @Get('providers/spotify/callback')
  @UseGuards(SessionGuard)
  async callback(
    @Req() request: HttpRequest, @Query('code') code: string | undefined,
    @Query('state') state: string | undefined, @Query('error') error: string | undefined,
    @Res() reply: HttpReply,
  ): Promise<HttpReply> {
    if (error || !code || !state || !request.user) {
      throw new BadRequestException('Spotify authorization was cancelled or could not be completed.');
    }
    await this.oauth.complete({ code, state, userId: request.user.id, sessionId: request.user.sessionId });
    return reply.code(302).redirect('/settings/integrations?spotify=connected');
  }
}
