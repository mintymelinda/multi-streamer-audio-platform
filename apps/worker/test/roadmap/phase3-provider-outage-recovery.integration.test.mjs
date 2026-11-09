import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderExecutionProcessor } from '../dist/provider-execution.processor.js';

test('recovers from a provider outage using configured failover without changing requested media', async () => {
  const played = [];
  const processor = new ProviderExecutionProcessor({
    loadAuthoritativeRequest: async () => ({
      id: 'request-a',
      workspaceId: 'workspace-a',
      mediaId: 'original-media-id',
      mediaType: 'audio',
      status: 'approved',
    }),
    getCandidates: async () => [
      { providerInstanceId: 'primary', eligible: true, priority: 1 },
      { providerInstanceId: 'backup', eligible: true, priority: 2 },
    ],
    execute: async (providerInstanceId, request) => {
      if (providerInstanceId === 'primary')
        throw Object.assign(new Error('unavailable'), { status: 503 });
      played.push({ providerInstanceId, mediaId: request.mediaId });
      return { outcome: 'started', providerPlaybackId: 'playback-a' };
    },
    persistExecutionState: async () => undefined,
    appendAudit: async () => undefined,
  });
  const result = await processor.process({ workspaceId: 'workspace-a', requestId: 'request-a' });
  assert.equal(result.providerInstanceId, 'backup');
  assert.equal(played[0].mediaId, 'original-media-id');
});

test('does not retry or fail over after authorization expiry until reconnect and reconciliation', async () => {
  let executionCount = 0;
  const processor = new ProviderExecutionProcessor({
    loadAuthoritativeRequest: async () => ({
      id: 'request-a',
      workspaceId: 'workspace-a',
      mediaId: 'media-a',
      status: 'approved',
    }),
    getCandidates: async () => [{ providerInstanceId: 'spotify-a', eligible: true, priority: 1 }],
    execute: async () => {
      executionCount += 1;
      throw Object.assign(new Error('expired'), { status: 401 });
    },
    persistExecutionState: async () => undefined,
  });
  await assert.rejects(processor.process({ workspaceId: 'workspace-a', requestId: 'request-a' }));
  assert.equal(executionCount, 1);
});

test('duplicate delivery and concurrent worker execution produce only one provider play', async () => {
  let playCount = 0;
  const processor = new ProviderExecutionProcessor({
    loadAuthoritativeRequest: async () => ({
      id: 'request-a',
      workspaceId: 'workspace-a',
      mediaId: 'media-a',
      status: 'approved',
    }),
    acquirePlaybackLease: async () => true,
    findPlaybackByRequest: async () =>
      playCount > 0 ? { status: 'playing', providerPlaybackId: 'playback-a' } : null,
    getCandidates: async () => [{ providerInstanceId: 'spotify-a', eligible: true, priority: 1 }],
    execute: async () => {
      playCount += 1;
      return { outcome: 'started', providerPlaybackId: 'playback-a' };
    },
    persistExecutionState: async () => undefined,
    releasePlaybackLease: async () => undefined,
  });
  const input = {
    workspaceId: 'workspace-a',
    requestId: 'request-a',
    idempotencyKey: 'request-a-play',
  };
  await Promise.all([processor.process(input), processor.process(input)]);
  assert.equal(playCount, 1);
});

test('reconciles uncertain playback before another provider is allowed to start', async () => {
  let secondProviderStarted = false;
  const processor = new ProviderExecutionProcessor({
    loadAuthoritativeRequest: async () => ({
      id: 'request-a',
      workspaceId: 'workspace-a',
      mediaId: 'media-a',
      status: 'approved',
    }),
    getCandidates: async () => [
      { providerInstanceId: 'primary', eligible: true, priority: 1 },
      { providerInstanceId: 'backup', eligible: true, priority: 2 },
    ],
    execute: async (providerId) => {
      if (providerId === 'primary') return { outcome: 'unknown' };
      secondProviderStarted = true;
      return { outcome: 'started' };
    },
    reconcile: async () => ({ status: 'playing', providerPlaybackId: 'playback-existing' }),
    persistExecutionState: async () => undefined,
  });
  const result = await processor.process({ workspaceId: 'workspace-a', requestId: 'request-a' });
  assert.equal(result.status, 'reconciled');
  assert.equal(secondProviderStarted, false);
});
