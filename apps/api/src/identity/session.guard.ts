import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { AuthService } from './auth.service.js';
import type { AuthenticatedUser, HttpRequest } from './http.types.js';
import { parseCookies, sessionCookieName } from './security.js';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const token = parseCookies(request.headers.cookie).get(sessionCookieName());
    if (!token) throw new UnauthorizedException('Sign-in is required.');
    const identity = await this.auth.resolveSession(token);
    if (!identity) throw new UnauthorizedException('Your session is invalid or has expired.');
    const user: AuthenticatedUser = {
      id: identity.id,
      twitchUserId: identity.twitchUserId,
      sessionId: identity.sessionId,
      csrfTokenHash: identity.csrfTokenHash,
    };
    request.user = user;
    return true;
  }
}
