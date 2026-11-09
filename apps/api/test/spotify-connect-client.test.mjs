import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotifyConnectClient } from '../dist/providers/spotify-connect.client.js';

function response(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('maps personal Connect devices', async () => {
  const client = new SpotifyConnectClient(async () =>
    response(200, {
      devices: [
        {
          id: 'device-1',
          name: 'Desktop speakers',
          type: 'Computer',
          is_active: true,
          is_restricted: false,
          volume_percent: 35,
        },
      ],
    }),
  );
  assert.deepEqual(await client.getDevices('token'), [
    {
      id: 'device-1',
      name: 'Desktop speakers',
      type: 'Computer',
      isActive: true,
      isPrivateSession: false,
      isRestricted: false,
      volumePercent: 35,
    },
  ]);
});

test('returns null when no personal playback session is active', async () => {
  const client = new SpotifyConnectClient(async () => response(204, null));
  assert.equal(await client.getPlayback('token'), null);
});

test('issues personal playback commands without using platform queues', async () => {
  const calls = [];
  const client = new SpotifyConnectClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return response(204, null);
  });
  await client.play('token', { deviceId: 'd1', uri: 'spotify:track:abc' });
  await client.pause('token', 'd1');
  await client.next('token');
  await client.previous('token');
  await client.seek('token', 42000, 'd1');
  await client.transferPlayback('token', 'd2', true);
  assert.deepEqual(JSON.parse(calls[0].options.body), { uris: ['spotify:track:abc'] });
  assert.ok(calls[1].url.endsWith('/pause?device_id=d1'));
  assert.ok(calls[2].url.endsWith('/next'));
  assert.ok(calls[3].url.endsWith('/previous'));
  assert.match(calls[4].url, /position_ms=42000/);
  assert.deepEqual(JSON.parse(calls[5].options.body), { device_ids: ['d2'], play: true });
  assert.equal(
    calls.some(({ url }) => url.includes('queue')),
    false,
  );
});

test('rejects invalid seek positions and missing device IDs', async () => {
  const client = new SpotifyConnectClient(async () => response(204, null));
  await assert.rejects(client.seek('token', -1), /non-negative integer/);
  await assert.rejects(client.transferPlayback('token', ' '), /device ID/);
});

test('returns safe authorization and rate-limit errors', async () => {
  const unauthorized = new SpotifyConnectClient(async () => response(401, {}));
  const limited = new SpotifyConnectClient(async () => response(429, {}));
  await assert.rejects(unauthorized.getDevices('token'), /authorization expired/i);
  await assert.rejects(limited.getDevices('token'), /rate limit/i);
});
