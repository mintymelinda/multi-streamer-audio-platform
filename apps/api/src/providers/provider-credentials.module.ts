import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';
import { ProviderScopePolicyService } from './provider-scope-policy.service.js';
import { ProviderSecretRedactionService } from './provider-secret-redaction.service.js';

@Module({ imports: [DatabaseModule], providers: [ProviderCredentialsService, ProviderScopePolicyService, ProviderSecretRedactionService], exports: [ProviderCredentialsService, ProviderScopePolicyService, ProviderSecretRedactionService] })
export class ProviderCredentialsModule {}
