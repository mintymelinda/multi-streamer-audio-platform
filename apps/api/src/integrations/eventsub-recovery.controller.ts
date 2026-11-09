import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { EventSubRecoveryService } from './eventsub-recovery.service.js';

function actor(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new Error('Authenticated user context is missing.');
  return request.user;
}

function workspace(request: HttpRequest): WorkspaceRequestContext {
  if (!request.workspace) throw new Error('Verified workspace context is missing.');
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

@Controller('workspaces/:workspaceId/eventsub/deliveries')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
export class EventSubRecoveryController {
  constructor(
    @Inject(EventSubRecoveryService) private readonly recovery: EventSubRecoveryService,
  ) {}

  @Get('failed')
  @RequireWorkspacePermission('workspace:read')
  listFailed(@Req() request: HttpRequest) {
    return this.recovery.listFailed(workspace(request), actor(request));
  }

  @Post(':deliveryId/retry')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  retry(
    @Req() request: HttpRequest,
    @Param('deliveryId') deliveryId: string,
    @Body() body: unknown,
  ) {
    return this.recovery.retry(workspace(request), actor(request), deliveryId, reason(body));
  }

  @Post(':deliveryId/dismiss')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  dismiss(
    @Req() request: HttpRequest,
    @Param('deliveryId') deliveryId: string,
    @Body() body: unknown,
  ) {
    return this.recovery.dismiss(workspace(request), actor(request), deliveryId, reason(body));
  }
}
