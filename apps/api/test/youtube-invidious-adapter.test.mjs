import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubeInvidiousAdapter } from '../dist/providers/youtube-invidious.adapter.js';

const video = {
  type: 'video',
  videoId: 'abcdefghijk',
  title: 'Example Track',
  author: 'Example Artist',
  lengthSeconds: 180,
  videoThumbnails: [{ url: 'https://img.example.test/thumb.jpg' }],
};

test('search maps only video results into provider-neutral media metadata', async () => {
  const adapter = new YouTubeInvidiousAdapter({
    instances: ['https://invidious.example.test'],
    transport: transportFor(async () => ({ status: 200, data: [video, { type: 'playlist' }] })),
  });
  const results = await adapter.search({ query: 'Example Track' });
  assert.equal(results.length, 1);
  assert.deepEqual(
    {
      mediaId: results[0].mediaId,
      title: results[0].title,
      artist: results[0].artist,
      durationSeconds: results[0].durationSeconds,
      canonicalUrl: results[0].canonicalUrl,
    },
    {
      mediaId: 'abcdefghijk',
      title: 'Example Track',
      artist: 'Example Artist',
      durationSeconds: 180,
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    },
  );
});

test('resolve preserves the original media ID and falls back to the next configured instance', async () => {
  const calls = [];
  const adapter = new YouTubeInvidiousAdapter({
    instances: ['https://primary.example.test', 'https://secondary.example.test'],
    transport: transportFor(async (input) => {
      calls.push(input.baseUrl);
      if (input.baseUrl.includes('primary')) throw new Error('connection refused');
      return { status: 200, data: video };
    }),
  });
  const result = await adapter.resolve({ mediaId: 'abcdefghijk' });
  assert.equal(result.mediaId, 'abcdefghijk');
  assert.equal(result.instanceUrl, 'https://secondary.example.test');
  assert.deepEqual(calls, ['https://primary.example.test', 'https://secondary.example.test']);
});

test('health reports unconfigured and unavailable instances without throwing', async () => {
  const unconfigured = new YouTubeInvidiousAdapter();
  assert.deepEqual(await unconfigured.healthCheck(), { status: 'unconfigured' });
  const unavailable = new YouTubeInvidiousAdapter({
    instances: ['https://down.example.test'],
    transport: transportFor(async () => {
      throw new Error('offline');
    }),
  });
  assert.deepEqual(await unavailable.healthCheck(), { status: 'unavailable' });
});

test('rejects invalid media IDs and unsafe instance URLs', async () => {
  const adapter = new YouTubeInvidiousAdapter({ instances: ['https://invidious.example.test'] });
  await assert.rejects(adapter.resolve({ mediaId: 'not-a-valid-id' }), {
    code: 'INVALID_MEDIA_ID',
  });
  assert.throws(
    () => new YouTubeInvidiousAdapter({ instances: ['http://public.example.test'] }),
    /must use HTTPS/,
  );
  assert.throws(
    () => new YouTubeInvidiousAdapter({ instances: ['https://user:pass@example.test'] }),
    /unsupported URL components/,
  );
});

test('does not expose direct playback until an approved playback path is implemented', async () => {
  const adapter = new YouTubeInvidiousAdapter({ instances: ['https://invidious.example.test'] });
  assert.equal(adapter.capabilities.playback, false);
  await assert.rejects(adapter.play(), { code: 'PLAYBACK_NOT_SUPPORTED' });
});

function transportFor(handler) {
  return { request: handler };
}
