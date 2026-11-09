import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderSecretRedactionService,
} from '../dist/providers/provider-secret-redaction.service.js';

const secrets = [
  'access-token-value',
  'refresh-token-value',
  'client-secret-value',
  'credential-ciphertext-value',
  'Bearer authorization-value',
];

test('redacts secrets from structured application logs and nested provider errors', async () => {
  const redactor = new ProviderSecretRedactionService();
  const output = redactor.redact({
    message: 'Provider request failed',
    error: { message: '401 Unauthorized', headers: { authorization: 'Bearer authorization-value' } },
    credentials: {
      accessToken: secrets[0], refreshToken: secrets[1],
      clientSecret: secrets[2], ciphertext: secrets[3],
    },
  });
  const serialized = JSON.stringify(output);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
});

test('redacts secrets from browser/API DTOs without removing safe connection metadata', async () => {
  const redactor = new ProviderSecretRedactionService();
  const dto = redactor.toBrowserDto({
    providerId: 'spotify', status: 'connected', displayName: 'Streamer account',
    accessToken: secrets[0], refreshToken: secrets[1], clientSecret: secrets[2],
    credentialCiphertext: secrets[3], authorization: secrets[4],
  });
  const serialized = JSON.stringify(dto);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.equal(dto.providerId, 'spotify');
  assert.equal(dto.status, 'connected');
  assert.equal(dto.displayName, 'Streamer account');
});

test('redaction handles arrays, cyclic objects, and provider error serialization safely', async () => {
  const redactor = new ProviderSecretRedactionService();
  const value = { items: [{ access_token: secrets[0] }] };
  value.self = value;
  const result = redactor.redact(value);
  assert.equal(JSON.stringify(result).includes(secrets[0]), false);
});
