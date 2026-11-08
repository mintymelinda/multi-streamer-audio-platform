import assert from 'node:assert/strict';
import test from 'node:test';
import { isExactQueuePermutation, moveQueueItem } from '../src/requests/queue-ordering.ts';

test('accepts only a complete, duplicate-free permutation of the queue', () => {
  const current = ['a', 'b', 'c'];
  assert.equal(isExactQueuePermutation(current, ['c', 'a', 'b']), true);
  assert.equal(isExactQueuePermutation(current, ['a', 'b']), false);
  assert.equal(isExactQueuePermutation(current, ['a', 'a', 'c']), false);
  assert.equal(isExactQueuePermutation(current, ['a', 'b', 'foreign']), false);
});

test('moves an existing queue item to the front or back without duplicating it', () => {
  const current = ['a', 'b', 'c'];
  assert.deepEqual(moveQueueItem(current, 'b', 'front'), ['b', 'a', 'c']);
  assert.deepEqual(moveQueueItem(current, 'b', 'back'), ['a', 'c', 'b']);
  assert.deepEqual(current, ['a', 'b', 'c']);
  assert.equal(moveQueueItem(current, 'missing', 'front'), null);
});
