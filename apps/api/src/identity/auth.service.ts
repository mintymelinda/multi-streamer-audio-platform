import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../database/database.service.js';
import { isSafeLocalReturnPath, newOpaqueToken, sha256 } from './security.js';
import { getTwitchAppConfig } from './twitch-app-config.js';

interface TwitchTokenResponse { access_token?: string }
interface TwitchValidationResponse { client_id?: string; user_id?: string; expires_in?: number }

export interface NewLoginSession {
  userId: string;
  twitchUserId: string;
  sessionToken: string;
  csrfToken: string;
  returnPath: string;
}

export interface SessionIdentity {
  id: string;
  twitchUserId: string;
  sessionId: string;
  csrfTokenHash: string;
}

@Injectable()
export class AuthService {
  constructor(@Inject('DatabaseService') private readonly database: DatabaseService) {}

  async beginTwitchLogin(returnTo?: string): Promise<string> {
    const config = getTwitchAppConfig();
    const state = newOpaqueToken();
    await this.database.query(
      'INSERT INTO twitch_oauth_states (state_hash, return_path, expires_at) VALUES ($1, $2, now() + interval \'10 minutes\')',
      [sha256(state), isSafeLocalReturnPath(returnTo)],
    );
    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', '');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async completeTwitchLogin(code: string, state: string): Promise<NewLoginSession> {
    if (!code || code.length > 2_048 || !state || state.length > 256) {
      throw new UnauthorizedException('Twitch sign-in could not be verified.');
    }
    const oauthState = await this.database.transaction({}, async (client) => {
      const result = await client.query<{ return_path: string }>(
        'UPDATE twitch_oauth_states SET consumed_at = now() WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING return_path',
        [sha256(state)],
      );
      return result.rows[0]?.return_path;
    });
    if (!oauthState) {
      throw new UnauthorizedException('Twitch sign-in state is invalid or expired. Please try again.');
    }
    const twitchUserId = await this.exchangeAndValidateCode(code);
    return this.createPlatformSession(twitchUserId, oauthState);
  }

  async resolveSession(sessionToken: string): Promise<SessionIdentity | null> {
    const sessionResult = await this.database.query<{
      id: string; user_id: string; csrf_token_hash: string;
    }>(
      'SELECT id, user_id, csrf_token_hash FROM user_sessions WHERE session_token_hash = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1',
      [sha256(sessionToken)],
    );
    const session = sessionResult.rows[0];
    if (!session) return null;

    const userResult = await this.database.transaction({ userId: session.user_id }, (client) =>
      client.query<{ id: string; twitch_user_id: string; status: string }>(
        'SELECT id, twitch_user_id, status FROM platform_users WHERE id = $1',
        [session.user_id],
      ),
    );
    const user = userResult.rows[0];
    if (user?.status !== 'active') {
      await this.revokeSession(session.id);
      return null;
    }
    return {
      id: user.id,
      twitchUserId: user.twitch_user_id,
      sessionId: session.id,
      csrfTokenHash: session.csrf_token_hash,
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.database.query(
      'UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [sessionId],
    );
  }

  private async exchangeAndValidateCode(code: string): Promise<string> {
    const config = getTwitchAppConfig();
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    });
    let tokenPayload: TwitchTokenResponse;
    try {
      const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Twitch token exchange rejected');
      tokenPayload = (await response.json()) as TwitchTokenResponse;
    } catch {
      throw new UnauthorizedException('Twitch authorization could not be completed.');
    }
    if (!tokenPayload.access_token) {
      throw new UnauthorizedException('Twitch authorization did not return a usable token.');
    }

    let validation: TwitchValidationResponse;
    try {
      const response = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `OAuth ${tokenPayload.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Twitch token validation rejected');
      validation = (await response.json()) as TwitchValidationResponse;
    } catch {
      throw new UnauthorizedException('Twitch identity could not be verified.');
    }
    if (
      validation.client_id !== config.clientId ||
      !validation.user_id ||
      !/^[0-9]{1,32}$/.test(validation.user_id)
    ) {
      throw new UnauthorizedException('Twitch identity could not be verified.');
    }
    // Basic sign-in discards the short-lived OAuth token and requests no scopes.
    return validation.user_id;
  }

  private async createPlatformSession(
    twitchUserId: string,
    returnPath: string,
  ): Promise<NewLoginSession> {
    const candidateUserId = randomUUID();
    const sessionToken = newOpaqueToken();
    const csrfToken = newOpaqueToken();

    return this.database.transaction(
      { userId: candidateUserId, twitchLookupId: twitchUserId },
      async (client: PoolClient) => {
        const existing = await client.query<{ id: string; status: 'active' | 'suspended' }>(
          'SELECT id, status FROM platform_users WHERE twitch_user_id = $1 LIMIT 1',
          [twitchUserId],
        );
        let userId = candidateUserId;
        const user = existing.rows[0];
        if (user) {
          userId = user.id;
          await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        } else {
          await client.query(
            'INSERT INTO platform_users (id, twitch_user_id) VALUES ($1, $2)',
            [userId, twitchUserId],
          );
        }
        if (user?.status === 'suspended') {
          throw new ForbiddenException('This platform account is suspended.');
        }

        const sessionId = randomUUID();
        await client.query(
          'INSERT INTO user_sessions (id, user_id, session_token_hash, csrf_token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval \'7 days\')',
          [sessionId, userId, sha256(sessionToken), sha256(csrfToken)],
        );
        return { userId, twitchUserId, sessionToken, csrfToken, returnPath };
      },
    );
  }
}
