import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TwitchIntegrationService } from '../src/integrations/twitch-integration.service.ts';
import { encryptIntegrationCredentials } from '../src/security/integration-credential-crypto.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actor = { id: '22222222-2222-4222-8222-222222222222', twitchUserId: '987654321' };
const credentialId = '33333333-3333-4333-8333-333333333333';
const key = Buffer.alloc(32, 7).toString('base64');

function setupCredential(tokenExpiresAt) {
  const directory = mkdtempSync(join(tmpdir(), 'twitch-integration-test-'));
  const keyRingPath = join(directory, 'key-ring.json');
  const secretPath = join(directory, 'twitch-client-secret');
  writeFileSync(keyRingPath, JSON.stringify({ currentVersion: 'v1', keys: { v1: key } }));
  writeFileSync(secretPath, 'test-client-secret');
  const previous = {
    kek: process.env.INTEGRATION_KEK_RING_FILE,
    clientId: process.env.TWITCH_CLIENT_ID,
    secretFile: process.env.TWITCH_CLIENT_SECRET_FILE,
  };
  process.env.INTEGRATION_KEK_RING_FILE = keyRingPath;
  process.env.TWITCH_CLIENT_ID = 'test-client-id';
  process.env.TWITCH_CLIENT_SECRET_FILE = secretPath;
  const credentials = {
    accessToken: 'old-access-token',
    refreshToken: 'old-refresh-token',
    tokenExpiresAt,
    scopes: ['channel:manage:redemptions'],
    userId: actor.twitchUserId,
  };
  const envelope = encryptIntegrationCredentials(
    JSON.stringify(credentials),
    { workspaceId, provider: 'twitch', credentialId },
    { currentVersion: 'v1', keys: { v1: key } },
  );
  const row = {
    id: credentialId,
    status: 'connected',
    external_account_id: actor.twitchUserId,
    granted_scopes: ['channel:manage:redemptions'],
    credential_ciphertext: Buffer.from(envelope.ciphertext, 'base64'),
    credential_nonce: Buffer.from(envelope.nonce, 'base64'),
    credential_auth_tag: Buffer.from(envelope.authTag, 'base64'),
    wrapped_dek: Buffer.from(envelope.wrappedDek, 'base64'),
    dek_nonce: Buffer.from(envelope.dekNonce, 'base64'),
    dek_auth_tag: Buffer.from(envelope.dekAuthTag, 'base64'),
    kek_version: envelope.kekVersion,
    credential_format_version: envelope.formatVersion,
    token_expires_at: new Date(tokenExpiresAt),
  };
  const updates = [];
  const client = {
    async query(sql, values = []) {
      if (sql.includes('FOR UPDATE')) return { rows: [row] };
      if (sql.includes('UPDATE workspace_integrations')) {
        updates.push({ sql, values });
        return { rows: [] };
      }
      throw new Error('Unexpected SQL in Twitch integration test.');
    },
  };
  const database = {
    async transaction(_context, operation) {
      return operation(client);
    },
  };
  const service = new TwitchIntegrationService(database, {});
  return {
    service,
    row,
    updates,
    cleanup() {
      for (const [name, value] of Object.entries({
        INTEGRATION_KEK_RING_FILE: previous.kek,
        TWITCH_CLIENT_ID: previous.clientId,
        TWITCH_CLIENT_SECRET_FILE: previous.secretFile,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('refreshes an expiring broadcaster token, validates identity and scope, and stores rotated credentials encrypted', async () => {
  const fixture = setupCredential(new Date(Date.now() + 30_000).toISOString());
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (String(url).endsWith('/oauth2/validate')) {
      return new Response(
        JSON.stringify({
          client_id: 'test-client-id',
          user_id: actor.twitchUserId,
          scopes: ['channel:manage:redemptions'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error('Unexpected Twitch endpoint.');
  };
  try {
    const token = await fixture.service.getAccessToken({ id: workspaceId }, actor);
    assert.equal(token, 'new-access-token');
    assert.equal(calls.length, 2);
    assert.match(calls[0].init.body.toString(), /grant_type=refresh_token/);
    assert.equal(calls[1].init.headers.Authorization, 'OAuth new-access-token');
    assert.equal(fixture.updates.length, 1);
    const stored = fixture.updates[0].values;
    assert.equal(stored[0], workspaceId);
    assert.equal(stored[1], credentialId);
    assert.notEqual(stored[2].toString(), 'new-access-token');
    assert.ok(stored[2].length > 0);
    assert.deepEqual(stored[10], ['channel:manage:redemptions']);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.cleanup();
  }
});

test('does not refresh a broadcaster token that remains valid beyond the refresh window', async () => {
  const fixture = setupCredential(new Date(Date.now() + 60 * 60_000).toISOString());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('A valid token should not be refreshed.');
  };
  try {
    const token = await fixture.service.getAccessToken({ id: workspaceId }, actor);
    assert.equal(token, 'old-access-token');
    assert.equal(fixture.updates.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.cleanup();
  }
});


test('marks the integration for reauthorization when Twitch rejects the refreshed broadcaster identity or scope', async () => {
  const fixture = setupCredential(new Date(Date.now() + 30_000).toISOString());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        client_id: 'test-client-id',
        user_id: actor.twitchUserId,
        scopes: ['channel:read:redemptions'],
      }),
      { status: 200 },
    );
  };
  try {
    await assert.rejects(
      fixture.service.getAccessToken({ id: workspaceId }, actor),
      (error) => error instanceof Error && 'getStatus' in error && error.getStatus() === 401,
    );
    assert.equal(fixture.updates.length, 1);
    assert.match(fixture.updates[0].sql, /status = 'reauth_required'/);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.cleanup();
  }
});

test('does not mark the integration for reauthorization during a transient Twitch outage', async () => {
  const fixture = setupCredential(new Date(Date.now() + 30_000).toISOString());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('temporarily unavailable', { status: 503 });
  try {
    await assert.rejects(
      fixture.service.getAccessToken({ id: workspaceId }, actor),
      (error) => error instanceof Error && 'getStatus' in error && error.getStatus() === 503,
    );
    assert.equal(fixture.updates.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.cleanup();
  }
});
