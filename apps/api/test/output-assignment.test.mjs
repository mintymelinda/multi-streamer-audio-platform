import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderOutputAssignmentService } from '../dist/providers/provider-output-assignment.service.js';

test('requires an explicit workspace/provider/player output assignment', async () => {
  const service = new ProviderOutputAssignmentService({ findAssignment: async () => null });
  await assert.rejects(
    service.requireAssignment({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      playerId: 'player-a',
    }),
    (error) => error.code === 'OUTPUT_NOT_ASSIGNED',
  );
});

test('prevents two providers from owning the same output concurrently', async () => {
  const service = new ProviderOutputAssignmentService({
    findConflicts: async () => [
      { providerInstanceId: 'youtube-a', playerId: 'player-a', outputId: 'output-a' },
    ],
  });
  await assert.rejects(
    service.assign({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      playerId: 'player-a',
      outputId: 'output-a',
      actorId: 'user-a',
    }),
    (error) => error.code === 'OUTPUT_ALREADY_ASSIGNED',
  );
});

test('does not permit competing streams merely because adapters support playback', async () => {
  const service = new ProviderOutputAssignmentService({
    findConflicts: async () => [
      { providerInstanceId: 'youtube-a', playerId: 'player-a', outputId: 'output-a' },
    ],
  });
  await assert.rejects(
    service.assertCanStartPlayback({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      playerId: 'player-a',
      outputId: 'output-a',
      capabilities: { playback: true, concurrentOutput: true },
      concurrencyApproval: null,
    }),
  );
});

test('permits concurrent output only with an explicit, audited future capability approval', async () => {
  let recorded = false;
  const service = new ProviderOutputAssignmentService({
    findConflicts: async () => [
      { providerInstanceId: 'youtube-a', playerId: 'player-a', outputId: 'output-a' },
    ],
    verifyConcurrencyApproval: async (approval) =>
      approval?.approvedBy === 'owner-a' && approval?.capability === 'concurrentOutput',
    recordConcurrencyApprovalUse: async () => {
      recorded = true;
    },
  });
  await service.assertCanStartPlayback({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    outputId: 'output-a',
    capabilities: { playback: true, concurrentOutput: true },
    concurrencyApproval: {
      approvedBy: 'owner-a',
      capability: 'concurrentOutput',
      approvalId: 'approval-a',
    },
  });
  assert.equal(recorded, true);
});

test('persists validated assignments and releases them', async () => {
  let saved;
  let released = false;
  const service = new ProviderOutputAssignmentService({
    findConflicts: async () => [],
    saveAssignment: async (assignment) => {
      saved = assignment;
      return { id: 'assignment-a', ...assignment };
    },
    releaseAssignment: async () => {
      released = true;
      return true;
    },
  });
  const result = await service.assign({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    outputId: 'main-output',
    playerId: 'player-a',
    actorId: 'owner-a',
  });
  assert.equal(result.outputId, 'main-output');
  assert.equal(saved.actorId, 'owner-a');
  assert.equal(
    await service.release({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      actorId: 'owner-a',
    }),
    true,
  );
  assert.equal(released, true);
});

test('rejects playback when the persisted assignment does not match the requested output', async () => {
  const service = new ProviderOutputAssignmentService({
    findAssignment: async () => ({
      id: 'a',
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      outputId: 'other-output',
      playerId: 'player-a',
      assignedBy: 'owner-a',
    }),
    findConflicts: async () => [],
  });
  await assert.rejects(
    service.assertCanStartPlayback({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      playerId: 'player-a',
      outputId: 'main-output',
      capabilities: { playback: true },
      concurrencyApproval: null,
    }),
    (error) => error.code === 'OUTPUT_NOT_ASSIGNED',
  );
});

test('does not accept an unverified concurrency approval', async () => {
  const service = new ProviderOutputAssignmentService({
    findConflicts: async () => [
      { providerInstanceId: 'youtube-a', playerId: 'player-a', outputId: 'main-output' },
    ],
    verifyConcurrencyApproval: async () => false,
  });
  await assert.rejects(
    service.assertCanStartPlayback({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      playerId: 'player-a',
      outputId: 'main-output',
      capabilities: { playback: true, concurrentOutput: true },
      concurrencyApproval: {
        approvedBy: 'owner-a',
        capability: 'concurrentOutput',
        approvalId: 'invalid',
      },
    }),
    (error) => error.code === 'CONCURRENT_OUTPUT_NOT_APPROVED',
  );
});
