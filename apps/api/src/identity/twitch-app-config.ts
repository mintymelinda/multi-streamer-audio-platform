import { readFileSync } from 'node:fs';

export interface TwitchAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getTwitchIntegrationRedirectUri(): string {
  const redirectUri = process.env.TWITCH_INTEGRATION_REDIRECT_URI?.trim();
  if (!redirectUri) {
    throw new Error(
      'Twitch channel authorization is not configured. Set TWITCH_INTEGRATION_REDIRECT_URI to the registered /auth/twitch/integration/callback URL.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error('TWITCH_INTEGRATION_REDIRECT_URI must be an absolute HTTPS URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new Error('TWITCH_INTEGRATION_REDIRECT_URI must use HTTPS.');
  }
  if (parsed.pathname !== '/auth/twitch/integration/callback' || parsed.search || parsed.hash) {
    throw new Error(
      'TWITCH_INTEGRATION_REDIRECT_URI must use the exact /auth/twitch/integration/callback path without query or fragment.',
    );
  }
  return parsed.toString();
}

export function getTwitchAppConfig(): TwitchAppConfig {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const redirectUri = process.env.TWITCH_REDIRECT_URI?.trim();
  const secretFile = process.env.TWITCH_CLIENT_SECRET_FILE;
  if (!clientId || !redirectUri || !secretFile) {
    throw new Error(
      'Twitch sign-in is not configured. Set TWITCH_CLIENT_ID, TWITCH_REDIRECT_URI, and TWITCH_CLIENT_SECRET_FILE.',
    );
  }
  const clientSecret = readFileSync(secretFile, 'utf8').trim();
  if (!clientSecret) throw new Error('The configured Twitch client secret file is empty.');
  return { clientId, clientSecret, redirectUri };
}
