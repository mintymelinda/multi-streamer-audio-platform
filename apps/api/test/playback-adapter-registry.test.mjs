import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackAdapterRegistry } from '../dist/providers/playback-adapter.registry.js';

const input = {
  workspaceId: 'workspace-a',
  providerInstanceId: 'lyrion-a',
  playerId: 'player-a',
  outputId: 'output-a',
  requestId: 'request-a',
  command: 'play',
  idempotencyKey: 'command-a',
  actorId: 'actor-a',
};

test('resolves an output adapter by normalized output provider identity', async () => {
  const registry = new PlaybackAdapterRegistry();
  const adapter = { play: async () => ({ outcome: 'started' }) };
  registry.register('Lyrion', () => adapter);
  assert.equal(registry.has('lyrion'), true);
  assert.equal(await registry.resolve('LYRION', input), adapter);
});

test('does not silently fall back when an output adapter is missing', async () => {
  const registry = new PlaybackAdapterRegistry();
  await assert.rejects(
    registry.resolve('youtube', input),
    (error) => error.code === 'PROVIDER_OUTPUT_NOT_CONFIGURED',
  );
});

test('rejects duplicate and malformed output provider registrations', () => {
  const registry = new PlaybackAdapterRegistry();
  registry.register('lyrion', () => ({ play: async () => ({ outcome: 'started' }) }));
  assert.throws(
    () => registry.register('LYRION', () => ({ play: async () => ({ outcome: 'started' }) })),
    /already registered/,
  );
  assert.throws(() => registry.register('../lyrion', () => ({})), /provider ID is invalid/);
});
