import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceStatusService } from '../dist/platform-admin/service-status.service.js';

function harness(incidents = []) {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push(context);
      return operation({
        query: async (sql) => {
          calls.push(sql);
          return { rows: incidents, rowCount: incidents.length };
        },
      });
    },
  };
  return { service: new ServiceStatusService(database), calls };
}

test('public status reports operational when there are no incidents', async () => {
  const { service, calls } = harness();
  assert.deepEqual(await service.publicStatus(), { status: 'operational', incidents: [] });
  assert.deepEqual(calls, [{}, 'SELECT * FROM list_public_service_incidents()']);
});

test('public status derives the highest active incident impact', async () => {
  const incidents = [
    { id: '1', status: 'investigating', impact: 'degraded' },
    { id: '2', status: 'monitoring', impact: 'partial_outage' },
    { id: '3', status: 'resolved', impact: 'major_outage' },
  ];
  const { service } = harness(incidents);
  const result = await service.publicStatus();
  assert.equal(result.status, 'partial_outage');
  assert.deepEqual(result.incidents, incidents);
});

test('resolved incidents do not keep the current service status degraded', async () => {
  const { service } = harness([
    { id: 'resolved', status: 'resolved', impact: 'major_outage' },
  ]);
  assert.equal((await service.publicStatus()).status, 'operational');
});
