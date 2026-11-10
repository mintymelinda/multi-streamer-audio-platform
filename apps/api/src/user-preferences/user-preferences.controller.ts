import { BadRequestException, Body, Controller, Get, Inject, Patch, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { HttpRequest } from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { UserPreferencesService } from './user-preferences.service.js';

@Controller('me/preferences')
@UseGuards(SessionGuard, CsrfGuard)
export class UserPreferencesController {
  constructor(@Inject(UserPreferencesService) private readonly preferences: UserPreferencesService) {}

  private userId(request: HttpRequest) {
    if (!request.user) throw new UnauthorizedException('Sign-in is required.');
    return request.user.id;
  }

  @Get()
  getAppearance(@Req() request: HttpRequest) {
    return this.preferences.getAppearance(this.userId(request));
  }

  @Patch()
  updateAppearance(@Req() request: HttpRequest, @Body() body: unknown) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Appearance preferences must be an object.');
    }
    const input = body as { theme?: unknown; accentColor?: unknown };
    return this.preferences.updateAppearance(this.userId(request), input);
  }
}
