import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { HttpRequest } from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import { NotificationsService, type NotificationFilters } from './notifications.service.js';

@Controller('me/notifications')
@UseGuards(SessionGuard, CsrfGuard)
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  private userId(request: HttpRequest) {
    if (!request.user) throw new UnauthorizedException('Sign-in is required.');
    return request.user.id;
  }

  @Get()
  list(@Req() request: HttpRequest, @Query() query: NotificationFilters) {
    return this.notifications.list(this.userId(request), query);
  }

  @Get('preferences')
  preferences(@Req() request: HttpRequest) {
    return this.notifications.preferences(this.userId(request));
  }

  @Patch('preferences')
  updatePreferences(@Req() request: HttpRequest, @Body() body: unknown) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Notification preferences must be an object.');
    }
    const input = body as { categoryPreferences?: unknown; retentionDays?: unknown };
    return this.notifications.updatePreferences(this.userId(request), input);
  }

  @Get('unread-count')
  unreadCount(@Req() request: HttpRequest) {
    return this.notifications.unreadCount(this.userId(request));
  }

  @Patch('read-all')
  markAllRead(@Req() request: HttpRequest, @Query() query: Record<string, string | undefined>) {
    return this.notifications.markAllRead(this.userId(request), query);
  }

  @Patch('groups/read')
  markGroupRead(@Req() request: HttpRequest, @Body() body: unknown) {
    const groupKey = typeof body === 'object' && body !== null && 'groupKey' in body ? body.groupKey : undefined;
    return this.notifications.markGroupRead(this.userId(request), groupKey);
  }

  @Patch(':notificationId/read')
  markRead(@Req() request: HttpRequest, @Param('notificationId') notificationId: string) {
    return this.notifications.markRead(this.userId(request), notificationId);
  }
}
