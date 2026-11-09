import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotifyCatalogAdapter } from '../dist/providers/spotify-catalog.adapter.js';

const track = {
  id: '11dFghVXANMlKmJXsNCbNl',
  name: 'Example Track',
  duration_ms: 180_000,
  artists: [{ name: 'Example Artist' }],
  album: {
    name: 'Example Album',
    images: [{ url: 'https://i.scdn.co/image/example' }],
  },
};

test('search maps Spotify tracks into provider-neutral metadata', async () => {
  const adapter = new SpotifyCatalogAdapter({
    accessToken: 'test-token',
    market: 'ca',
    transport: transportFor(async (input) => {
      assert.equal(input.path, '/search');
      assert.equal(input.query.type, 'track');
      assert.equal(input.query.market, 'CA');
      return { status: 200, data: { tracks: { items: [track, null] } } };
    }),
  });
  const results = await adapter.search({ query: 'Example Track' });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    mediaId: '11dFghVXANMlKmJXsNCbNl',
    title: 'Example Track',
    artist: 'Example Artist',
    album: 'Example Album',
    durationSeconds: 180,
    thumbnailUrl: 'https://i.scdn.co/image/example',
    canonicalUrl: 'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl',
    spotifyUri: 'spotify:track:11dFghVXANMlKmJXsNCbNl',
  });
});

test('resolve accepts Spotify IDs, track URIs, and canonical track URLs', async () => {
  const inputs = [];
  const adapter = new SpotifyCatalogAdapter({
    accessToken: 'test-token',
    transport: transportFor(async (input) => {
      inputs.push(input.path);
      return { status: 200, data: track };
    }),
  });
  for (const mediaId of [
    '11dFghVXANMlKmJXsNCbNl',
    'spotify:track:11dFghVXANMlKmJXsNCbNl',
    'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl',
  ]) {
    assert.equal((await adapter.resolve({ mediaId })).mediaId, '11dFghVXANMlKmJXsNCbNl');
  }
  assert.deepEqual(inputs, [
    '/tracks/11dFghVXANMlKmJXsNCbNl',
    '/tracks/11dFghVXANMlKmJXsNCbNl',
    '/tracks/11dFghVXANMlKmJXsNCbNl',
  ]);
});

test('reports unconfigured and expired authorization states', async () => {
  assert.deepEqual(await new SpotifyCatalogAdapter().healthCheck(), { status: 'unconfigured' });
  const adapter = new SpotifyCatalogAdapter({
    accessToken: 'expired-token',
    transport: transportFor(async () => ({ status: 401, data: {} })),
  });
  assert.deepEqual(await adapter.healthCheck(), { status: 'authorization_expired' });
  await assert.rejects(adapter.search({ query: 'test' }), { code: 'AUTHORIZATION_EXPIRED' });
});

test('maps forbidden, missing, and rate-limited responses without exposing tokens', async () => {
  for (const [status, code] of [[403, 'FORBIDDEN'], [404, 'MEDIA_NOT_FOUND'], [429, 'RATE_LIMITED']]) {
    const adapter = new SpotifyCatalogAdapter({
      accessToken: 'never-leak-this-token',
      transport: transportFor(async () => ({ status, data: {} })),
    });
    await assert.rejects(adapter.resolve({ mediaId: '11dFghVXANMlKmJXsNCbNl' }), (error) => {
      assert.equal(error.code, code);
      assert.equal(JSON.stringify(error).includes('never-leak-this-token'), false);
      return true;
    });
  }
});

test('does not enable Spotify playback or expose stream extraction', async () => {
  const adapter = new SpotifyCatalogAdapter({ accessToken: 'test-token' });
  assert.equal(adapter.capabilities.playback, false);
  assert.equal(adapter.capabilities.queue, false);
  await assert.rejects(adapter.play(), { code: 'PLAYBACK_NOT_SUPPORTED' });
});

test('rejects invalid search limits, market codes, and track identifiers', async () => {
  const adapter = new SpotifyCatalogAdapter({ accessToken: 'test-token' });
  await assert.rejects(adapter.search({ query: 'test', limit: 11 }), /limit must be between/);
  await assert.rejects(adapter.resolve({ mediaId: 'not-a-track' }), { code: 'INVALID_MEDIA_ID' });
  assert.throws(() => new SpotifyCatalogAdapter({ market: 'CAN' }), /two-letter country code/);
});

function transportFor(handler) {
  return { request: handler };
}
