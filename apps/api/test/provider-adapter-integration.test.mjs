import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubeInvidiousAdapter } from '../dist/providers/youtube-invidious.adapter.js';
import { SpotifyAdapter } from '../dist/providers/spotify.adapter.js';
import { LyrionAdapter } from '../dist/providers/lyrion.adapter.js';

const adapters = [
  ['YouTube/Invidious', YouTubeInvidiousAdapter],
  ['Spotify', SpotifyAdapter],
  ['Lyrion', LyrionAdapter],
];

for (const [name, Adapter] of adapters) {
  test(`${name} adapter satisfies the shared provider contract and is replaceable`, async () => {
    const adapter = new Adapter({
      transport: createFakeTransport(),
      credentials: createFakeCredentials(),
    });
    assert.equal(adapter.contractVersion, 1);
    assert.ok(adapter.providerId);
    assert.ok(adapter.capabilities);
    assert.equal(typeof adapter.healthCheck, 'function');
    assert.equal(typeof adapter.search, 'function');
    assert.equal(typeof adapter.resolve, 'function');
    assert.equal(typeof adapter.play, 'function');
    assert.equal(typeof adapter.disconnect, 'function');
  });

  test(`${name} adapter maps provider errors without leaking secrets or provider-specific objects`, async () => {
    const adapter = new Adapter({
      transport: createFailingTransport(),
      credentials: createFakeCredentials(),
    });
    await assert.rejects(adapter.search({ query: 'test' }), (error) => {
      const serialized = JSON.stringify(error);
      return (
        !serialized.includes('test-access-token') && !serialized.includes('test-client-secret')
      );
    });
  });
}

test('Spotify authorization expiry is surfaced as reconnect-required, not transient provider outage', async () => {
  const adapter = new SpotifyAdapter({
    transport: createUnauthorizedTransport(),
    credentials: createFakeCredentials(),
  });
  await assert.rejects(adapter.healthCheck(), (error) => error.code === 'AUTHORIZATION_EXPIRED');
});

test('Invidious instance outage can be recovered by selecting another configured instance without changing media identity', async () => {
  const adapter = new YouTubeInvidiousAdapter({
    instances: ['https://primary.example.test', 'https://secondary.example.test'],
    transport: createPrimaryOutageTransport(),
  });
  const result = await adapter.resolve({ mediaId: 'youtube-video-123' });
  assert.equal(result.mediaId, 'youtube-video-123');
  assert.equal(result.instanceUrl, 'https://secondary.example.test');
});

test('Lyrion adapter is optional and reports unavailable cleanly when no server is configured', async () => {
  const adapter = new LyrionAdapter({ transport: createFakeTransport(), serverUrl: null });
  assert.equal((await adapter.healthCheck()).status, 'unconfigured');
});

function createFakeTransport() {
  return {
    request: async () => ({ status: 200, data: { items: [], playback: 'ok' } }),
  };
}
function createFakeCredentials() {
  return { accessToken: 'test-access-token', clientSecret: 'test-client-secret' };
}
function createFailingTransport() {
  return {
    request: async () => {
      throw Object.assign(new Error('provider failed'), {
        authorization: 'Bearer test-access-token',
      });
    },
  };
}
function createUnauthorizedTransport() {
  return { request: async () => ({ status: 401, data: { error: 'invalid_token' } }) };
}
function createPrimaryOutageTransport() {
  return {
    request: async ({ baseUrl }) => {
      if (baseUrl.includes('primary')) throw new Error('connection refused');
      return { status: 200, data: { mediaId: 'youtube-video-123' } };
    },
  };
}
