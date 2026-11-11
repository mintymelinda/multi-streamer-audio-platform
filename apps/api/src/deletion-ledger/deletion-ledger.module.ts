import { Module } from '@nestjs/common';
import { DeletionLedgerService } from './deletion-ledger.service.js';

@Module({
  providers: [DeletionLedgerService],
  exports: [DeletionLedgerService],
})
export class DeletionLedgerModule {}
