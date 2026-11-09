import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;

export interface TwitchEventSubSignatureHeaders {
  messageId: string;
  messageTimestamp: string;
  messageSignature: string;
}

export function verifyTwitchEventSubSignature(
  headers: TwitchEventSubSignatureHeaders,
  rawBody: Buffer,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (
    !headers.messageId ||
    !headers.messageTimestamp ||
    !headers.messageSignature.startsWith('sha256=') ||
    !secret
  ) {
    return false;
  }

  const timestampMs = Date.parse(headers.messageTimestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > MAX_MESSAGE_AGE_MS) {
    return false;
  }

  const suppliedHex = headers.messageSignature.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;

  const signedMessage = Buffer.concat([
    Buffer.from(headers.messageId, 'utf8'),
    Buffer.from(headers.messageTimestamp, 'utf8'),
    rawBody,
  ]);
  const expected = createHmac('sha256', secret).update(signedMessage).digest();
  const supplied = Buffer.from(suppliedHex, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
