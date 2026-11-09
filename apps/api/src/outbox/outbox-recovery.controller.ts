import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Inject,
  Param,
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
import { OutboxRecoveryService } from './outbox-recovery.service.js';

function actor(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new NotFoundException('Sign-in is required.');
  return request.user;
}

function workspace(request: HttpRequest): WorkspaceRequestContext {
  if (!request.workspace) throw new NotFoundException('Workspace access is required.');
  return request.workspace;
}

function reason(body: unknown): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('reason' in body) ||
    typeof body.reason !== 'string'
  ) {
    throw new BadRequestException('A recovery reason is required.');
  }
  return body.reason;
}

@Controller('workspaces/:workspaceId/outbox/events')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
export class OutboxRecoveryController {
  constructor(@Inject(OutboxRecoveryService) private readonly recovery: OutboxRecoveryService) {}

  @Get('failed')
  @RequireWorkspacePermission('workspace:read')
  listFailed(@Req() request: HttpRequest) {
    return this.recovery.listFailed(workspace(request), actor(request));
  }

  @Post(':eventId/retry')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  retry(@Req() request: HttpRequest, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.recovery.retry(workspace(request), actor(request), eventId, reason(body));
  }

  @Post(':eventId/dismiss')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  dismiss(@Req() request: HttpRequest, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.recovery.dismiss(workspace(request), actor(request), eventId, reason(body));
  }
}
