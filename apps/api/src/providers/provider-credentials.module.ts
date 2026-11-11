import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { DeletionLedgerModule } from '../deletion-ledger/deletion-ledger.module.js';
import { DeletionLedgerService } from '../deletion-ledger/deletion-ledger.service.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';
import { ProviderScopePolicyService } from './provider-scope-policy.service.js';
import { ProviderSecretRedactionService } from './provider-secret-redaction.service.js';

@Module({
  imports: [DatabaseModule, DeletionLedgerModule],
  providers: [
    ProviderScopePolicyService,
    ProviderSecretRedactionService,
    {
      provide: ProviderCredentialsService,
      inject: [DatabaseService, ProviderScopePolicyService, DeletionLedgerService],
      useFactory: (database: DatabaseService, scopes: ProviderScopePolicyService, ledger: DeletionLedgerService) =>
        new ProviderCredentialsService(database, undefined, undefined, undefined, scopes, ledger),
    },
  ],
  exports: [ProviderCredentialsService, ProviderScopePolicyService, ProviderSecretRedactionService],
})
export class ProviderCredentialsModule {}
