import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { LyrionOutputConfigurationController } from '../dist/providers/lyrion-output-configuration.controller.js';

const request = {
  user: { id: '10000000-0000-4000-8000-000000000001' },
  workspace: { id: '20000000-0000-4000-8000-000000000002', role: 'owner', status: 'active' },
};

test('configures a workspace-scoped Lyrion output and stores no credentials by default', async () => {
  const queries = [];
  const database = {
    transaction: async (_context, action) => action({
      query: async (sql, values) => {
        queries.push({ sql, values });
        if (sql.includes('INSERT INTO provider_instances')) return { rows: [{ id: 'lyrion-instance-id' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    }),
  };
  const credentials = {
    getCredentials: async () => null,
    connect: async () => { throw new Error('unexpected credential connection'); },
    disconnect: async () => { throw new Error('unexpected credential disconnect'); },
  };
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFetch = globalThis.fetch;
  const previousInvidiousUrl = process.env.INVIDIOUS_INSTANCE_URL;
  process.env.NODE_ENV = 'test';
  process.env.INVIDIOUS_INSTANCE_URL = 'http://localhost:8080';
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 1, result: { _mode: 'stop' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const controller = new LyrionOutputConfigurationController(database, credentials, {});
    const result = await controller.configure(request, {
      instanceKey: 'living-room',
      baseUrl: 'http://localhost:9000',
      outputId: 'living-room-output',
      playerId: '00:11:22:33:44:55',
    });
    assert.deepEqual(result, {
      providerInstanceId: 'lyrion-instance-id',
      providerId: 'lyrion',
      outputId: 'living-room-output',
      playerId: '00:11:22:33:44:55',
      connectionHealth: 'healthy',
      credentialsStored: false,
    });
    assert.equal(queries.length, 4);
    assert.equal(queries[2].values[1], JSON.stringify({ baseUrl: 'http://localhost:9000' }));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousInvidiousUrl === undefined) delete process.env.INVIDIOUS_INSTANCE_URL;
    else process.env.INVIDIOUS_INSTANCE_URL = previousInvidiousUrl;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('rejects a production Lyrion endpoint that is not operator allowlisted', async () => {
  const database = { transaction: async () => { throw new Error('database must not be reached'); } };
  const credentials = {};
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAllowlist = process.env.LYRION_ALLOWED_HOSTS;
  process.env.NODE_ENV = 'production';
  delete process.env.LYRION_ALLOWED_HOSTS;
  try {
    const controller = new LyrionOutputConfigurationController(database, credentials, {});
    await assert.rejects(
      controller.configure(request, {
        instanceKey: 'living-room',
        baseUrl: 'https://unapproved.example.test',
        outputId: 'living-room-output',
        playerId: 'player-a',
      }),
      (error) => error instanceof BadRequestException,
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAllowlist === undefined) delete process.env.LYRION_ALLOWED_HOSTS;
    else process.env.LYRION_ALLOWED_HOSTS = previousAllowlist;
  }
});
