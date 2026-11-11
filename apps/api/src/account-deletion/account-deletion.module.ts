import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AccountDeletionController } from './account-deletion.controller.js';
import { AccountDeletionService } from './account-deletion.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [AccountDeletionController],
  providers: [AccountDeletionService],
})
export class AccountDeletionModule {}
