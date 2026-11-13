import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { encryptBackupFile } from '../lib/platform-backup-crypto.mjs';

const backupScript = fileURLToPath(new URL('../platform-backup.mjs', import.meta.url));
const backupPrefix = 'v1/platform';
const backupBucket = 'platform-backups';
const assetsBucket = 'platform-assets';
const restoredBucket = 'platform-restored';

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function objectEtag(body) {
  return createHash('md5').update(body).digest('hex');
}

function createMockS3() {
  const buckets = new Map(
    [backupBucket, assetsBucket, restoredBucket].map((name) => [name, new Map()]),
  );
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathParts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const bucketName = pathParts.shift();
      const key = pathParts.join('/');
      const bucket = buckets.get(bucketName);
      if (!bucket) {
        response.writeHead(404).end();
        return;
      }

      if (request.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const contents = [...bucket.entries()]
          .filter(([objectKey]) => objectKey.startsWith(prefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([objectKey, entry]) =>
            '<Contents><Key>' + xmlEscape(objectKey) + '</Key><Size>' + entry.body.length
            + '</Size><ETag>"' + objectEtag(entry.body) + '"</ETag><LastModified>'
            + entry.lastModified + '</LastModified></Contents>',
          )
          .join('');
        response.writeHead(200, { 'content-type': 'application/xml' })
          .end('<?xml version="1.0"?><ListBucketResult>' + contents
            + '<IsTruncated>false</IsTruncated></ListBucketResult>');
        return;
      }

      const stored = bucket.get(key);
      if (request.method === 'HEAD') {
        if (!stored) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, objectResponseHeaders(stored)).end();
        return;
      }
      if (request.method === 'GET') {
        if (!stored) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, objectResponseHeaders(stored)).end(stored.body);
        return;
      }
      if (request.method === 'PUT') {
        if (stored && request.headers['if-none-match'] === '*') {
          response.writeHead(412).end();
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const metadata = Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => name.startsWith('x-amz-meta-')),
        );
        bucket.set(key, {
          body,
          contentType: request.headers['content-type'] ?? 'application/octet-stream',
          metadata,
          lastModified: new Date().toISOString(),
        });
        response.writeHead(200).end();
        return;
      }
      response.writeHead(405).end();
    } catch {
      response.writeHead(500).end();
    }
  });

  function objectResponseHeaders(entry) {
    return {
      'content-length': String(entry.body.length),
      'content-type': entry.contentType,
      etag: '"' + objectEtag(entry.body) + '"',
      'last-modified': entry.lastModified,
      ...entry.metadata,
    };
  }

  return {
    buckets,
    put(bucketName, key, body, contentType = 'application/octet-stream') {
      const bucket = buckets.get(bucketName);
      assert.ok(bucket, 'mock S3 bucket must exist');
      const value = Buffer.isBuffer(body) ? body : Buffer.from(body);
      bucket.set(key, {
        body: value,
        contentType,
        metadata: {},
        lastModified: new Date().toISOString(),
      });
    },
    async listen() {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      return 'http://127.0.0.1:' + address.port;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [backupScript, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function writeKeyRing(path, key) {
  await writeFile(path, JSON.stringify({
    format: 'multi-streamer-audio-platform.backup-keyring',
    version: 1,
    activeKeyId: 'backup-test',
    keys: { 'backup-test': key.toString('hex') },
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}

function backupEnvironment(endpoint, keyFile, pathValue = process.env.PATH ?? '') {
  return {
    PATH: pathValue,
    NODE_ENV: 'test',
    PLATFORM_BACKUP_KEYRING_FILE: keyFile,
    PLATFORM_BACKUP_S3_ENDPOINT: endpoint,
    PLATFORM_BACKUP_S3_BUCKET: backupBucket,
    PLATFORM_BACKUP_S3_ACCESS_KEY: 'backup-access',
    PLATFORM_BACKUP_S3_SECRET_KEY: 'backup-secret',
    PLATFORM_BACKUP_S3_PREFIX: backupPrefix,
    OBJECT_STORAGE_ENDPOINT: endpoint,
    OBJECT_STORAGE_BUCKET: assetsBucket,
    OBJECT_STORAGE_BACKUP_READ_ACCESS_KEY: 'assets-read-access',
    OBJECT_STORAGE_BACKUP_READ_SECRET_KEY: 'assets-read-secret',
    OBJECT_STORAGE_RESTORE_ACCESS_KEY: 'restore-write-access',
    OBJECT_STORAGE_RESTORE_SECRET_KEY: 'restore-write-secret',
  };
}

async function withTemporaryDirectory(action) {
  const directory = await mkdtemp(join(tmpdir(), 'platform-backup-restore-test-'));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('restores object snapshots using a key ring recovered from a separate path', async () => {
  await withTemporaryDirectory(async (directory) => {
    const mock = createMockS3();
    const endpoint = await mock.listen();
    try {
      const keyFile = join(directory, 'primary-keyring.json');
      const recoveredKeyFile = join(directory, 'independent-recovery', 'keyring.json');
      const key = randomBytes(32);
      await writeKeyRing(keyFile, key);
      await mkdir(join(directory, 'independent-recovery'), { recursive: true });
      mock.put(assetsBucket, 'artwork/cover & alt.png', Buffer.from('image bytes \u0000 \u0001'), 'image/png');
      mock.put(assetsBucket, 'scenes/now-playing.json', Buffer.from('{"component":"now-playing"}'), 'application/json');

      const env = backupEnvironment(endpoint, keyFile);
      const backup = await runCli(['backup-objects'], env);
      assert.equal(backup.code, 0, backup.stderr);
      const snapshotId = JSON.parse(backup.stdout).snapshotId;
      assert.match(snapshotId, /^[0-9a-f-]{36}$/i);

      await copyFile(keyFile, recoveredKeyFile);
      await chmod(recoveredKeyFile, 0o600);
      await rm(keyFile);

      const restore = await runCli(
        ['restore-objects', snapshotId, restoredBucket],
        { ...env, PLATFORM_BACKUP_KEYRING_FILE: recoveredKeyFile },
      );
      assert.equal(restore.code, 0, restore.stderr);
      assert.equal(JSON.parse(restore.stdout).objectCount, 2);

      const assets = mock.buckets.get(assetsBucket);
      const restored = mock.buckets.get(restoredBucket);
      for (const keyName of assets.keys()) {
        assert.deepEqual(restored.get(keyName)?.body, assets.get(keyName).body);
        assert.equal(restored.get(keyName)?.contentType, assets.get(keyName).contentType);
      }
    } finally {
      await mock.close();
    }
  });
});

test('rejects a tampered object archive before publishing plaintext to the restore bucket', async () => {
  await withTemporaryDirectory(async (directory) => {
    const mock = createMockS3();
    const endpoint = await mock.listen();
    try {
      const keyFile = join(directory, 'keyring.json');
      await writeKeyRing(keyFile, randomBytes(32));
      mock.put(assetsBucket, 'artwork/only.png', Buffer.from('must remain authenticated'), 'image/png');
      const env = backupEnvironment(endpoint, keyFile);
      const backup = await runCli(['backup-objects'], env);
      assert.equal(backup.code, 0, backup.stderr);
      const snapshotId = JSON.parse(backup.stdout).snapshotId;
      const objectPrefix = backupPrefix + '/objects/' + snapshotId + '/data/';
      const [archiveKey, archive] = [...mock.buckets.get(backupBucket).entries()]
        .find(([key]) => key.startsWith(objectPrefix));
      assert.ok(archiveKey);
      archive.body[archive.body.length - 1] ^= 0x01;

      const restore = await runCli(
        ['restore-objects', snapshotId, restoredBucket],
        env,
      );
      assert.equal(restore.code, 1);
      assert.match(restore.stderr, /authenticate|decrypt|unsupported|tag/i);
      assert.equal(mock.buckets.get(restoredBucket).size, 0);
    } finally {
      await mock.close();
    }
  });
});

test('restores and validates a PostgreSQL base archive before generating PITR configuration', async () => {
  await withTemporaryDirectory(async (directory) => {
    const mock = createMockS3();
    const endpoint = await mock.listen();
    try {
      const keyFile = join(directory, 'keyring.json');
      const key = randomBytes(32);
      await writeKeyRing(keyFile, key);
      const backupId = '2b9a16f7-5bb1-4a7f-9a6c-202611130001';
      const sourceDirectory = join(directory, 'postgres-source');
      await mkdir(sourceDirectory);
      await writeFile(join(sourceDirectory, 'PG_VERSION'), '18\n');
      await writeFile(join(sourceDirectory, 'backup_manifest'), '{"manifest-version":1}\n');
      await writeFile(join(sourceDirectory, 'fixture.txt'), 'postgres restore fixture\n');
      const archivePath = join(directory, 'postgres-base.tar.gz');
      const tar = spawnSync('tar', [
        '--create',
        '--gzip',
        '--file=' + archivePath,
        '--directory=' + sourceDirectory,
        '.',
      ], { encoding: 'utf8' });
      assert.equal(tar.status, 0, tar.stderr || tar.error?.message);
      const encryptedPath = archivePath + '.msapbk';
      const encrypted = await encryptBackupFile({
        sourcePath: archivePath,
        destinationPath: encryptedPath,
        key,
        keyId: 'backup-test',
        context: 'postgres:' + backupId,
      });
      const archiveKey = backupPrefix + '/postgres/' + backupId + '/base.tar.gz.msapbk';
      const manifestKey = backupPrefix + '/postgres/' + backupId + '/manifest.json';
      mock.put(backupBucket, archiveKey, await readFile(encryptedPath));
      mock.put(
        backupBucket,
        manifestKey,
        Buffer.from(JSON.stringify({
          format: 'multi-streamer-audio-platform.postgres-backup',
          version: 1,
          backupId,
          createdAt: new Date().toISOString(),
          pgBaseBackupVersion: 'pg_basebackup (PostgreSQL) 18',
          keyId: 'backup-test',
          walMethod: 'stream',
          manifestChecksums: 'SHA256',
          archive: archiveKey,
          archiveSha256: encrypted.sha256,
          plaintextBytes: encrypted.plaintextBytes,
        })),
        'application/json',
      );

      const binDirectory = join(directory, 'bin');
      await mkdir(binDirectory);
      const verifier = join(binDirectory, 'pg_verifybackup');
      await writeFile(
        verifier,
        '#!/bin/sh\n'
          + 'test -f "$1/PG_VERSION" && test -f "$1/backup_manifest"\n',
        { mode: 0o700 },
      );
      await chmod(verifier, 0o700);
      const targetDirectory = join(directory, 'recovered-postgres');
      const targetTime = '2026-11-13T15:00:00Z';
      const env = backupEnvironment(endpoint, keyFile, binDirectory + delimiter + (process.env.PATH ?? ''));
      const restore = await runCli(
        ['restore-postgres', backupId, targetDirectory, targetTime],
        env,
      );
      assert.equal(restore.code, 0, restore.stderr);
      assert.deepEqual(await readFile(join(targetDirectory, 'PG_VERSION')), Buffer.from('18\n'));
      assert.equal(await readFile(join(targetDirectory, 'fixture.txt'), 'utf8'), 'postgres restore fixture\n');
      assert.equal(await readFile(join(targetDirectory, 'recovery.signal'), 'utf8'), '');
      const recoveryConfig = await readFile(join(targetDirectory, 'postgresql.auto.conf'), 'utf8');
      assert.match(recoveryConfig, /restore-wal "%f" "%p"/);
      assert.match(recoveryConfig, /recovery_target_time = '2026-11-13T15:00:00.000Z'/);
      assert.match(recoveryConfig, /recovery_target_action = 'promote'/);
      assert.equal(JSON.parse(restore.stdout).status, 'verified');
    } finally {
      await mock.close();
    }
  });
});
