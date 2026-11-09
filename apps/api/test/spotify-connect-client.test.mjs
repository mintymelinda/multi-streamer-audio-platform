import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotifyConnectClient } from '../dist/providers/spotify-connect.client.js';

function response(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('lists personal Connect devices without exposing access tokens', async () => {
  const calls = [];
  const client = new SpotifyConnectClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return response(200, {
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
    });
  });

  const devices = await client.getDevices('secret-token');
  assert.deepEqual(devices, [
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
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
});

test('maps an inactive personal playback session to null', async () => {
  const client = new SpotifyConnectClient(async () => response(204, null));
  assert.equal(await client.getPlayback('token'), null);
});

test('supports personal playback commands and transfer without touching platform queues', async () => {
  const calls = [];
  const client = new SpotifyConnectClient(async (url, options) => {
    calls.push({ url: String(url), options });
    return response(204, null);
  });

  await client.pause('token', 'device 1');
  await client.next('token');
  await client.previous('token');
  await client.seek('token', 42_000, 'device-1');
  await client.transferPlayback('token', 'device-2', true);
  await client.play('token', { deviceId: 'device-3', uri: 'spotify:track:abc' });

  assert.match(calls[0].url, /pause\?device_id=device\+1$/);
  assert.match(calls[1].url, /\/next$/);
  assert.match(calls[2].url, /\/previous$/);
  assert.match(calls[3].url, /position_ms=42000/);
  assert.deepEqual(JSON.parse(calls[4].options.body), { device_ids: ['device-2'], play: true });
  assert.deepEqual(JSON.parse(calls[5].options.body), { uris: ['spotify:track:abc'] });
  assert.equal(calls.some((call) => call.url.includes('queue')), false);
});

test('rejects invalid seek positions and missing device IDs', async () => {
  const client = new SpotifyConnectClient(async () => response(204, null));
  await assert.rejects(client.seek('token', -1), /non-negative integer/);
  await assert.rejects(client.transferPlayback('token', ' '), /device ID/);
});

test('translates expired authorization and rate limiting into safe errors', async () => {
  const expired = new SpotifyConnectClient(async () => response(401, { error: 'invalid_token' }));
  const limited = new SpotifyConnectClient(async () =>
    response(429, { error: 'rate_limited' }, { 'Retry-After': '7' }),
  );
  await assert.rejects(expired.getDevices('token'), /authorization expired/i);
  await assert.rejects(limited.getDevices('token'), /rate limit/i);
});
