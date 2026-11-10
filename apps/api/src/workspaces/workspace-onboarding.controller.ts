import {
  BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Patch, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser, HttpRequest, WorkspaceRequestContext } from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { WorkspaceAccessGuard } from './workspace-access.guard.js';
import { RequireWorkspacePermission, WorkspacePermissionGuard } from './workspace-permission.guard.js';
import { WorkspaceOnboardingService } from './workspace-onboarding.service.js';

function actor(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new UnauthorizedException('Sign-in is required.');
  return request.user;
}
function workspace(request: HttpRequest): WorkspaceRequestContext {
  if (!request.workspace) throw new NotFoundException('Workspace not found.');
  return request.workspace;
}
function bodyRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

@Controller('workspaces/:workspaceId/onboarding')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
export class WorkspaceOnboardingController {
  constructor(@Inject(WorkspaceOnboardingService) private readonly onboarding: WorkspaceOnboardingService) {}

  @Get()
  @RequireWorkspacePermission('workspace:read')
  get(@Req() request: HttpRequest) {
    return this.onboarding.get(workspace(request), actor(request));
  }

  @Patch('steps/:step')
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  updateStep(@Req() request: HttpRequest, @Param('step') step: string, @Body() body: unknown) {
    return this.onboarding.updateStep(workspace(request), actor(request), step, bodyRecord(body).status);
  }

  @Patch()
  @UseGuards(CsrfGuard)
  @RequireWorkspacePermission('workspace:manage')
  setDismissed(@Req() request: HttpRequest, @Body() body: unknown) {
    const dismissed = bodyRecord(body).dismissed;
    if (typeof dismissed !== 'boolean') throw new BadRequestException('dismissed must be a boolean.');
    return this.onboarding.setDismissed(workspace(request), actor(request), dismissed);
  }
}
