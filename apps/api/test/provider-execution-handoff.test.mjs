import assert from 'node:assert/strict';
import test from 'node:test';
import {
  signProviderExecutionHandoff,
  verifyProviderExecutionHandoffSignature,
} from '../dist/providers/provider-execution-handoff.controller.js';

const secret = 'test-provider-execution-handoff-secret-at-least-32-bytes';
const body = {
  executionStateId: '10000000-0000-4000-8000-000000000001',
  workspaceId: '20000000-0000-4000-8000-000000000002',
  requestId: '30000000-0000-4000-8000-000000000003',
  providerInstanceId: '40000000-0000-4000-8000-000000000004',
  dispatchGeneration: 7,
  actorUserId: '50000000-0000-4000-8000-000000000005',
};

test('accepts a correctly signed handoff within the timestamp window', () => {
  const timestamp = '1794500000';
  const signature = signProviderExecutionHandoff(secret, timestamp, body);
  assert.equal(verifyProviderExecutionHandoffSignature({
    secret,
    timestamp,
    signature,
    body,
    nowSeconds: 1794500001,
  }), true);
});

test('rejects modified payloads and invalid signatures', () => {
  const timestamp = '1794500000';
  const signature = signProviderExecutionHandoff(secret, timestamp, body);
  assert.equal(verifyProviderExecutionHandoffSignature({
    secret,
    timestamp,
    signature,
    body: { ...body, actorUserId: '60000000-0000-4000-8000-000000000006' },
    nowSeconds: 1794500001,
  }), false);
  assert.equal(verifyProviderExecutionHandoffSignature({
    secret,
    timestamp,
    signature: '0'.repeat(64),
    body,
    nowSeconds: 1794500001,
  }), false);
});

test('rejects stale timestamps and malformed signature headers', () => {
  assert.equal(verifyProviderExecutionHandoffSignature({
    secret,
    timestamp: '1794500000',
    signature: 'a'.repeat(64),
    body,
    nowSeconds: 1794500400,
  }), false);
  assert.equal(verifyProviderExecutionHandoffSignature({
    secret,
    timestamp: 'not-a-timestamp',
    signature: 'a'.repeat(64),
    body,
    nowSeconds: 1794500001,
  }), false);
});
