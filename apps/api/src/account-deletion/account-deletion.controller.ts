import {
  Controller, Delete, Inject, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { HttpReply, HttpRequest } from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { clearSessionCookies } from '../identity/security.js';
import { AccountDeletionService } from './account-deletion.service.js';

@Controller('me')
@UseGuards(SessionGuard, CsrfGuard)
export class AccountDeletionController {
  constructor(@Inject(AccountDeletionService) private readonly deletion: AccountDeletionService) {}

  @Delete()
  async deleteAccount(@Req() request: HttpRequest, @Res() reply: HttpReply) {
    if (!request.user) throw new UnauthorizedException('Sign-in is required.');
    const result = await this.deletion.delete(request.user.id);
    reply.header('Set-Cookie', clearSessionCookies());
    reply.header('Cache-Control', 'no-store');
    return reply.code(200).send(result);
  }
}
