import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceOnboardingService } from '../dist/workspaces/workspace-onboarding.service.js';

function createService(initial = {
  checklist: { providers: 'pending', rewards: 'pending', moderation: 'pending', overlay: 'pending' },
  dismissed_at: null,
  completed_at: null,
}) {
  const state = structuredClone(initial);
  const audit = [];
  const database = {
    transaction: async (_context, operation) => operation({
      query: async (sql, values = []) => {
        if (sql.includes('SELECT checklist')) return { rows: [structuredClone(state)], rowCount: 1 };
        if (sql.includes('UPDATE workspace_onboarding SET checklist')) {
          state.checklist[values[1]] = values[2];
          state.dismissed_at = null;
          state.completed_at = Object.values(state.checklist).every((value) => ['completed', 'skipped'].includes(value)) ? new Date() : null;
          return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
        }
        if (sql.includes('UPDATE workspace_onboarding SET dismissed_at')) {
          state.dismissed_at = values[1];
          return { rows: [{ workspace_id: 'workspace-a' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO audit_events')) audit.push({ sql, values });
        return { rows: [], rowCount: 1 };
      },
    }),
  };
  return { service: new WorkspaceOnboardingService(database), state, audit };
}

const workspace = { id: 'workspace-a', role: 'owner' };
const actor = { id: 'user-a' };

test('returns durable onboarding steps and accurate progress for the workspace', async () => {
  const { service } = createService();
  const result = await service.get(workspace, actor);
  assert.equal(result.essentialSetupComplete, true);
  assert.equal(result.progress.total, 4);
  assert.equal(result.progress.completed, 0);
  assert.equal(result.steps[0].key, 'providers');
});

test('persists completion and skip states, and marks onboarding complete only when every step is resolved', async () => {
  const { service, state } = createService();
  await service.updateStep(workspace, actor, 'providers', 'completed');
  assert.equal(state.completed_at, null);
  await service.updateStep(workspace, actor, 'rewards', 'skipped');
  await service.updateStep(workspace, actor, 'moderation', 'completed');
  const result = await service.updateStep(workspace, actor, 'overlay', 'completed');
  assert.equal(result.completed, true);
  assert.equal(result.progress.completed, 3);
  assert.equal(result.progress.skipped, 1);
});

test('rejects unknown steps and invalid states', async () => {
  const { service } = createService();
  await assert.rejects(service.updateStep(workspace, actor, 'billing', 'completed'));
  await assert.rejects(service.updateStep(workspace, actor, 'providers', 'done'));
});

test('dismissal is resumable and every change is audited', async () => {
  const { service, state, audit } = createService();
  const dismissed = await service.setDismissed(workspace, actor, true);
  assert.equal(dismissed.dismissed, true);
  const resumed = await service.setDismissed(workspace, actor, false);
  assert.equal(resumed.dismissed, false);
  assert.equal(state.dismissed_at, null);
  assert.equal(audit.length, 2);
});
