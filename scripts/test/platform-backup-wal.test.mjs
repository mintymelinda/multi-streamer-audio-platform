import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const backupScript = fileURLToPath(new URL('../platform-backup.mjs', import.meta.url));
const bucket = 'platform-backups';

async function runArchiveWal(filename, sourcePath, env) {
  const child = spawn(
    process.execPath,
    [backupScript, 'archive-wal', sourcePath, filename],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code, signal] = await once(child, 'close');
  return {
    code,
    signal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

test('WAL archiving retries safely after an upload succeeds but acknowledgement is lost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-wal-retry-test-'));
  const objects = new Map();
  const requests = [];
  const server = createServer(async (request, response) => {
    const prefix = '/' + bucket + '/';
    if (!request.url?.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const key = decodeURIComponent(request.url.slice(prefix.length).split('?')[0]);
    requests.push({ method: request.method, key });
    const stored = objects.get(key);
    if (request.method === 'HEAD') {
      if (!stored) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-length': String(stored.body.length),
        'x-amz-meta-content-sha256': stored.headers['x-amz-meta-content-sha256'],
        'x-amz-meta-plaintext-sha256': stored.headers['x-amz-meta-plaintext-sha256'] ?? '',
        'content-type': stored.headers['content-type'] ?? 'application/octet-stream',
      }).end();
      return;
    }
    if (request.method === 'GET') {
      if (!stored) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-length': String(stored.body.length),
        'x-amz-meta-content-sha256': stored.headers['x-amz-meta-content-sha256'],
        'x-amz-meta-plaintext-sha256': stored.headers['x-amz-meta-plaintext-sha256'] ?? '',
        'content-type': stored.headers['content-type'] ?? 'application/octet-stream',
      }).end(stored.body);
      return;
    }
    if (request.method === 'PUT') {
      if (stored && request.headers['if-none-match'] === '*') {
        response.writeHead(412).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, { body: Buffer.concat(chunks), headers: request.headers });
      response.writeHead(200).end();
      return;
    }
    response.writeHead(405).end();
  });

  try {
    const keyFile = join(directory, 'keyring.json');
    const sourcePath = join(directory, '000000010000000000000001');
    await writeFile(keyFile, JSON.stringify({
      format: 'multi-streamer-audio-platform.backup-keyring',
      version: 1,
      activeKeyId: 'backup-test',
      keys: { 'backup-test': randomBytes(32).toString('hex') },
    }), { mode: 0o600 });
    const walBytes = randomBytes(1024);
    await writeFile(sourcePath, walBytes);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const env = {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      PLATFORM_BACKUP_KEYRING_FILE: keyFile,
      PLATFORM_BACKUP_S3_ENDPOINT: 'http://127.0.0.1:' + address.port,
      PLATFORM_BACKUP_S3_BUCKET: bucket,
      PLATFORM_BACKUP_S3_ACCESS_KEY: 'test-access',
      PLATFORM_BACKUP_S3_SECRET_KEY: 'test-secret',
      PLATFORM_BACKUP_S3_REGION: 'us-east-1',
      PLATFORM_BACKUP_S3_PREFIX: 'v1/platform',
    };

    const first = await runArchiveWal('000000010000000000000001', sourcePath, env);
    assert.equal(first.code, 0, first.stderr);
    const walKey = 'v1/platform/wal/000000010000000000000001.msapbk';
    const firstArchive = objects.get(walKey);
    assert.ok(firstArchive);
    assert.ok([...objects.keys()].some((key) => key.startsWith('v1/platform/status/wal/')));

    const firstPutCount = requests.filter((item) => item.method === 'PUT' && item.key === walKey).length;
    const retry = await runArchiveWal('000000010000000000000001', sourcePath, env);
    assert.equal(retry.code, 0, retry.stderr);
    const retryPutCount = requests.filter((item) => item.method === 'PUT' && item.key === walKey).length;
    assert.equal(retryPutCount, firstPutCount);
    assert.deepEqual(objects.get(walKey).body, firstArchive.body);
    assert.ok(requests.some((item) => item.method === 'GET' && item.key === walKey));

    await writeFile(sourcePath, Buffer.from('different WAL bytes'));
    const collision = await runArchiveWal('000000010000000000000001', sourcePath, env);
    assert.equal(collision.code, 1);
    assert.match(collision.stderr, /different segment content/);
    assert.deepEqual(objects.get(walKey).body, firstArchive.body);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
