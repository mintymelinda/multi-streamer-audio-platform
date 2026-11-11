import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractYouTubeVideoId,
  InvidiousResolutionError,
  InvidiousResolverService,
} from '../dist/providers/invidious-resolver.service.js';

const video = {
  title: 'Example track',
  author: 'Example artist',
  lengthSeconds: 213,
  adaptiveFormats: [
    { type: 'video/mp4; codecs="avc1"', url: 'https://media.example/video', bitrate: 900000 },
    { type: 'audio/webm; codecs="opus"', url: 'https://media.example/audio-low', bitrate: 64000 },
    { type: 'audio/mp4; codecs="mp4a.40.2"', url: 'https://media.example/audio-high', bitrate: 128000 },
    { type: 'audio/mp4', url: 'http://media.example/insecure', bitrate: 256000 },
    { type: 'audio/mp4', url: 'not a URL', bitrate: 512000 },
  ],
};

test('extracts video IDs from supported YouTube URL forms', () => {
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/watch?v=abcdefghijk&t=12'), 'abcdefghijk');
  assert.equal(extractYouTubeVideoId('https://youtu.be/abcdefghijk'), 'abcdefghijk');
  assert.equal(extractYouTubeVideoId('https://youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(extractYouTubeVideoId('https://music.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
});

test('rejects non-YouTube URLs and malformed video IDs', () => {
  assert.throws(() => extractYouTubeVideoId('https://example.com/watch?v=abcdefghijk'), {
    name: 'InvidiousResolutionError',
    code: 'INVALID_YOUTUBE_VIDEO',
  });
  assert.throws(() => extractYouTubeVideoId('https://youtu.be/short'), {
    name: 'InvidiousResolutionError',
    code: 'INVALID_YOUTUBE_VIDEO',
  });
  assert.throws(() => extractYouTubeVideoId('not a URL'), {
    name: 'InvidiousResolutionError',
    code: 'INVALID_MEDIA_URL',
  });
});

test('resolves metadata and selects the highest-bitrate safe audio-only format', async () => {
  let requested;
  const resolver = new InvidiousResolverService({
    instanceUrl: 'https://invidious.example/',
    request: async (url, options) => {
      requested = { url: String(url), options };
      return new Response(JSON.stringify(video), { status: 200 });
    },
  });

  const result = await resolver.resolve('https://youtu.be/abcdefghijk');
  assert.equal(requested.url, 'https://invidious.example/api/v1/videos/abcdefghijk');
  assert.equal(requested.options.redirect, 'error');
  assert.equal(result.providerId, 'youtube');
  assert.equal(result.mediaId, 'abcdefghijk');
  assert.equal(result.title, 'Example track');
  assert.equal(result.author, 'Example artist');
  assert.equal(result.durationSeconds, 213);
  assert.equal(result.mimeType, 'audio/mp4');
  assert.equal(result.bitrate, 128000);
  assert.equal(result.streamUrl, 'https://media.example/audio-high');
});

test('returns a typed not-found error for missing videos', async () => {
  const resolver = new InvidiousResolverService({
    instanceUrl: 'https://invidious.example',
    request: async () => new Response('', { status: 404 }),
  });
  await assert.rejects(
    resolver.resolve('https://youtu.be/abcdefghijk'),
    (error) => error instanceof InvidiousResolutionError && error.code === 'MEDIA_NOT_FOUND',
  );
});

test('fails closed when no Invidious instance is configured', async () => {
  const resolver = new InvidiousResolverService({ instanceUrl: undefined });
  await assert.rejects(
    resolver.resolve('https://youtu.be/abcdefghijk'),
    (error) => error instanceof InvidiousResolutionError && error.code === 'INVIDIOUS_NOT_CONFIGURED',
  );
});

test('rejects insecure configured instances in production', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => new InvidiousResolverService({ instanceUrl: 'http://invidious.example' }),
      /credential-free HTTPS URL/,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
