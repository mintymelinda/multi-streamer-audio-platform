import assert from 'node:assert/strict';
import test from 'node:test';
import { HealthController } from '../dist/health.controller.js';

function replyRecorder() {
  return {
    statusCode: undefined,
    code(value) {
      this.statusCode = value;
      return this;
    },
  };
}

test('liveness does not depend on database availability', () => {
  const controller = new HealthController({
    queryInfrastructure: async () => {
      throw new Error('database should not be queried by liveness');
    },
  });
  assert.equal(controller.getLiveness().status, 'ok');
});

test('readiness returns 200 when PostgreSQL responds to a lightweight probe', async () => {
  let query;
  const controller = new HealthController({
    queryInfrastructure: async (sql) => {
      query = sql;
      return { rows: [{ '?column?': 1 }] };
    },
  });
  const reply = replyRecorder();
  const result = await controller.getReadiness(reply);
  assert.equal(query, 'SELECT 1');
  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.dependencies, { postgres: 'ready' });
});

test('readiness returns 503 without exposing dependency error details', async () => {
  const controller = new HealthController({
    queryInfrastructure: async () => {
      throw new Error('private database host and credentials must not leak');
    },
  });
  const reply = replyRecorder();
  const result = await controller.getReadiness(reply);
  assert.equal(reply.statusCode, 503);
  assert.equal(result.status, 'not_ready');
  assert.deepEqual(result.dependencies, { postgres: 'unavailable' });
  assert.equal(JSON.stringify(result).includes('private database'), false);
});
