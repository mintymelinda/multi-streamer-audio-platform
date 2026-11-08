import type { VerifiedWorkspaceId } from '@platform/contracts';
import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedUser, WorkspaceRequestContext } from '../identity/http.types.js';
import {
  getTwitchAppConfig,
  getTwitchIntegrationRedirectUri,
} from '../identity/twitch-app-config.js';
import { isSafeLocalReturnPath, newOpaqueToken, sha256 } from '../identity/security.js';
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  loadIntegrationKeyRing,
} from '../security/integration-credential-crypto.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { hasRequiredTwitchRewardScopes } from './twitch-integration-scopes.js';

interface TwitchTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface TwitchValidationResponse {
  client_id?: string;
  user_id?: string;
  expires_in?: number;
  scopes?: string[];
}

interface ConsumedOAuthState {
  workspace_id: string;
  return_path: string;
}

export interface TwitchIntegrationStatus {
  status: 'connected' | 'reauth_required' | 'disconnected' | 'error';
  externalAccountId: string | null;
  grantedScopes: string[];
  tokenExpiresAt: Date | null;
  lastValidatedAt: Date | null;
  lastErrorCode: string | null;
  connectedAt: Date | null;
}

@Injectable()
export class TwitchIntegrationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async beginAuthorization(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    returnTo?: string,
  ): Promise<string> {
    if (workspace.role !== 'owner') {
      throw new ForbiddenException('Only the workspace owner can authorize its Twitch channel.');
    }

    const broadcaster = await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const result = await client.query<{
          owner_user_id: string;
          broadcaster_twitch_user_id: string;
          workspace_status: string;
          membership_role: string;
        }>(
          `SELECT w.owner_user_id, w.broadcaster_twitch_user_id,
                  w.status AS workspace_status, m.role AS membership_role
             FROM workspaces w
             JOIN workspace_memberships m
               ON m.workspace_id = w.id AND m.user_id = $2 AND m.status = 'active'
            WHERE w.id = $1`,
          [workspace.id, actor.id],
        );
        return result.rows[0];
      },
    );
    if (
      !broadcaster ||
      broadcaster.owner_user_id !== actor.id ||
      broadcaster.broadcaster_twitch_user_id !== actor.twitchUserId ||
      broadcaster.workspace_status !== 'active' ||
      broadcaster.membership_role !== 'owner'
    ) {
      throw new ForbiddenException(
        'The signed-in Twitch account is not this workspace broadcaster.',
      );
    }

    const config = getTwitchAppConfig();
    const redirectUri = getTwitchIntegrationRedirectUri();
    const state = newOpaqueToken();
    await this.database.queryInfrastructure(
      "INSERT INTO twitch_oauth_states (state_hash, return_path, purpose, actor_user_id, workspace_id, expires_at) VALUES ($1, $2, 'workspace_integration', $3, $4, now() + interval '10 minutes')",
      [sha256(state), isSafeLocalReturnPath(returnTo), actor.id, workspace.id],
    );

    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'channel:manage:redemptions');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async completeAuthorization(
    actor: AuthenticatedUser,
    code: string | undefined,
    state: string | undefined,
  ): Promise<string> {
    if (!code || code.length > 2_048 || !state || state.length > 256) {
      throw new UnauthorizedException('Twitch channel authorization could not be verified.');
    }

    const consumed = await this.database.queryInfrastructure<ConsumedOAuthState>(
      "UPDATE twitch_oauth_states SET consumed_at = now() WHERE state_hash = $1 AND purpose = 'workspace_integration' AND actor_user_id = $2 AND consumed_at IS NULL AND expires_at > now() RETURNING workspace_id, return_path",
      [sha256(state), actor.id],
    );
    const oauthState = consumed.rows[0];
    if (!oauthState) {
      throw new UnauthorizedException(
        'Twitch authorization state is invalid, expired, or belongs to another account.',
      );
    }

    const workspaceId = oauthState.workspace_id as VerifiedWorkspaceId;
    const broadcaster = await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspaceId },
      async (client) => {
        const result = await client.query<{
          owner_user_id: string;
          broadcaster_twitch_user_id: string;
          workspace_status: string;
          membership_role: string;
        }>(
          `SELECT w.owner_user_id, w.broadcaster_twitch_user_id,
                  w.status AS workspace_status, m.role AS membership_role
             FROM workspaces w
             JOIN workspace_memberships m
               ON m.workspace_id = w.id AND m.user_id = $2 AND m.status = 'active'
            WHERE w.id = $1`,
          [workspaceId, actor.id],
        );
        return result.rows[0];
      },
    );
    if (
      !broadcaster ||
      broadcaster.owner_user_id !== actor.id ||
      broadcaster.broadcaster_twitch_user_id !== actor.twitchUserId ||
      broadcaster.workspace_status !== 'active' ||
      broadcaster.membership_role !== 'owner'
    ) {
      throw new ForbiddenException(
        'The signed-in Twitch account is not this workspace broadcaster.',
      );
    }

    const credentials = await this.exchangeAndValidate(
      code,
      broadcaster.broadcaster_twitch_user_id,
    );
    const credentialId = randomUUID();
    const envelope = encryptIntegrationCredentials(
      JSON.stringify(credentials),
      { workspaceId, provider: 'twitch', credentialId },
      loadIntegrationKeyRing(),
    );

    await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspaceId },
      async (client) => {
        await client.query(
          `INSERT INTO workspace_integrations
            (id, workspace_id, provider, status, external_account_id, granted_scopes,
             credential_ciphertext, credential_nonce, credential_auth_tag, wrapped_dek,
             dek_nonce, dek_auth_tag, kek_version, credential_format_version,
             token_expires_at, last_validated_at, last_error_code, connected_at, disconnected_at)
           VALUES ($1,$2,'twitch','connected',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),NULL,now(),NULL)
           ON CONFLICT (workspace_id, provider) DO UPDATE SET
             id = EXCLUDED.id,
             status = 'connected',
             external_account_id = EXCLUDED.external_account_id,
             granted_scopes = EXCLUDED.granted_scopes,
             credential_ciphertext = EXCLUDED.credential_ciphertext,
             credential_nonce = EXCLUDED.credential_nonce,
             credential_auth_tag = EXCLUDED.credential_auth_tag,
             wrapped_dek = EXCLUDED.wrapped_dek,
             dek_nonce = EXCLUDED.dek_nonce,
             dek_auth_tag = EXCLUDED.dek_auth_tag,
             kek_version = EXCLUDED.kek_version,
             credential_format_version = EXCLUDED.credential_format_version,
             token_expires_at = EXCLUDED.token_expires_at,
             last_validated_at = now(),
             last_error_code = NULL,
             connected_at = now(),
             disconnected_at = NULL,
             updated_at = now()`,
          [
            credentialId,
            workspaceId,
            credentials.userId,
            credentials.scopes,
            Buffer.from(envelope.ciphertext, 'base64'),
            Buffer.from(envelope.nonce, 'base64'),
            Buffer.from(envelope.authTag, 'base64'),
            Buffer.from(envelope.wrappedDek, 'base64'),
            Buffer.from(envelope.dekNonce, 'base64'),
            Buffer.from(envelope.dekAuthTag, 'base64'),
            envelope.kekVersion,
            envelope.formatVersion,
            credentials.tokenExpiresAt,
          ],
        );
        await client.query(
          `INSERT INTO audit_events
            (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1,$2,'twitch.integration.connected','workspace_integration',$1,$3::jsonb)`,
          [
            workspaceId,
            actor.id,
            JSON.stringify({ provider: 'twitch', scopes: credentials.scopes }),
          ],
        );
        await this.outbox.append(client, {
          workspaceId,
          eventType: 'twitch.integration.connected',
          aggregateType: 'workspace_integration',
          aggregateId: workspaceId,
          idempotencyKey: `twitch.integration.connected:${credentialId}`,
          payload: {
            provider: 'twitch',
            externalAccountId: credentials.userId,
            scopes: credentials.scopes,
          },
        });
      },
    );

    return isSafeLocalReturnPath(oauthState.return_path);
  }

  /**
   * Returns a usable broadcaster access token. Refresh is serialized by locking
   * the integration row so concurrent API requests cannot race rotating refresh
   * tokens. The lock is held only for the bounded Twitch calls below.
   */
  async getAccessToken(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
  ): Promise<string> {
    try {
      return await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const result = await client.query<{
          id: string;
          status: TwitchIntegrationStatus['status'];
          external_account_id: string | null;
          granted_scopes: string[];
          credential_ciphertext: Buffer | null;
          credential_nonce: Buffer | null;
          credential_auth_tag: Buffer | null;
          wrapped_dek: Buffer | null;
          dek_nonce: Buffer | null;
          dek_auth_tag: Buffer | null;
          kek_version: string | null;
          credential_format_version: number | null;
          token_expires_at: Date | null;
        }>(
          `SELECT id, status, external_account_id, granted_scopes,
                  credential_ciphertext, credential_nonce, credential_auth_tag,
                  wrapped_dek, dek_nonce, dek_auth_tag, kek_version,
                  credential_format_version, token_expires_at
             FROM workspace_integrations
            WHERE workspace_id = $1 AND provider = 'twitch'
            FOR UPDATE`,
          [workspace.id],
        );
        const row = result.rows[0];
        if (!row || row.status !== 'connected' || !row.external_account_id) {
          throw new UnauthorizedException('The workspace Twitch broadcaster is not connected.');
        }
        if (
          !row.credential_ciphertext || !row.credential_nonce || !row.credential_auth_tag ||
          !row.wrapped_dek || !row.dek_nonce || !row.dek_auth_tag || !row.kek_version ||
          row.credential_format_version !== 1
        ) {
          await client.query(
            `UPDATE workspace_integrations
                SET status = 'reauth_required', last_error_code = 'credential_unavailable', updated_at = now()
              WHERE workspace_id = $1 AND provider = 'twitch'`,
            [workspace.id],
          );
          throw new UnauthorizedException('The workspace Twitch authorization must be renewed.');
        }

        const credentialId = row.id;
        let credentials: {
          accessToken: string;
          refreshToken: string;
          tokenExpiresAt: string;
          scopes: string[];
          userId: string;
        };
        try {
          credentials = JSON.parse(decryptIntegrationCredentials(
            {
              formatVersion: 1,
              ciphertext: row.credential_ciphertext.toString('base64'),
              nonce: row.credential_nonce.toString('base64'),
              authTag: row.credential_auth_tag.toString('base64'),
              wrappedDek: row.wrapped_dek.toString('base64'),
              dekNonce: row.dek_nonce.toString('base64'),
              dekAuthTag: row.dek_auth_tag.toString('base64'),
              kekVersion: row.kek_version,
            },
            { workspaceId: workspace.id, provider: 'twitch', credentialId },
            loadIntegrationKeyRing(),
          )) as typeof credentials;
        } catch {
          await client.query(
            `UPDATE workspace_integrations
                SET status = 'reauth_required', last_error_code = 'credential_decryption_failed', updated_at = now()
              WHERE workspace_id = $1 AND provider = 'twitch'`,
            [workspace.id],
          );
          throw new UnauthorizedException('The workspace Twitch authorization must be renewed.');
        }

        if (
          !credentials.accessToken || !credentials.refreshToken ||
          credentials.userId !== row.external_account_id ||
          !hasRequiredTwitchRewardScopes(credentials.scopes)
        ) {
          await client.query(
            `UPDATE workspace_integrations
                SET status = 'reauth_required', last_error_code = 'credential_invalid', updated_at = now()
              WHERE workspace_id = $1 AND provider = 'twitch'`,
            [workspace.id],
          );
          throw new UnauthorizedException('The workspace Twitch authorization must be renewed.');
        }

        const expiresAt = Date.parse(credentials.tokenExpiresAt);
        if (!Number.isFinite(expiresAt)) {
          await client.query(
            `UPDATE workspace_integrations
                SET status = 'reauth_required', last_error_code = 'credential_expiry_invalid', updated_at = now()
              WHERE workspace_id = $1 AND provider = 'twitch'`,
            [workspace.id],
          );
          throw new UnauthorizedException('The workspace Twitch authorization must be renewed.');
        }
        if (expiresAt > Date.now() + 5 * 60_000) return credentials.accessToken;

        const refreshed = await this.refreshAndValidate(credentials.refreshToken, row.external_account_id);
        const nextCredentials = {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          tokenExpiresAt: refreshed.tokenExpiresAt,
          scopes: refreshed.scopes,
          userId: refreshed.userId,
        };
        const envelope = encryptIntegrationCredentials(
          JSON.stringify(nextCredentials),
          { workspaceId: workspace.id, provider: 'twitch', credentialId },
          loadIntegrationKeyRing(),
        );
        await client.query(
          `UPDATE workspace_integrations
              SET credential_ciphertext = $3, credential_nonce = $4, credential_auth_tag = $5,
                  wrapped_dek = $6, dek_nonce = $7, dek_auth_tag = $8,
                  kek_version = $9, credential_format_version = $10,
                  granted_scopes = $11, token_expires_at = $12,
                  last_validated_at = now(), last_error_code = NULL, updated_at = now()
            WHERE workspace_id = $1 AND provider = 'twitch' AND id = $2`,
          [
            workspace.id, credentialId,
            Buffer.from(envelope.ciphertext, 'base64'), Buffer.from(envelope.nonce, 'base64'),
            Buffer.from(envelope.authTag, 'base64'), Buffer.from(envelope.wrappedDek, 'base64'),
            Buffer.from(envelope.dekNonce, 'base64'), Buffer.from(envelope.dekAuthTag, 'base64'),
            envelope.kekVersion, envelope.formatVersion, refreshed.scopes, refreshed.tokenExpiresAt,
          ],
        );
        return refreshed.accessToken;
      },
      );
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        await this.database.transaction(
          { userId: actor.id, verifiedWorkspaceId: workspace.id },
          (client) => client.query(
            `UPDATE workspace_integrations
                SET status = 'reauth_required', last_error_code = 'token_refresh_or_validation_failed', updated_at = now()
              WHERE workspace_id = $1 AND provider = 'twitch' AND status <> 'disconnected'`,
            [workspace.id],
          ),
        );
      }
      throw error;
    }
  }

  private async refreshAndValidate(
    refreshToken: string,
    expectedBroadcasterId: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: string;
    scopes: string[];
    userId: string;
  }> {
    const config = getTwitchAppConfig();
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    let token: TwitchTokenResponse;
    try {
      const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Twitch refresh rejected');
      token = (await response.json()) as TwitchTokenResponse;
    } catch {
      throw new UnauthorizedException('Twitch authorization expired; reconnect the broadcaster account.');
    }
    if (
      !token.access_token || !token.refresh_token ||
      typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0
    ) {
      throw new UnauthorizedException('Twitch did not return a renewable broadcaster credential.');
    }
    let validation: TwitchValidationResponse;
    try {
      const response = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `OAuth ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Twitch validation rejected');
      validation = (await response.json()) as TwitchValidationResponse;
    } catch {
      throw new UnauthorizedException('The refreshed Twitch authorization could not be validated.');
    }
    const scopes = Array.isArray(validation.scopes)
      ? validation.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [];
    if (
      validation.client_id !== config.clientId ||
      validation.user_id !== expectedBroadcasterId ||
      !hasRequiredTwitchRewardScopes(scopes)
    ) {
      throw new UnauthorizedException('Twitch authorization is missing required broadcaster permissions.');
    }
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiresAt: new Date(Date.now() + token.expires_in * 1_000).toISOString(),
      scopes,
      userId: validation.user_id,
    };
  }

  async getStatus(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
  ): Promise<TwitchIntegrationStatus> {
    const result = await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      (client) =>
        client.query<{
          status: TwitchIntegrationStatus['status'];
          external_account_id: string | null;
          granted_scopes: string[];
          token_expires_at: Date | null;
          last_validated_at: Date | null;
          last_error_code: string | null;
          connected_at: Date | null;
        }>(
          "SELECT status, external_account_id, granted_scopes, token_expires_at, last_validated_at, last_error_code, connected_at FROM workspace_integrations WHERE workspace_id = $1 AND provider = 'twitch'",
          [workspace.id],
        ),
    );
    const row = result.rows[0];
    return row
      ? {
          status: row.status,
          externalAccountId: row.external_account_id,
          grantedScopes: row.granted_scopes,
          tokenExpiresAt: row.token_expires_at,
          lastValidatedAt: row.last_validated_at,
          lastErrorCode: row.last_error_code,
          connectedAt: row.connected_at,
        }
      : {
          status: 'disconnected',
          externalAccountId: null,
          grantedScopes: [],
          tokenExpiresAt: null,
          lastValidatedAt: null,
          lastErrorCode: null,
          connectedAt: null,
        };
  }

  private async exchangeAndValidate(
    code: string,
    expectedBroadcasterId: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: string;
    scopes: string[];
    userId: string;
  }> {
    const config = getTwitchAppConfig();
    const redirectUri = getTwitchIntegrationRedirectUri();
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    let token: TwitchTokenResponse;
    try {
      const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Twitch token exchange rejected');
      token = (await response.json()) as TwitchTokenResponse;
    } catch {
      throw new UnauthorizedException('Twitch channel authorization could not be completed.');
    }
    if (
      !token.access_token ||
      !token.refresh_token ||
      typeof token.expires_in !== 'number' ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0
    ) {
      throw new UnauthorizedException(
        'Twitch did not return a complete renewable user credential.',
      );
    }

    let validation: TwitchValidationResponse;
    try {
      const response = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `OAuth ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Twitch token validation rejected');
      validation = (await response.json()) as TwitchValidationResponse;
    } catch {
      throw new UnauthorizedException('Twitch channel authorization could not be validated.');
    }

    const scopes = Array.isArray(validation.scopes)
      ? validation.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [];
    if (
      validation.client_id !== config.clientId ||
      validation.user_id !== expectedBroadcasterId ||
      !hasRequiredTwitchRewardScopes(scopes)
    ) {
      throw new ForbiddenException(
        'Authorize the workspace broadcaster account and grant channel:manage:redemptions.',
      );
    }

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiresAt: new Date(Date.now() + token.expires_in * 1_000).toISOString(),
      scopes,
      userId: validation.user_id,
    };
  }
}
