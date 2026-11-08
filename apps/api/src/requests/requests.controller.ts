import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  BadRequestException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
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
import { RequestsService } from './requests.service.js';

function user(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new UnauthorizedException('Sign-in is required.');
  return request.user;
}
function workspace(request: HttpRequest): WorkspaceRequestContext {
  if (!request.workspace) throw new NotFoundException('Workspace not found.');
  return request.workspace;
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new BadRequestException(`${field} must be a string no longer than ${max} characters.`);
  }
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestException(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 50 ||
      value.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > 100)) {
    throw new BadRequestException(`${field} must contain up to 50 non-empty strings of at most 100 characters.`);
  }
  return value.map((item: string) => item.trim());
}

@Controller('workspaces/:workspaceId')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
export class RequestsController {
  constructor(@Inject(RequestsService) private readonly requests: RequestsService) {}

  @Post('requests')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('request:submit')
  submit(@Req() request: HttpRequest, @Body() body: unknown) {
    const data = record(body);
    return this.requests.submit({
      workspace: workspace(request),
      actor: user(request),
      source: 'dashboard',
      title: optionalString(data.title, 'title', 500) ?? '',
      artist: optionalString(data.artist, 'artist', 500),
      mediaUrl: optionalString(data.mediaUrl, 'mediaUrl', 2048),
      provider: optionalString(data.provider, 'provider', 40),
      mediaId: optionalString(data.mediaId, 'mediaId', 256),
      requesterDisplayName: optionalString(data.requesterDisplayName, 'requesterDisplayName', 100),
      metadata: record(data.metadata),
      sourceEventId: optionalString(data.idempotencyKey, 'idempotencyKey', 200),
    });
  }

  @Get('requests/settings')
  @RequireWorkspacePermission('workspace:read')
  getSettings(@Req() request: HttpRequest) {
    return this.requests.getSettings(workspace(request), user(request).id);
  }

  @Patch('requests/settings')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  updateSettings(@Req() request: HttpRequest, @Body() body: unknown) {
    const data = record(body);
    const moderationMode = data.moderationMode;
    if (moderationMode !== 'automatic' && moderationMode !== 'manual' && moderationMode !== 'filtered') {
      throw new BadRequestException('moderationMode must be automatic, manual, or filtered.');
    }
    return this.requests.updateSettings(workspace(request), user(request), {
      moderationMode,
      queueLimit: integer(data.queueLimit, 'queueLimit', 1, 500),
      perUserLimit: integer(data.perUserLimit, 'perUserLimit', 1, 100),
      perSourceLimit: integer(data.perSourceLimit, 'perSourceLimit', 1, 500),
      holdTerms: stringArray(data.holdTerms, 'holdTerms'),
      rejectTerms: stringArray(data.rejectTerms, 'rejectTerms'),
    });
  }

  @Get('requests')
  @RequireWorkspacePermission('workspace:read')
  list(@Req() request: HttpRequest) {
    return this.requests.list(workspace(request), user(request).id);
  }

  @Get('queue')
  @RequireWorkspacePermission('workspace:read')
  queue(@Req() request: HttpRequest) {
    return this.requests.queue(workspace(request), user(request).id);
  }

  @Patch('requests/:requestId/moderation')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('request:moderate')
  moderate(
    @Req() request: HttpRequest,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    const action = record(body).action;
    if (action !== 'approve' && action !== 'reject' && action !== 'hold') {
      throw new BadRequestException('action must be approve, reject, or hold.');
    }
    const reason = optionalString(record(body).reason, 'reason', 500);
    return this.requests.moderate(workspace(request), user(request), requestId, action, reason);
  }

  @Patch('requests/:requestId/cancel')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('request:submit')
  cancel(@Req() request: HttpRequest, @Param('requestId') requestId: string) {
    return this.requests.cancel(workspace(request), user(request), requestId);
  }
}
