import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRequestTransition,
  canTransitionRequest,
  classifyModeration,
} from '../src/requests/request-state-machine.ts';

test('request state machine permits only declared forward transitions', () => {
  assert.equal(canTransitionRequest('submitted', 'pending'), true);
  assert.equal(canTransitionRequest('pending', 'approved'), true);
  assert.equal(canTransitionRequest('approved', 'queued'), true);
  assert.equal(canTransitionRequest('queued', 'resolving'), true);
  assert.equal(canTransitionRequest('playing', 'completed'), true);
  assert.equal(canTransitionRequest('completed', 'queued'), false);
  assert.equal(canTransitionRequest('rejected', 'approved'), false);
  assert.throws(
    () => assertRequestTransition('completed', 'queued'),
    /Invalid request state transition/,
  );
});

test('automatic moderation approves without applying optional word filters', () => {
  assert.equal(classifyModeration('automatic', 'blocked term', null, [], ['blocked']), 'approved');
});

test('manual moderation sends every request to pending review', () => {
  assert.equal(classifyModeration('manual', 'blocked term', null, [], ['blocked']), 'pending');
});

test('filtered moderation rejects before hold and matches case-insensitively', () => {
  assert.equal(classifyModeration('filtered', 'Bad Song', null, ['bad'], ['song']), 'rejected');
  assert.equal(classifyModeration('filtered', 'Needs Review', null, ['needs'], []), 'held');
  assert.equal(
    classifyModeration('filtered', 'Clean Song', 'Artist', ['explicit'], ['blocked']),
    'approved',
  );
});
