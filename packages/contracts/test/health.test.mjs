import assert from 'node:assert/strict';
import test from 'node:test';
import { getHealthResponse } from '../src/health.ts';

test('health response is stable and timestamped', () => {
  const result = getHealthResponse(new Date('2026-01-02T03:04:05.000Z'));
  assert.deepEqual(result, { status: 'ok', timestamp: '2026-01-02T03:04:05.000Z' });
});
