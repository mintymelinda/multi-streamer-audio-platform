import { Module } from '@nestjs/common';
import { EventSubConsumerService } from './eventsub-consumer.service.js';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';
@Module({ providers: [OutboxDispatcherService, EventSubConsumerService] })
export class WorkerModule {}
