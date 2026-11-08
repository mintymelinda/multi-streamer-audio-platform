import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyTwitchEventSubSignature } from '../src/integrations/twitch-eventsub-signature.ts';

const secret = 'eventsub-test-signing-secret';
const messageId = 'test-message-001';
const now = Date.parse('2026-11-08T18:00:00.000Z');
const timestamp = new Date(now).toISOString();
const body = Buffer.from(JSON.stringify({ subscription: { id: 'sub-1' }, event: { id: 'event-1' } }));

function signature(rawBody: Buffer, signedAt = timestamp): string {
  const digest = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(messageId), Buffer.from(signedAt), rawBody]))
    .digest('hex');
  return `sha256=${digest}`;
}

test('accepts a correctly signed, fresh EventSub message', () => {
  assert.equal(
    verifyTwitchEventSubSignature(
      {
        messageId,
        messageTimestamp: timestamp,
        messageSignature: signature(body),
      },
      body,
      secret,
      now,
    ),
    true,
  );
});

test('rejects a body modified after signing', () => {
  assert.equal(
    verifyTwitchEventSubSignature(
      {
        messageId,
        messageTimestamp: timestamp,
        messageSignature: signature(body),
      },
      Buffer.from(body.toString('utf8') + ' '),
      secret,
      now,
    ),
    false,
  );
});

test('rejects stale and future-dated messages outside the replay window', () => {
  const staleTimestamp = new Date(now - 11 * 60 * 1000).toISOString();
  const futureTimestamp = new Date(now + 11 * 60 * 1000).toISOString();
  assert.equal(
    verifyTwitchEventSubSignature(
      {
        messageId,
        messageTimestamp: staleTimestamp,
        messageSignature: signature(body, staleTimestamp),
      },
      body,
      secret,
      now,
    ),
    false,
  );
  assert.equal(
    verifyTwitchEventSubSignature(
      {
        messageId,
        messageTimestamp: futureTimestamp,
        messageSignature: signature(body, futureTimestamp),
      },
      body,
      secret,
      now,
    ),
    false,
  );
});

test('rejects malformed signatures and missing header values', () => {
  assert.equal(
    verifyTwitchEventSubSignature(
      { messageId, messageTimestamp: timestamp, messageSignature: 'sha256=not-hex' },
      body,
      secret,
      now,
    ),
    false,
  );
  assert.equal(
    verifyTwitchEventSubSignature(
      { messageId: '', messageTimestamp: timestamp, messageSignature: signature(body) },
      body,
      secret,
      now,
    ),
    false,
  );
});
