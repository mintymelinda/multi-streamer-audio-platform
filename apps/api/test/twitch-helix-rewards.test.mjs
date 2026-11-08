import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TwitchHelixService } from '../dist/integrations/twitch-helix.service.js';

const workspace = { id: '11111111-1111-4111-8111-111111111111' };
const actor = {
  id: '22222222-2222-4222-8222-222222222222',
  twitchUserId: 'the-current-user-is-not-the-broadcaster',
};
const reward = {
  id: 'reward-1',
  title: 'Media request',
  prompt: 'Enter a URL',
  cost: 500,
  is_enabled: true,
  is_user_input_required: true,
  is_paused: false,
  is_in_stock: true,
  background_color: '#9147ff',
  cooldown_expires_at: null,
};

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'twitch-helix-test-'));
  const secretPath = join(directory, 'twitch-client-secret');
  writeFileSync(secretPath, 'test-client-secret');
  const previous = {
    clientId: process.env.TWITCH_CLIENT_ID,
    redirectUri: process.env.TWITCH_REDIRECT_URI,
    secretFile: process.env.TWITCH_CLIENT_SECRET_FILE,
  };
  process.env.TWITCH_CLIENT_ID = 'test-client-id';
  process.env.TWITCH_REDIRECT_URI = 'https://example.test/auth/twitch/callback';
  process.env.TWITCH_CLIENT_SECRET_FILE = secretPath;
  const integration = {
    async getStatus() {
      return { status: 'connected', externalAccountId: 'broadcaster-123' };
    },
    async getAccessToken() {
      return 'test-access-token';
    },
  };
  return {
    service: new TwitchHelixService(integration),
    cleanup() {
      for (const [name, value] of Object.entries({
        TWITCH_CLIENT_ID: previous.clientId,
        TWITCH_REDIRECT_URI: previous.redirectUri,
        TWITCH_CLIENT_SECRET_FILE: previous.secretFile,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function jsonResponse(data, extra = {}) {
  return new Response(JSON.stringify({ data, ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('lists every Twitch reward page using the connected broadcaster identity', async () => {
  const fixture = setup();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (calls.length === 1) {
      return jsonResponse([reward], { pagination: { cursor: 'next-page' } });
    }
    return jsonResponse([{ ...reward, id: 'reward-2' }]);
  };
  try {
    const rewards = await fixture.service.listCustomRewards(workspace, actor);
    assert.deepEqual(rewards.map((item) => item.id), ['reward-1', 'reward-2']);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.searchParams.get('broadcaster_id'), 'broadcaster-123');
    assert.equal(calls[0].url.searchParams.get('first'), '50');
    assert.equal(calls[1].url.searchParams.get('after'), 'next-page');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-access-token');
    assert.equal(calls[0].init.headers['Client-Id'], 'test-client-id');
  } finally {
    globalThis.fetch = originalFetch;
    fixture.cleanup();
  }
});

test('creates, updates, and deletes a Twitch custom reward through Helix', async () => {
  const fixture = setup();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    const parsedBody = init.body ? JSON.parse(init.body) : null;
    return jsonResponse([{ ...reward, ...(parsedBody ?? {}) }]);
  };
  try {
    const created = await fixture.service.createCustomReward(workspace, actor, {
      title: 'Media request',
      cost: 500,
      prompt: 'Enter a URL',
      is_user_input_required: true,
    });
    assert.equal(created.id, reward.id);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(JSON.parse(calls[0].init.body).cost, 500);

    const updated = await fixture.service.updateCustomReward(workspace, actor, reward.id, {
      title: 'Updated request',
      is_enabled: false,
    });
    assert.equal(updated.title, 'Updated request');
    assert.equal(calls[1].init.method, 'PATCH');
    assert.equal(calls[1].url.searchParams.get('id'), reward.id);

    await fixture.service.deleteCustomReward(workspace, actor, reward.id);
    assert.equal(calls[2].init.method, 'DELETE');
    assert.equal(calls[2].url.searchParams.get('broadcaster_id'), 'broadcaster-123');
  } finally {
    globalThis.fetch = originalFetch;
    fixture.cleanup();
  }
});

test('rejects unconnected workspaces before making a Twitch API request', async () => {
  const fixture = setup();
  const originalFetch = globalThis.fetch;
  const service = new TwitchHelixService({
    async getStatus() {
      return { status: 'reauth_required', externalAccountId: 'broadcaster-123' };
    },
    async getAccessToken() {
      throw new Error('A disconnected integration must not request a token.');
    },
  });
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('Fetch must not be called.');
  };
  try {
    await assert.rejects(
      service.listCustomRewards(workspace, actor),
      (error) => error instanceof Error && 'getStatus' in error && error.getStatus() === 401,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.cleanup();
  }
});
