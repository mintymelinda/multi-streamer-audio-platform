import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthenticatedUser,
  HttpRequest,
} from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { SupportAccessService } from './support-access.service.js';

function user(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new UnauthorizedException('Sign-in is required.');
  return request.user;
}

function objectBody(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

@Controller()
@UseGuards(SessionGuard)
export class SupportAccessController {
  constructor(@Inject(SupportAccessService) private readonly support: SupportAccessService) {}

  @Get('platform-admin/diagnostics/workspaces/:workspaceId')
  diagnostics(@Req() request: HttpRequest, @Param('workspaceId') workspaceId: string) {
    return this.support.diagnostics(user(request).id, workspaceId);
  }

  @Post('platform-admin/support-access')
  @UseGuards(CsrfGuard)
  create(@Req() request: HttpRequest, @Body() body: unknown) {
    const input = objectBody(body);
    return this.support.create(user(request).id, {
      workspaceId: input.workspaceId,
      scopes: input.scopes,
      reason: input.reason,
      durationMinutes: input.durationMinutes,
    });
  }

  @Get('platform-admin/support-access/:grantId/content')
  readContent(@Req() request: HttpRequest, @Param('grantId') grantId: string) {
    return this.support.readContent(user(request).id, grantId);
  }

  @Get('workspaces/:workspaceId/support-access')
  listForWorkspace(@Req() request: HttpRequest, @Param('workspaceId') workspaceId: string) {
    return this.support.listForWorkspace(user(request).id, workspaceId);
  }

  @Delete('workspaces/:workspaceId/support-access/:grantId')
  @UseGuards(CsrfGuard)
  async revokeForWorkspace(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
  ) {
    await this.support.revokeForWorkspace(
      user(request).id,
      workspaceId,
      grantId,
      objectBody(body).reason,
    );
    return { success: true };
  }
}
