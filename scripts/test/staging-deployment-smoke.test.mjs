import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseHttpsOrigin,
  parseOptions,
  validateTwitchLoginRedirect,
} from '../ops/staging-deployment-smoke.mjs';

const stagingOptions = [
  '--api-url', 'https://api.staging.example.net',
  '--dashboard-url', 'https://dashboard.staging.example.net',
  '--overlay-url', 'https://overlay.staging.example.net',
  '--assets-url', 'https://assets.staging.example.net',
  '--twitch-integration-callback-url', 'https://dashboard.staging.example.net/auth/twitch/integration/callback',
  '--i-confirm-non-production',
];

test('requires explicit non-production confirmation and all staging origins', () => {
  assert.throws(() => parseOptions(stagingOptions.slice(0, -1)), /--i-confirm-non-production/);
  assert.equal(parseOptions(stagingOptions).api, 'https://api.staging.example.net');
});

test('rejects non-HTTPS, credentialed, and path-bearing origins', () => {
  assert.throws(() => parseHttpsOrigin('http://api.staging.example.net'), /HTTPS origin/);
  assert.throws(() => parseHttpsOrigin('https://user:pass@api.staging.example.net'), /HTTPS origin/);
  assert.throws(() => parseHttpsOrigin('https://api.staging.example.net/auth'), /HTTPS origin/);
});

test('requires the integration callback to match the dashboard origin exactly', () => {
  const invalid = [...stagingOptions];
  invalid[9] = 'https://other.staging.example.net/auth/twitch/integration/callback';
  assert.throws(() => parseOptions(invalid), /must exactly match/);
});

test('accepts only the exact Twitch authorization endpoint and callback URI', () => {
  const location = new URL('https://id.twitch.tv/oauth2/authorize');
  location.searchParams.set('redirect_uri', 'https://dashboard.staging.example.net/auth/twitch/callback');
  location.searchParams.set('state', 'one-time-state');
  assert.equal(validateTwitchLoginRedirect(location.toString(), 'https://dashboard.staging.example.net/auth/twitch/callback'), true);
  assert.throws(() => validateTwitchLoginRedirect(location.toString(), 'https://wrong.example.net/callback'), /does not match/);
  location.hostname = 'evil.example.net';
  assert.throws(() => validateTwitchLoginRedirect(location.toString(), 'https://dashboard.staging.example.net/auth/twitch/callback'), /unexpected authorization endpoint/);
});
