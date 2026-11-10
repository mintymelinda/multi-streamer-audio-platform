import { Controller, Get, Inject, Param, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { HttpReply, HttpRequest } from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { AccountExportsService } from './account-exports.service.js';

@Controller('me/exports')
@UseGuards(SessionGuard, CsrfGuard)
export class AccountExportsController {
  constructor(@Inject(AccountExportsService) private readonly exports: AccountExportsService) {}

  private userId(request: HttpRequest) {
    if (!request.user) throw new UnauthorizedException('Sign-in is required.');
    return request.user.id;
  }

  @Post()
  requestExport(@Req() request: HttpRequest) {
    return this.exports.request(this.userId(request));
  }

  @Get()
  listExports(@Req() request: HttpRequest) {
    return this.exports.list(this.userId(request));
  }

  @Get(':exportId/download')
  async download(
    @Req() request: HttpRequest,
    @Param('exportId') exportId: string,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    const result = await this.exports.download(this.userId(request), exportId);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="account-data-export-${result.id}.json"`);
    reply.header('Cache-Control', 'private, no-store, max-age=0');
    reply.header('X-Content-Type-Options', 'nosniff');
    return result.data;
  }
}
