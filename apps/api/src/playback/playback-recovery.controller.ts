import {
  BadRequestException,
  Body,
  Controller,
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
import { PlaybackRecoveryService } from './playback-recovery.service.js';

function actor(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new BadRequestException('Sign-in is required.');
  return request.user;
}

function workspace(request: HttpRequest): WorkspaceRequestContext {
  if (!request.workspace) throw new BadRequestException('Workspace access is required.');
  return request.workspace;
}

function recoveryReason(body: unknown): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('reason' in body) ||
    typeof body.reason !== 'string'
  ) {
    throw new BadRequestException('A recovery reason is required.');
  }
  const reason = body.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new BadRequestException('A recovery reason between 10 and 500 characters is required.');
  }
  return reason;
}

@Controller('workspaces/:workspaceId/playback/requests/:requestId/recovery')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
@RequireWorkspacePermission('workspace:manage')
export class PlaybackRecoveryController {
  constructor(
    @Inject(PlaybackRecoveryService)
    private readonly recovery: PlaybackRecoveryService,
  ) {}

  @Post('retry')
  @UseGuards(CsrfGuard)
  retry(@Req() request: HttpRequest, @Param('requestId') requestId: string, @Body() body: unknown) {
    return this.recovery.retry({
      workspaceId: workspace(request).id,
      requestId,
      actorId: actor(request).id,
      reason: recoveryReason(body),
    });
  }

  @Post('reroute')
  @UseGuards(CsrfGuard)
  reroute(
    @Req() request: HttpRequest,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    const record = typeof body === 'object' && body !== null ? body : {};
    const providerInstanceId =
      'providerInstanceId' in record && typeof record.providerInstanceId === 'string'
        ? record.providerInstanceId.trim()
        : '';
    if (!providerInstanceId) throw new BadRequestException('providerInstanceId is required.');
    return this.recovery.reroute({
      workspaceId: workspace(request).id,
      requestId,
      actorId: actor(request).id,
      reason: recoveryReason(body),
      providerInstanceId,
    });
  }

  @Post('skip')
  @UseGuards(CsrfGuard)
  skip(@Req() request: HttpRequest, @Param('requestId') requestId: string, @Body() body: unknown) {
    return this.recovery.skip({
      workspaceId: workspace(request).id,
      requestId,
      actorId: actor(request).id,
      reason: recoveryReason(body),
    });
  }

  @Post('dismiss')
  @UseGuards(CsrfGuard)
  dismiss(
    @Req() request: HttpRequest,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    return this.recovery.dismiss({
      workspaceId: workspace(request).id,
      requestId,
      actorId: actor(request).id,
      reason: recoveryReason(body),
    });
  }
}
