import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('../load/http-workload.mjs', import.meta.url));

async function withServer(handler, action) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await action('http://127.0.0.1:' + address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runWorkload(baseUrl, directory, scenarios, extraArgs = [], scenarioFileOverride) {
  const scenarioFile = scenarioFileOverride ?? join(directory, 'scenarios.json');
  if (!scenarioFileOverride) {
    await writeFile(scenarioFile, JSON.stringify({ scenarios }), { mode: 0o600 });
  }
  const child = spawn(process.execPath, [
    runner,
    '--base-url',
    baseUrl,
    '--scenario-file',
    scenarioFile,
    '--duration-seconds',
    '1',
    '--concurrency',
    '3',
    '--timeout-ms',
    '1000',
    '--max-error-rate',
    '0',
    '--max-p95-ms',
    '3000',
    '--i-confirm-non-production',
    ...extraArgs,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  return {
    code,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

test('load runner exercises authenticated read/write scenarios without disclosing scenario headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-load-test-'));
  const requests = [];
  try {
    await withServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    }, async (baseUrl) => {
      const result = await runWorkload(baseUrl, directory, [
        {
          name: 'health',
          method: 'GET',
          path: '/health/ready',
          weight: 1,
        },
        {
          name: 'write',
          method: 'POST',
          path: '/workspaces/test/requests',
          headers: {
            Authorization: 'Bearer local-load-secret',
            'Content-Type': 'application/json',
          },
          body: '{"idempotencyKey":"load-{{runId}}-{{sequence}}","id":"{{uuid}}"}',
          weight: 1,
        },
      ]);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.ok(report.totalRequests > 0);
      assert.equal(report.failed, 0);
      assert.equal(report.passed, true);
      assert.ok(report.scenarios.health.total > 0);
      assert.ok(report.scenarios.write.total > 0);
      assert.ok(requests.some((item) => item.method === 'POST' && item.body.includes('load-')));
      assert.ok(requests.every((item) => item.authorization === undefined || item.authorization === 'Bearer local-load-secret'));
      assert.equal(result.stdout.includes('local-load-secret'), false);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load runner exits non-zero when a scenario exceeds the configured error budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-load-failure-test-'));
  try {
    await withServer((_request, response) => {
      response.writeHead(503).end();
    }, async (baseUrl) => {
      const result = await runWorkload(baseUrl, directory, [
        { name: 'unavailable', method: 'GET', path: '/health/ready', weight: 1 },
      ]);
      assert.equal(result.code, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.failed, report.totalRequests);
      assert.equal(report.passed, false);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load runner rejects duplicate scenario identities and credential-bearing target URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-load-validation-test-'));
  try {
    await withServer((_request, response) => {
      response.writeHead(200).end();
    }, async (baseUrl) => {
      const duplicate = await runWorkload(baseUrl, directory, [
        { name: 'same', method: 'GET', path: '/one', weight: 1 },
        { name: 'same', method: 'GET', path: '/two', weight: 1 },
      ]);
      assert.equal(duplicate.code, 1);
      assert.match(duplicate.stderr, /invalid or duplicate name/);

      const credentialTarget = baseUrl.replace('http://', 'http://user:secret@');
      const credentialUrl = await runWorkload(credentialTarget, directory, [
        { name: 'health', method: 'GET', path: '/health/ready', weight: 1 },
      ]);
      assert.equal(credentialUrl.code, 1);
      assert.match(credentialUrl.stderr, /cannot contain credentials/);
      assert.equal(credentialUrl.stderr.includes('secret'), false);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load runner refuses symlinked and multiply-linked scenario files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-load-file-safety-test-'));
  try {
    await withServer((_request, response) => {
      response.writeHead(200).end();
    }, async (baseUrl) => {
      const scenarioContents = JSON.stringify({
        scenarios: [{ name: 'health', method: 'GET', path: '/health/ready', weight: 1 }],
      });
      const target = join(directory, 'private-scenarios.json');
      const symlinkPath = join(directory, 'scenarios-symlink.json');
      const hardlinkPath = join(directory, 'scenarios-hardlink.json');
      await writeFile(target, scenarioContents, { mode: 0o600 });
      await symlink(target, symlinkPath);

      const symlinkResult = await runWorkload(baseUrl, directory, [], [], symlinkPath);
      assert.equal(symlinkResult.code, 1);
      assert.match(symlinkResult.stderr, /must not be a symbolic link/);

      await link(target, hardlinkPath);
      const hardlinkResult = await runWorkload(baseUrl, directory, [], [], hardlinkPath);
      assert.equal(hardlinkResult.code, 1);
      assert.match(hardlinkResult.stderr, /no hard links/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
