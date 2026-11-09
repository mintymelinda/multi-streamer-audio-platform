import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderExecutionQueueService } from '../dist/providers/provider-execution-queue.service.js';

test('provider execution jobs reference an existing authoritative PostgreSQL request', async () => {
  const service = new ProviderExecutionQueueService({
    getRequestFromPostgres: async (id) => id === 'request-a' ? { id, status: 'approved', workspaceId: 'workspace-a' } : null,
    enqueueProviderExecution: async (job) => job,
  });
  const job = await service.enqueue({
    workspaceId: 'workspace-a', requestId: 'request-a', providerInstanceId: 'spotify-a',
  });
  assert.equal(job.requestId, 'request-a');
  assert.equal(job.authoritativeRequest.status, 'approved');
});

test('refuses to create provider work when the logical PostgreSQL request is absent or terminal', async () => {
  const service = new ProviderExecutionQueueService({
    getRequestFromPostgres: async () => ({ id: 'request-a', status: 'dismissed', workspaceId: 'workspace-a' }),
    enqueueProviderExecution: async () => { throw new Error('must not enqueue'); },
  });
  await assert.rejects(service.enqueue({
    workspaceId: 'workspace-a', requestId: 'request-a', providerInstanceId: 'youtube-a',
  }));
});

test('provider-specific execution state cannot reorder or mutate the logical request queue', async () => {
  const mutations = [];
  const service = new ProviderExecutionQueueService({
    getRequestFromPostgres: async () => ({ id: 'request-a', status: 'approved', queuePosition: 4 }),
    updateProviderExecutionState: async (state) => mutations.push(state),
  });
  await service.recordExecutionState({
    workspaceId: 'workspace-a', requestId: 'request-a', providerInstanceId: 'youtube-a',
    state: 'retry_wait', attempt: 2,
  });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].state, 'retry_wait');
  assert.equal(mutations[0].queuePosition, undefined);
});

test('rejects provider execution state updates crossing workspace boundaries', async () => {
  const service = new ProviderExecutionQueueService({
    getRequestFromPostgres: async () => ({ id: 'request-a', status: 'approved', workspaceId: 'workspace-b' }),
  });
  await assert.rejects(service.recordExecutionState({
    workspaceId: 'workspace-a', requestId: 'request-a', providerInstanceId: 'spotify-a',
    state: 'queued', attempt: 0,
  }));
});
