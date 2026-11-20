import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';
import { ProviderScopePolicyService } from './provider-scope-policy.service.js';
import { ProviderSecretRedactionService } from './provider-secret-redaction.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: ProviderScopePolicyService,
      useFactory: () => new ProviderScopePolicyService(),
    },
    ProviderSecretRedactionService,
    {
      provide: ProviderCredentialsService,
      inject: [DatabaseService, ProviderScopePolicyService],
      useFactory: (database: DatabaseService, scopes: ProviderScopePolicyService) =>
        new ProviderCredentialsService(
          database,
          undefined,
          { revoke: async ({ providerId }) => ({ revoked: providerId === 'lyrion' }) },
          undefined,
          scopes,
        ),
    },
  ],
  exports: [ProviderCredentialsService, ProviderScopePolicyService, ProviderSecretRedactionService],
})
export class ProviderCredentialsModule {}
