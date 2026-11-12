import assert from 'node:assert/strict';
import test from 'node:test';
import { LyrionPlaybackAdapter } from '../dist/providers/lyrion-playback.adapter.js';

const streamUrl = 'https://media.example.test/audio?signature=opaque';
const sourceResolver = {
  providerId: 'youtube',
  resolve: async (source) => ({
    sourceProviderId: 'youtube',
    mediaId: source.mediaId ?? 'abcdefghijk',
    title: 'Example Track',
    artist: 'Example Artist',
    durationSeconds: 180,
    mimeType: 'audio/webm',
    bitrate: 160000,
    streamUrl,
  }),
};

function response(result) {
  return new Response(JSON.stringify({ id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('plays resolved YouTube media through the separate Lyrion output adapter', async () => {
  const calls = [];
  const adapter = new LyrionPlaybackAdapter({
    baseUrl: 'https://lms.example.test/lms',
    playerId: '00:11:22:33:44:55',
    username: 'streamer',
    password: 'private-password',
    mediaResolver: sourceResolver,
    allowedHosts: ['lms.example.test'],
    request: async (url, options) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      return response({});
    },
  });
  const result = await adapter.play({
    workspaceId: 'workspace-a',
    providerInstanceId: 'lyrion-a',
    playerId: '00:11:22:33:44:55',
    outputId: 'output-a',
    requestId: 'request-a',
    command: 'play',
    idempotencyKey: 'play-a',
    actorId: 'actor-a',
    payload: {
      sourceProviderId: 'youtube',
      mediaId: 'abcdefghijk',
      mediaUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    },
  });
  assert.deepEqual(result, { outcome: 'started' });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, 'https://lms.example.test/lms/jsonrpc.js');
  assert.equal(calls[0].options.headers.authorization, `Basic ${Buffer.from('streamer:private-password').toString('base64')}`);
  assert.deepEqual(calls.map((call) => call.body.params[1]), [
    ['power', '1'],
    ['playlist', 'clear'],
    ['playlist', 'add', streamUrl],
    ['play'],
  ]);
});

test('does not infer logical request identity from a matching Lyrion stream URL', async () => {
  const adapter = new LyrionPlaybackAdapter({
    baseUrl: 'https://lms.example.test',
    playerId: 'player-a',
    mediaResolver: sourceResolver,
    allowedHosts: ['lms.example.test'],
    request: async () => response({
      mode: 'play',
      playlist_cur_index: '2',
      playlist_loop: [
        { 'playlist index': 1, url: 'https://other.example.test/audio' },
        { 'playlist index': 2, url: streamUrl },
      ],
    }),
  });
  const state = await adapter.getPlaybackState({
    workspaceId: 'workspace-a',
    providerInstanceId: 'lyrion-a',
    playerId: 'player-a',
    outputId: 'output-a',
    requestId: 'request-a',
    command: 'play',
    idempotencyKey: 'play-a',
    actorId: 'actor-a',
    payload: { sourceProviderId: 'youtube', mediaId: 'abcdefghijk' },
  });
  assert.equal(state.status, 'playing');
  assert.equal(state.requestId, undefined);
  assert.equal(state.providerPlaybackId, '2');
});

test('does not claim a matching request when Lyrion is playing another stream', async () => {
  const adapter = new LyrionPlaybackAdapter({
    baseUrl: 'https://lms.example.test',
    playerId: 'player-a',
    mediaResolver: sourceResolver,
    allowedHosts: ['lms.example.test'],
    request: async () => response({
      mode: 'play',
      playlist_cur_index: '0',
      playlist_loop: [{ 'playlist index': 0, url: 'https://other.example.test/audio' }],
    }),
  });
  const state = await adapter.getPlaybackState({
    workspaceId: 'workspace-a',
    providerInstanceId: 'lyrion-a',
    playerId: 'player-a',
    outputId: 'output-a',
    requestId: 'request-a',
    command: 'play',
    idempotencyKey: 'play-a',
    actorId: 'actor-a',
    payload: { sourceProviderId: 'youtube', mediaId: 'abcdefghijk' },
  });
  assert.equal(state.status, 'playing');
  assert.equal(state.requestId, undefined);
});

test('rejects endpoints outside the operator allowlist', () => {
  assert.throws(
    () => new LyrionPlaybackAdapter({
      baseUrl: 'http://127.0.0.1:9000',
      playerId: 'player-a',
      mediaResolver: sourceResolver,
      allowedHosts: [],
    }),
    /operator-approved host/,
  );
});

test('does not dispatch a command when source resolution is unsupported', async () => {
  let calls = 0;
  const adapter = new LyrionPlaybackAdapter({
    baseUrl: 'https://lms.example.test',
    playerId: 'player-a',
    mediaResolver: sourceResolver,
    allowedHosts: ['lms.example.test'],
    request: async () => {
      calls += 1;
      return response({});
    },
  });
  await assert.rejects(
    adapter.play({
      workspaceId: 'workspace-a',
      providerInstanceId: 'lyrion-a',
      playerId: 'player-a',
      outputId: 'output-a',
      requestId: 'request-a',
      command: 'play',
      idempotencyKey: 'play-a',
      actorId: 'actor-a',
      payload: { sourceProviderId: 'spotify', mediaId: 'spotify-track' },
    }),
    (error) => error.code === 'UNSUPPORTED_MEDIA_SOURCE',
  );
  assert.equal(calls, 0);
});

test('uses explicit pause, resume, skip, and seek commands', async () => {
  const commands = [];
  const adapter = new LyrionPlaybackAdapter({
    baseUrl: 'https://lms.example.test',
    playerId: 'player-a',
    mediaResolver: sourceResolver,
    allowedHosts: ['lms.example.test'],
    request: async (_url, options) => {
      commands.push(JSON.parse(options.body).params[1]);
      return response({});
    },
  });
  const input = {
    workspaceId: 'workspace-a',
    providerInstanceId: 'lyrion-a',
    playerId: 'player-a',
    outputId: 'output-a',
    requestId: 'request-a',
    idempotencyKey: 'control-a',
    actorId: 'actor-a',
  };
  await adapter.pause({ ...input, command: 'pause' });
  await adapter.resume({ ...input, command: 'resume' });
  await adapter.skip({ ...input, command: 'skip' });
  await adapter.seek({ ...input, command: 'seek', payload: { positionMs: 12500 } });
  assert.deepEqual(commands, [
    ['pause', '1'],
    ['pause', '0'],
    ['playlist', 'index', '+1'],
    ['time', '12.5'],
  ]);
});

test('requires HTTPS for production even when an endpoint hostname is allowlisted', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => new LyrionPlaybackAdapter({
        baseUrl: 'http://lms.example.test:9000',
        playerId: 'player-a',
        mediaResolver: sourceResolver,
        allowedHosts: ['lms.example.test'],
      }),
      /secure transport/,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
