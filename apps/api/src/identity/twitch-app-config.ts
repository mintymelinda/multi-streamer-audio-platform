import { readFileSync } from 'node:fs';

export interface TwitchAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
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
