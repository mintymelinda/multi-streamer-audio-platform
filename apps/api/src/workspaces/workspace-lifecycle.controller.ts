import {
  Body, Controller, Delete, Get, Inject, Param, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { HttpReply, HttpRequest } from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { WorkspaceAccessGuard } from './workspace-access.guard.js';
import { WorkspaceLifecycleService } from './workspace-lifecycle.service.js';

@Controller('workspaces/:workspaceId')
@UseGuards(SessionGuard, WorkspaceAccessGuard)
export class WorkspaceLifecycleController {
  constructor(@Inject(WorkspaceLifecycleService) private readonly lifecycle: WorkspaceLifecycleService) {}

  private userId(request: HttpRequest): string {
    if (!request.user) throw new UnauthorizedException('Sign-in is required.');
    return request.user.id;
  }

  @Get('export')
  async export(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    const document = await this.lifecycle.export(workspaceId as never, this.userId(request));
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="workspace-data-export.json"');
    reply.header('Cache-Control', 'private, no-store, max-age=0');
    reply.header('X-Content-Type-Options', 'nosniff');
    return document;
  }

  @Delete()
  @UseGuards(CsrfGuard)
  delete(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const confirmationName = typeof body === 'object' && body !== null && 'confirmationName' in body
      ? body.confirmationName : undefined;
    return this.lifecycle.delete(workspaceId as never, this.userId(request), confirmationName);
  }
}
