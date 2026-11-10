import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
