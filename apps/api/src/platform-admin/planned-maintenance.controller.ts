import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { HttpRequest } from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { PlannedMaintenanceService } from './planned-maintenance.service.js';

@Controller('platform-admin/maintenance')
@UseGuards(SessionGuard)
export class PlannedMaintenanceController {
  constructor(@Inject(PlannedMaintenanceService) private readonly maintenance: PlannedMaintenanceService) {}

  private userId(request: HttpRequest) {
    if (!request.user) throw new UnauthorizedException('Sign-in is required.');
    return request.user.id;
  }

  @Get()
  list(@Req() request: HttpRequest) {
    return this.maintenance.list(this.userId(request));
  }

  @Post()
  @UseGuards(CsrfGuard)
  save(@Req() request: HttpRequest, @Body() body: unknown) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Maintenance details must be an object.');
    }
    return this.maintenance.save(this.userId(request), body);
  }

  @Delete(':maintenanceId')
  @UseGuards(CsrfGuard)
  async cancel(@Req() request: HttpRequest, @Param('maintenanceId') id: string) {
    await this.maintenance.cancel(this.userId(request), id);
    return { success: true };
  }
}
