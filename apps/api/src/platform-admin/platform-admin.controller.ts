import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Post,
  Param,
  Patch,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser, HttpRequest } from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { PlatformAdminService } from './platform-admin.service.js';

function authenticatedUser(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new UnauthorizedException('Sign-in is required.');
  return request.user;
}

@Controller('platform-admin')
@UseGuards(SessionGuard)
export class PlatformAdminController {
  constructor(@Inject(PlatformAdminService) private readonly platformAdmin: PlatformAdminService) {}

  @Get('me')
  access(@Req() request: HttpRequest) {
    return this.platformAdmin.access(authenticatedUser(request).id);
  }


  @Get('accounts')
  listAccounts(@Req() request: HttpRequest, @Query('search') search?: string) {
    return this.platformAdmin.listAccounts(authenticatedUser(request).id, search);
  }

  @Get('workspaces')
  listWorkspaces(@Req() request: HttpRequest, @Query('search') search?: string) {
    return this.platformAdmin.listWorkspaces(authenticatedUser(request).id, search);
  }

  @Post('accounts/:userId/status')
  @UseGuards(CsrfGuard)
  setAccountStatus(
    @Req() request: HttpRequest,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    const input = typeof body === 'object' && body !== null
      ? body as { status?: unknown; reason?: unknown }
      : {};
    return this.platformAdmin.setAccountStatus(
      authenticatedUser(request).id, userId, input.status, input.reason,
    ).then(() => ({ success: true }));
  }

  @Post('workspaces/:workspaceId/status')
  @UseGuards(CsrfGuard)
  setWorkspaceStatus(
    @Req() request: HttpRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const input = typeof body === 'object' && body !== null
      ? body as { status?: unknown; reason?: unknown }
      : {};
    return this.platformAdmin.setWorkspaceStatus(
      authenticatedUser(request).id, workspaceId, input.status, input.reason,
    ).then(() => ({ success: true }));
  }

  @Get('incidents')
  listServiceIncidents(@Req() request: HttpRequest) {
    return this.platformAdmin.listServiceIncidents(authenticatedUser(request).id);
  }

  @Post('incidents')
  @UseGuards(CsrfGuard)
  createServiceIncident(@Req() request: HttpRequest, @Body() body: unknown) {
    const input = typeof body === 'object' && body !== null
      ? body as {
        title?: unknown;
        summary?: unknown;
        status?: unknown;
        impact?: unknown;
        affectedServices?: unknown;
      }
      : {};
    return this.platformAdmin.saveServiceIncident(authenticatedUser(request).id, input);
  }

  @Patch('incidents/:incidentId')
  @UseGuards(CsrfGuard)
  updateServiceIncident(
    @Req() request: HttpRequest,
    @Param('incidentId') incidentId: string,
    @Body() body: unknown,
  ) {
    const input = typeof body === 'object' && body !== null
      ? body as {
        title?: unknown;
        summary?: unknown;
        status?: unknown;
        impact?: unknown;
        affectedServices?: unknown;
      }
      : {};
    return this.platformAdmin.saveServiceIncident(authenticatedUser(request).id, {
      ...input,
      id: incidentId,
    });
  }


  @Get('rights-reports')
  listRightsReports(@Req() request: HttpRequest, @Query('status') status?: string, @Query('search') search?: string) {
    return this.platformAdmin.listRightsReports(authenticatedUser(request).id, status, search);
  }

  @Get('rights-reports/:reportId/events')
  listRightsReportEvents(@Req() request: HttpRequest, @Param('reportId') reportId: string) {
    return this.platformAdmin.listRightsReportEvents(authenticatedUser(request).id, reportId);
  }

  @Post('rights-reports/:reportId/assign')
  @UseGuards(CsrfGuard)
  assignRightsReport(@Req() request: HttpRequest, @Param('reportId') reportId: string, @Body() body: unknown) {
    const input = typeof body === 'object' && body !== null
      ? body as { reviewerUserId?: unknown; reason?: unknown } : {};
    return this.platformAdmin.assignRightsReport(authenticatedUser(request).id, reportId, input.reviewerUserId, input.reason)
      .then(() => ({ success: true }));
  }

  @Post('rights-reports/:reportId/status')
  @UseGuards(CsrfGuard)
  transitionRightsReport(@Req() request: HttpRequest, @Param('reportId') reportId: string, @Body() body: unknown) {
    const input = typeof body === 'object' && body !== null
      ? body as { status?: unknown; reason?: unknown } : {};
    return this.platformAdmin.transitionRightsReport(authenticatedUser(request).id, reportId, input.status, input.reason)
      .then(() => ({ success: true }));
  }

  @Post('rights-reports/:reportId/decision')
  @UseGuards(CsrfGuard)
  decideRightsReport(@Req() request: HttpRequest, @Param('reportId') reportId: string, @Body() body: unknown) {
    const input = typeof body === 'object' && body !== null
      ? body as { decision?: unknown; reason?: unknown; preserveEvidence?: unknown } : {};
    return this.platformAdmin.decideRightsReport(
      authenticatedUser(request).id, reportId, input.decision, input.reason, input.preserveEvidence,
    ).then(() => ({ success: true }));
  }

  @Post('rights-reports/provider-path')
  @UseGuards(CsrfGuard)
  disableRightsProviderPath(@Req() request: HttpRequest, @Body() body: unknown) {
    const input = typeof body === 'object' && body !== null
      ? body as { workspaceId?: unknown; providerId?: unknown; reason?: unknown } : {};
    return this.platformAdmin.disableRightsProviderPath(
      authenticatedUser(request).id, String(input.workspaceId ?? ''), input.providerId, input.reason,
    ).then(() => ({ success: true }));
  }

  @Get('rights-reports/workspaces/:workspaceId/repeat-infringer')
  repeatInfringerSummary(@Req() request: HttpRequest, @Param('workspaceId') workspaceId: string) {
    return this.platformAdmin.repeatInfringerSummary(authenticatedUser(request).id, workspaceId);
  }

  @Post('rights-reports/workspaces/:workspaceId/restrict')
  @UseGuards(CsrfGuard)
  restrictRepeatInfringerWorkspace(@Req() request: HttpRequest, @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    const reason = typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined;
    return this.platformAdmin.restrictRepeatInfringerWorkspace(authenticatedUser(request).id, workspaceId, reason)
      .then(() => ({ success: true }));
  }

  @Get('administrators')
  listAdministrators(@Req() request: HttpRequest) {
    return this.platformAdmin.listAdministrators(authenticatedUser(request).id);
  }

  @Post('administrators')
  @UseGuards(CsrfGuard)
  appoint(@Req() request: HttpRequest, @Body() body: unknown) {
    const input = typeof body === 'object' && body !== null
      ? body as { twitchUserId?: unknown; role?: unknown; permissions?: unknown; reason?: unknown }
      : {};
    return this.platformAdmin.appoint(authenticatedUser(request).id, {
      twitchUserId: input.twitchUserId,
      role: input.role,
      permissions: input.permissions,
      reason: input.reason,
    }).then(() => ({ success: true }));
  }

  @Delete('administrators/:userId')
  @UseGuards(CsrfGuard)
  revoke(@Req() request: HttpRequest, @Body() body: unknown) {
    const reason = typeof body === 'object' && body !== null && 'reason' in body
      ? (body as { reason?: unknown }).reason
      : undefined;
    const userId = request.params?.userId;
    return this.platformAdmin.revoke(
      authenticatedUser(request).id,
      typeof userId === 'string' ? userId : '',
      reason,
    ).then(() => ({ success: true }));
  }
}
