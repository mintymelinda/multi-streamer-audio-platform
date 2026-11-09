import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateProviderAdapter,
  supportsProviderRequest,
  redactProviderSecrets,
} from '../src/providers/provider-contracts.ts';

const baseAdapter = {
  providerId: 'youtube',
  instanceId: 'youtube-main',
  contractVersion: 1,
  capabilities: {
    search: true,
    resolve: true,
    playback: true,
    pause: false,
    resume: false,
    seek: false,
    queue: false,
    maxDurationSeconds: 900,
    mediaTypes: ['video', 'audio'],
  },
  health: { status: 'healthy' },
};

test('accepts a versioned adapter with an explicit, internally consistent capability declaration', () => {
  assert.equal(validateProviderAdapter(baseAdapter), true);
});

test('rejects missing identity, unsupported contract versions, and malformed capabilities', () => {
  assert.throws(() => validateProviderAdapter({ ...baseAdapter, providerId: '' }));
  assert.throws(() => validateProviderAdapter({ ...baseAdapter, instanceId: undefined }));
  assert.throws(() => validateProviderAdapter({ ...baseAdapter, contractVersion: 0 }));
  assert.throws(() =>
    validateProviderAdapter({
      ...baseAdapter,
      capabilities: { ...baseAdapter.capabilities, maxDurationSeconds: -1 },
    }),
  );
  assert.throws(() =>
    validateProviderAdapter({
      ...baseAdapter,
      capabilities: { ...baseAdapter.capabilities, mediaTypes: [] },
    }),
  );
});

test('matches requests only against declared media, duration, and operation capabilities', () => {
  assert.equal(
    supportsProviderRequest(baseAdapter.capabilities, {
      mediaType: 'audio',
      durationSeconds: 240,
      requiredOperations: ['search', 'resolve', 'playback'],
    }),
    true,
  );
  assert.equal(
    supportsProviderRequest(baseAdapter.capabilities, {
      mediaType: 'audio',
      durationSeconds: 901,
      requiredOperations: ['playback'],
    }),
    false,
  );
  assert.equal(
    supportsProviderRequest(baseAdapter.capabilities, {
      mediaType: 'audio',
      durationSeconds: 240,
      requiredOperations: ['playback', 'pause'],
    }),
    false,
  );
  assert.equal(
    supportsProviderRequest(baseAdapter.capabilities, {
      mediaType: 'live_stream',
      durationSeconds: null,
      requiredOperations: ['playback'],
    }),
    false,
  );
});

test('redacts nested provider credentials without altering harmless diagnostic fields', () => {
  const input = {
    providerId: 'spotify',
    status: 'connected',
    credentials: {
      accessToken: 'access-secret',
      refresh_token: 'refresh-secret',
      nested: { clientSecret: 'client-secret' },
    },
    headers: { Authorization: 'Bearer private-token' },
    message: 'Provider responded with HTTP 503',
  };
  const redacted = redactProviderSecrets(input);
  const serialized = JSON.stringify(redacted);
  for (const secret of ['access-secret', 'refresh-secret', 'client-secret', 'private-token']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(redacted.providerId, 'spotify');
  assert.equal(redacted.message, input.message);
});
