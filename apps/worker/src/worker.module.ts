import { Module } from '@nestjs/common';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';

@Module({ providers: [OutboxDispatcherService] })
export class WorkerModule {}
