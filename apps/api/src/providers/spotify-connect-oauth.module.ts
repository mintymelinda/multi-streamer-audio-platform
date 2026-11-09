import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { ProviderCredentialsModule } from './provider-credentials.module.js';
import { ProviderInstanceModule } from './provider-instance.module.js';
import { SpotifyConnectOAuthController } from './spotify-connect-oauth.controller.js';
import { SpotifyConnectOAuthService } from './spotify-connect-oauth.service.js';

@Module({
  imports: [IdentityModule, WorkspacesModule, ProviderCredentialsModule, ProviderInstanceModule],
  controllers: [SpotifyConnectOAuthController],
  providers: [SpotifyConnectOAuthService],
})
export class SpotifyConnectOAuthModule {}
