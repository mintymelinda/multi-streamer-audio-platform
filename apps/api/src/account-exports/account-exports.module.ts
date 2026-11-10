import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AccountExportsController } from './account-exports.controller.js';
import { AccountExportsService } from './account-exports.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [AccountExportsController],
  providers: [AccountExportsService],
})
export class AccountExportsModule {}
