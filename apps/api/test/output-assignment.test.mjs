import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderOutputAssignmentService } from '../dist/providers/provider-output-assignment.service.js';

test('requires an explicit workspace/provider/player output assignment', async () => {
  const service = new ProviderOutputAssignmentService({
    findAssignment: async () => null,
  });
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
  let approvalRecorded = false;
  const service = new ProviderOutputAssignmentService({
    findConflicts: async () => [
      { providerInstanceId: 'youtube-a', playerId: 'player-a', outputId: 'output-a' },
    ],
    verifyConcurrencyApproval: async (approval) =>
      approval?.approvedBy === 'owner-a' && approval?.capability === 'concurrentOutput',
    recordConcurrencyApprovalUse: async () => {
      approvalRecorded = true;
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
  assert.equal(approvalRecorded, true);
});
