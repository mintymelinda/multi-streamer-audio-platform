import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubeInvidiousAdapter } from '../dist/providers/youtube-invidious.adapter.js';

const adapters = [['YouTube/Invidious', YouTubeInvidiousAdapter]];

for (const [name, Adapter] of adapters) {
  test(`${name} adapter satisfies the shared provider contract and is replaceable`, async () => {
    const adapter = new Adapter({
      transport: createFakeTransport(),
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
    });
    await assert.rejects(adapter.search({ query: 'test' }), (error) => {
      const serialized = JSON.stringify(error);
      return !serialized.includes('authorization') && !serialized.includes('credentials');
    });
  });
}

test('Invidious instance outage can be recovered by selecting another configured instance without changing media identity', async () => {
  const adapter = new YouTubeInvidiousAdapter({
    instances: ['https://primary.example.test', 'https://secondary.example.test'],
    transport: createPrimaryOutageTransport(),
  });
  const result = await adapter.resolve({ mediaId: 'abcdefghijk' });
  assert.equal(result.mediaId, 'abcdefghijk');
  assert.equal(result.instanceUrl, 'https://secondary.example.test');
});

function createFakeTransport() {
  return {
    request: async () => ({ status: 200, data: { items: [], playback: 'ok' } }),
  };
}
function createFailingTransport() {
  return {
    request: async () => {
      throw new Error('provider failed');
    },
  };
}
function createPrimaryOutageTransport() {
  return {
    request: async ({ baseUrl }) => {
      if (baseUrl.includes('primary')) throw new Error('connection refused');
      return {
        status: 200,
        data: {
          videoId: 'abcdefghijk',
          title: 'Example Track',
          author: 'Example Artist',
          lengthSeconds: 180,
        },
      };
    },
  };
}
