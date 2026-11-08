import {
  Controller, Get, Inject, Post, Query, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import type { HttpReply, HttpRequest } from './http.types.js';
import { SessionGuard } from './session.guard.js';
import { clearSessionCookies, serializeSessionCookies } from './security.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('twitch/start')
  async startTwitchLogin(
    @Query('returnTo') returnTo: string | undefined,
    @Res() reply: HttpReply,
  ): Promise<HttpReply> {
    const url = await this.auth.beginTwitchLogin(returnTo);
    return reply.code(302).redirect(url);
  }

  @Get('twitch/callback')
  async finishTwitchLogin(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() reply: HttpReply,
  ): Promise<HttpReply> {
    if (error || !code || !state) {
      throw new UnauthorizedException('Twitch sign-in was cancelled or could not be completed.');
    }
    const session = await this.auth.completeTwitchLogin(code, state);
    reply.header('Set-Cookie', serializeSessionCookies(session.sessionToken, session.csrfToken));
    return reply.code(302).redirect(session.returnPath);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  getCurrentAccount(@Req() request: HttpRequest) {
    const user = request.user;
    if (!user) throw new UnauthorizedException('Sign-in is required.');
    return { user: { id: user.id, twitchUserId: user.twitchUserId } };
  }

  @Post('logout')
  @UseGuards(SessionGuard, CsrfGuard)
  async logout(@Req() request: HttpRequest, @Res() reply: HttpReply): Promise<HttpReply> {
    const user = request.user;
    if (!user) throw new UnauthorizedException('Sign-in is required.');
    await this.auth.revokeSession(user.sessionId);
    reply.header('Set-Cookie', clearSessionCookies());
    return reply.code(204);
  }
}
