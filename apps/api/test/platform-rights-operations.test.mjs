import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformAdminService } from '../dist/platform-admin/platform-admin.service.js';

function harness(rows = []) {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push({ context });
      return operation({
        query: async (sql, values = []) => {
          calls.push({ sql, values });
          return { rows, rowCount: rows.length };
        },
      });
    },
  };
  return { service: new PlatformAdminService(database), calls };
}
const reportId = '123e4567-e89b-42d3-a456-426614174000';
const workspaceId = '123e4567-e89b-42d3-a456-426614174001';
const reviewerId = '123e4567-e89b-42d3-a456-426614174002';
const reason = 'Documented evidence review and rights determination';

test('global rights report listing uses the permission-gated database function', async () => {
  const report = { id: reportId, status: 'received' };
  const { service, calls } = harness([report]);
  assert.deepEqual(await service.listRightsReports('rights-admin', 'received', 'spotify'), [report]);
  assert.deepEqual(calls[0].context, { userId: 'rights-admin' });
  assert.match(calls[1].sql, /list_platform_rights_reports/);
  assert.deepEqual(calls[1].values, ['received', 'spotify']);
});

test('rights report event history is read through its scoped operator function', async () => {
  const { service, calls } = harness([{ id: 'event-1' }]);
  assert.deepEqual(await service.listRightsReportEvents('rights-admin', reportId), [{ id: 'event-1' }]);
  assert.match(calls[1].sql, /get_platform_rights_report_events/);
  assert.deepEqual(calls[1].values, [reportId]);
});

test('reviewer assignment and case transitions require documented reasons', async () => {
  const { service, calls } = harness();
  await service.assignRightsReport('rights-admin', reportId, reviewerId, reason);
  await service.transitionRightsReport('rights-admin', reportId, 'investigating', reason);
  await service.transitionRightsReport('rights-admin', reportId, 'decision_pending', reason);
  assert.deepEqual(calls.filter((call) => call.sql).map((call) => call.values), [
    [reportId, reviewerId, reason],
    [reportId, 'investigating', reason],
    [reportId, 'decision_pending', reason],
  ]);
});

test('decisions validate outcome and explicit evidence-preservation choice', async () => {
  const { service, calls } = harness();
  await service.decideRightsReport('rights-admin', reportId, 'takedown', reason, true);
  assert.deepEqual(calls[1].values, [reportId, 'takedown', reason, true]);
  await assert.rejects(service.decideRightsReport('rights-admin', reportId, 'remove', reason, true), /decision is invalid/);
  await assert.rejects(service.decideRightsReport('rights-admin', reportId, 'no_action', reason, 'yes'), /Evidence preservation choice/);
});

test('provider restrictions and repeat-infringer actions use dedicated database functions', async () => {
  const { service, calls } = harness([{ threshold_reached: true }]);
  await service.disableRightsProviderPath('rights-admin', workspaceId, 'Spotify', reason);
  await service.repeatInfringerSummary('rights-admin', workspaceId);
  await service.restrictRepeatInfringerWorkspace('rights-admin', workspaceId, reason);
  const queries = calls.filter((call) => call.sql);
  assert.deepEqual(queries.map((call) => call.values), [
    [workspaceId, 'spotify', reason],
    [workspaceId],
    [workspaceId, reason],
  ]);
  assert.match(queries[1].sql, /get_platform_repeat_infringer_summary/);
  assert.match(queries[2].sql, /restrict_platform_repeat_infringer_workspace/);
});

test('invalid rights operation inputs are rejected before opening a transaction', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.listRightsReportEvents('admin', 'not-a-uuid'), /valid rights report ID/);
  await assert.rejects(service.assignRightsReport('admin', reportId, 'bad-reviewer', reason), /valid reviewer ID/);
  await assert.rejects(service.transitionRightsReport('admin', reportId, 'closed', reason), /status is invalid/);
  await assert.rejects(service.disableRightsProviderPath('admin', workspaceId, 'bad provider', reason), /provider identifier/);
  await assert.rejects(service.restrictRepeatInfringerWorkspace('admin', workspaceId, 'short'), /documented reason/);
  assert.equal(calls.length, 0);
});
