import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceStatusService } from '../dist/platform-admin/service-status.service.js';

function harness(incidents = [], maintenance = []) {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push(context);
      return operation({
        query: async (sql) => {
          calls.push(sql);
          const rows = sql.includes('list_public_planned_maintenance') ? maintenance : incidents;
          return { rows, rowCount: rows.length };
        },
      });
    },
  };
  return { service: new ServiceStatusService(database), calls };
}

test('public status reports operational with empty incident and maintenance feeds', async () => {
  const { service, calls } = harness();
  assert.deepEqual(await service.publicStatus(), { status: 'operational', incidents: [], maintenance: [] });
  assert.deepEqual(calls, [{}, 'SELECT * FROM list_public_service_incidents()', 'SELECT * FROM list_public_planned_maintenance()']);
});

test('public status derives the highest active incident impact and includes planned maintenance', async () => {
  const incidents = [
    { id: '1', status: 'investigating', impact: 'degraded' },
    { id: '2', status: 'monitoring', impact: 'partial_outage' },
    { id: '3', status: 'resolved', impact: 'major_outage' },
  ];
  const maintenance = [{ id: 'maintenance-1', state: 'scheduled' }];
  const { service } = harness(incidents, maintenance);
  const result = await service.publicStatus();
  assert.equal(result.status, 'partial_outage');
  assert.deepEqual(result.incidents, incidents);
  assert.deepEqual(result.maintenance, maintenance);
});

test('resolved incidents do not keep the current service status degraded', async () => {
  const { service } = harness([{ id: 'resolved', status: 'resolved', impact: 'major_outage' }]);
  assert.equal((await service.publicStatus()).status, 'operational');
});
