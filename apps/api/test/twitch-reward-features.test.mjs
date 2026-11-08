import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTwitchRewardFeatureKey,
  normalizeTwitchRewardFeatureSettings,
} from '../src/integrations/twitch-reward-features.ts';

test('only implemented Twitch reward feature handlers are accepted', () => {
  assert.equal(isTwitchRewardFeatureKey('media_request'), true);
  assert.equal(isTwitchRewardFeatureKey('playback_control'), false);
  assert.equal(isTwitchRewardFeatureKey('Song Request'), false);
});

test('media request settings receive stable defaults', () => {
  assert.deepEqual(normalizeTwitchRewardFeatureSettings('media_request', {}), {
    inputMode: 'url_or_search',
    priority: 0,
  });
});

test('media request settings accept supported input modes and priority', () => {
  assert.deepEqual(
    normalizeTwitchRewardFeatureSettings('media_request', {
      inputMode: 'url_only',
      priority: 50,
    }),
    { inputMode: 'url_only', priority: 50 },
  );
});

test('unsupported settings and invalid priorities are rejected', () => {
  assert.throws(
    () => normalizeTwitchRewardFeatureSettings('media_request', { inputMode: 'anything' }),
    /inputMode/,
  );
  assert.throws(
    () => normalizeTwitchRewardFeatureSettings('media_request', { priority: 101 }),
    /priority/,
  );
  assert.throws(
    () => normalizeTwitchRewardFeatureSettings('media_request', { arbitrary: true }),
    /unsupported field/,
  );
  assert.throws(
    () => normalizeTwitchRewardFeatureSettings('media_request', null),
    /must be an object/,
  );
});
