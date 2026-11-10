import { Module } from '@nestjs/common';
import { EventSubConsumerService } from './eventsub-consumer.service.js';
import { EmailDispatcherService } from './email-dispatcher.service.js';
import { NotificationRetentionService } from './notification-retention.service.js';
import { AccountExportService } from './account-export.service.js';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';
@Module({ providers: [OutboxDispatcherService, EventSubConsumerService, NotificationRetentionService, EmailDispatcherService, AccountExportService] })
export class WorkerModule {}
