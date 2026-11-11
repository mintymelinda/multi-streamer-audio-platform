import assert from 'node:assert/strict';
import test from 'node:test';
import { PlannedMaintenanceService } from '../dist/platform-admin/planned-maintenance.service.js';

function harness(rows = [{ id: 'maintenance-id' }]) {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push(context);
      return operation({
        query: async (sql, values) => {
          calls.push({ sql, values });
          return { rows, rowCount: rows.length };
        },
      });
    },
  };
  return { service: new PlannedMaintenanceService(database), calls };
}

const valid = {
  title: 'Database maintenance',
  summary: 'The database will be upgraded during this window.',
  expectedImpact: 'Dashboard and playback may be unavailable for 20 minutes.',
  affectedServices: ['api', 'dashboard'],
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  endsAt: new Date(Date.now() + 87_000_000).toISOString(),
};

test('publishes a planned maintenance notice through the permission-checked database function', async () => {
  const { service, calls } = harness();
  assert.deepEqual(await service.save('admin-id', valid), { id: 'maintenance-id' });
  assert.deepEqual(calls[0], { userId: 'admin-id' });
  assert.match(calls[1].sql, /set_platform_planned_maintenance/);
  assert.equal(calls[1].values[1], valid.title);
});

test('rejects maintenance windows in the past and invalid end times', async () => {
  const { service } = harness();
  await assert.rejects(service.save('admin-id', { ...valid, startsAt: new Date(Date.now() - 1000).toISOString() }), /future start time/);
  await assert.rejects(service.save('admin-id', { ...valid, endsAt: new Date(Date.now() + 1).toISOString() }), /later than the start time/);
});

test('cancels through the audited database function', async () => {
  const { service, calls } = harness([{ cancel_platform_planned_maintenance: true }]);
  await service.cancel('admin-id', '123e4567-e89b-42d3-a456-426614174000');
  assert.match(calls[1].sql, /cancel_platform_planned_maintenance/);
});
