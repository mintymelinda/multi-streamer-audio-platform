import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { encryptIntegrationCredentials, decryptIntegrationCredentials, loadIntegrationKeyRing } from '../security/integration-credential-crypto.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';
import { ProviderInstanceService } from './provider-instance.service.js';
import { SPOTIFY_CONNECT_SCOPES } from './provider-scope-policy.service.js';

interface SpotifyTokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string; }

@Injectable()
export class SpotifyConnectOAuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly credentials: ProviderCredentialsService,
    private readonly instances: ProviderInstanceService,
    private readonly request: typeof fetch = fetch,
  ) {}

  async begin(input: { workspaceId: string; userId: string; sessionId: string }): Promise<string> {
    const config = this.configuration();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const id = randomUUID();
    const envelope = encryptIntegrationCredentials(verifier, {
      workspaceId: input.workspaceId, provider: 'spotify-oauth', credentialId: id,
    }, loadIntegrationKeyRing());
    await this.database.queryInfrastructure(
      `INSERT INTO spotify_oauth_transactions
       (id,state_hash,workspace_id,user_id,session_id,verifier_ciphertext,verifier_nonce,
        verifier_auth_tag,verifier_wrapped_dek,verifier_dek_nonce,verifier_dek_auth_tag,
        verifier_kek_version,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now() + interval '10 minutes')`,
      [id, createHash('sha256').update(state).digest('hex'), input.workspaceId, input.userId,
       input.sessionId, envelope.ciphertext, envelope.nonce, envelope.authTag, envelope.wrappedDek,
       envelope.dekNonce, envelope.dekAuthTag, envelope.kekVersion],
    );
    const url = new URL('https://accounts.spotify.com/authorize');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('scope', SPOTIFY_CONNECT_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', challenge);
    return url.toString();
  }

  async complete(input: { code: string; state: string; userId: string; sessionId: string }): Promise<void> {
    if (!input.code || !input.state || input.state.length > 256) throw new BadRequestException('Spotify callback is invalid.');
    const result = await this.database.queryInfrastructure<{
      id: string; workspace_id: string; verifier_ciphertext: string; verifier_nonce: string;
      verifier_auth_tag: string; verifier_wrapped_dek: string; verifier_dek_nonce: string;
      verifier_dek_auth_tag: string; verifier_kek_version: string;
    }>(
      `UPDATE spotify_oauth_transactions SET consumed_at=now()
       WHERE state_hash=$1 AND user_id=$2 AND session_id=$3 AND consumed_at IS NULL AND expires_at>now()
       RETURNING id,workspace_id,verifier_ciphertext,verifier_nonce,verifier_auth_tag,
       verifier_wrapped_dek,verifier_dek_nonce,verifier_dek_auth_tag,verifier_kek_version`,
      [createHash('sha256').update(input.state).digest('hex'), input.userId, input.sessionId],
    );
    const tx = result.rows[0];
    if (!tx) throw new UnauthorizedException('Spotify authorization state is invalid, expired, or already used.');
    const verifier = decryptIntegrationCredentials({
      formatVersion: 1, ciphertext: tx.verifier_ciphertext, nonce: tx.verifier_nonce,
      authTag: tx.verifier_auth_tag, wrappedDek: tx.verifier_wrapped_dek,
      dekNonce: tx.verifier_dek_nonce, dekAuthTag: tx.verifier_dek_auth_tag,
      kekVersion: tx.verifier_kek_version,
    }, { workspaceId: tx.workspace_id, provider: 'spotify-oauth', credentialId: tx.id }, loadIntegrationKeyRing());
    const config = this.configuration();
    const response = await this.request('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: config.redirectUri, code_verifier: verifier }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new UnauthorizedException('Spotify token exchange failed.'); });
    if (!response.ok) throw new UnauthorizedException('Spotify rejected the authorization code.');
    const token = await response.json() as SpotifyTokenResponse;
    const granted = (token.scope ?? '').split(' ').filter(Boolean).sort();
    const expected = [...SPOTIFY_CONNECT_SCOPES].sort();
    if (!token.access_token || !token.refresh_token || !Number.isInteger(token.expires_in) ||
      (token.expires_in ?? 0) <= 0 || granted.length !== expected.length ||
      expected.some((scope, index) => granted[index] !== scope)) {
      throw new UnauthorizedException('Spotify did not grant the exact requested Connect permissions.');
    }
    const instance = await this.instances.resolveIdentity({
      workspaceId: tx.workspace_id, providerId: 'spotify', instanceKey: 'personal-connect', userId: input.userId,
    });
    await this.credentials.connect({
      workspaceId: tx.workspace_id, providerInstanceId: instance.id, actorId: input.userId,
      providerId: 'spotify',
      credentials: { accessToken: token.access_token, refreshToken: token.refresh_token, tokenType: token.token_type ?? 'Bearer' },
      requestedScopes: [...SPOTIFY_CONNECT_SCOPES], grantedScopes: granted,
      expiresAt: new Date(Date.now() + (token.expires_in ?? 0) * 1000),
    });
  }

  private configuration(): { clientId: string; clientSecret: string; redirectUri: string } {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) throw new Error('Spotify OAuth client configuration is missing.');
    const redirect = new URL(redirectUri);
    if (process.env.NODE_ENV === 'production' && redirect.protocol !== 'https:') {
      throw new Error('Spotify OAuth redirect URI must use HTTPS in production.');
    }
    return { clientId, clientSecret, redirectUri: redirect.toString() };
  }
}
