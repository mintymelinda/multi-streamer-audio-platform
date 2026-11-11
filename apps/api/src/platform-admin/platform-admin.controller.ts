import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Post,
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
