import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubeInvidiousMediaResolver } from '../dist/providers/playback-media-source.resolver.js';

test('resolves YouTube source media to a stream without making Invidious an output adapter', async () => {
  const calls = [];
  const resolver = new YouTubeInvidiousMediaResolver({
    resolve: async (url) => {
      calls.push(url);
      return {
        providerId: 'youtube',
        mediaId: 'abcdefghijk',
        title: 'Example Track',
        author: 'Example Artist',
        durationSeconds: 180,
        mimeType: 'audio/webm',
        bitrate: 160000,
        streamUrl: 'https://media.example.test/audio',
        instanceUrl: 'https://invidious.example.test',
      };
    },
  });
  const result = await resolver.resolve({
    providerId: 'youtube',
    mediaId: 'abcdefghijk',
    mediaUrl: null,
  });
  assert.equal(calls[0], 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(result.streamUrl, 'https://media.example.test/audio');
  assert.equal(result.sourceProviderId, 'youtube');
});

test('rejects a media source provider that does not match the resolver', async () => {
  const resolver = new YouTubeInvidiousMediaResolver({ resolve: async () => { throw new Error('unused'); } });
  await assert.rejects(
    resolver.resolve({ providerId: 'spotify', mediaId: 'abcdefghijk', mediaUrl: null }),
    /cannot resolve another source provider/,
  );
});
