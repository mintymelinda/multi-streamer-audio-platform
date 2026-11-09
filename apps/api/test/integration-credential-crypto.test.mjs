import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
} from '../src/security/integration-credential-crypto.ts';

const ring = {
  currentVersion: 'test-v1',
  keys: { 'test-v1': Buffer.alloc(32, 7).toString('base64') },
};
const context = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  provider: 'twitch',
  credentialId: '22222222-2222-4222-8222-222222222222',
};

test('integration credentials round-trip through an authenticated envelope', () => {
  const plaintext = JSON.stringify({
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
  });
  const envelope = encryptIntegrationCredentials(plaintext, context, ring);
  assert.equal(envelope.formatVersion, 1);
  assert.equal(decryptIntegrationCredentials(envelope, context, ring), plaintext);
  assert.equal(JSON.stringify(envelope).includes('access-secret'), false);
});

test('credential ciphertext cannot be moved to another workspace or provider', () => {
  const envelope = encryptIntegrationCredentials('secret-payload', context, ring);
  assert.throws(() =>
    decryptIntegrationCredentials(
      envelope,
      { ...context, workspaceId: '33333333-3333-4333-8333-333333333333' },
      ring,
    ),
  );
  assert.throws(() =>
    decryptIntegrationCredentials(envelope, { ...context, provider: 'spotify' }, ring),
  );
});

test('credential envelope cannot be decrypted after tampering', () => {
  const envelope = encryptIntegrationCredentials('secret-payload', context, ring);
  const tampered = { ...envelope, ciphertext: Buffer.from('changed').toString('base64') };
  assert.throws(() => decryptIntegrationCredentials(tampered, context, ring));
});

test('missing KEK version fails closed', () => {
  const envelope = encryptIntegrationCredentials('secret-payload', context, ring);
  assert.throws(() =>
    decryptIntegrationCredentials(envelope, context, { currentVersion: 'other', keys: {} }),
  );
});
