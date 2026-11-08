import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { parseCookies, safeEqualHex, sha256 } from './security.js';
import type { HttpRequest } from './http.types.js';

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return true;
    const cookieToken = parseCookies(request.headers.cookie).get('platform_csrf');
    const headerValue = request.headers['x-csrf-token'];
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (
      !request.user ||
      !cookieToken ||
      !headerToken ||
      cookieToken !== headerToken ||
      !safeEqualHex(sha256(headerToken), request.user.csrfTokenHash)
    ) {
      throw new ForbiddenException('The CSRF token is missing or invalid.');
    }
    return true;
  }
}
