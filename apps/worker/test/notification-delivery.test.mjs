import assert from 'node:assert/strict';
import test from 'node:test';
import { EMAIL_MAX_ATTEMPTS, emailRetryDelaySeconds, emailRetryIsTerminal } from '../dist/email-dispatcher.service.js';

test('email delivery retries use bounded exponential backoff', () => {
  assert.equal(emailRetryDelaySeconds(1), 30);
  assert.equal(emailRetryDelaySeconds(2), 60);
  assert.equal(emailRetryDelaySeconds(3), 120);
  assert.equal(emailRetryDelaySeconds(10), 15360);
  assert.equal(emailRetryDelaySeconds(20), 61440);
});

test('email delivery becomes terminal at the configured maximum attempt count', () => {
  assert.equal(EMAIL_MAX_ATTEMPTS, 10);
  assert.equal(emailRetryIsTerminal(9), false);
  assert.equal(emailRetryIsTerminal(10), true);
});
