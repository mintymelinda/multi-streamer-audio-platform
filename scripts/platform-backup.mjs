#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decryptBackupFile,
  encryptBackupFile,
  loadBackupKeyRing,
} from './lib/platform-backup-crypto.mjs';
import { createPlatformBackupS3Client } from './lib/platform-backup-s3.mjs';

const [command, ...args] = process.argv.slice(2);
const scriptPath = fileURLToPath(import.meta.url);
const walFilenamePattern = /^(?:[0-9a-f]{24}|[0-9a-f]{8}\.history)$/i;
const backupIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(name + ' is required.');
  }
  return value.trim();
}

function safePrefix(value) {
  const prefix = value || 'v1/platform';
  if (
    prefix.startsWith('/') ||
    prefix.endsWith('/') ||
    prefix.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('PLATFORM_BACKUP_S3_PREFIX must be a safe relative object-key prefix.');
  }
  return prefix;
}

async function loadKeys() {
  return loadBackupKeyRing({
    keyFile: requiredEnv('PLATFORM_BACKUP_KEYRING_FILE'),
  });
}

function createBackupClient() {
  return createPlatformBackupS3Client({
    endpoint: requiredEnv('PLATFORM_BACKUP_S3_ENDPOINT'),
    bucket: requiredEnv('PLATFORM_BACKUP_S3_BUCKET'),
    accessKey: requiredEnv('PLATFORM_BACKUP_S3_ACCESS_KEY'),
    secretKey: requiredEnv('PLATFORM_BACKUP_S3_SECRET_KEY'),
    region: process.env.PLATFORM_BACKUP_S3_REGION || 'us-east-1',
    allowInsecureHttp: process.env.PLATFORM_BACKUP_S3_ALLOW_INSECURE_HTTP === 'true',
  });
}

function createObjectStorageClient(bucket) {
  return createPlatformBackupS3Client({
    endpoint: process.env.OBJECT_STORAGE_INTERNAL_ENDPOINT
      || requiredEnv('OBJECT_STORAGE_ENDPOINT'),
    bucket: bucket || requiredEnv('OBJECT_STORAGE_BUCKET'),
    accessKey: requiredEnv('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: requiredEnv('OBJECT_STORAGE_SECRET_KEY'),
    region: process.env.OBJECT_STORAGE_REGION || 'us-east-1',
    allowInsecureHttp: process.env.OBJECT_STORAGE_ALLOW_INSECURE_HTTP === 'true',
  });
}

function backupKey(prefix, key) {
  return prefix + '/' + key;
}

function ensureBackupId(value) {
  if (!backupIdPattern.test(value ?? '')) throw new Error('Backup ID must be a UUID.');
  return value.toLowerCase();
}

async function runCommand(binary, commandArgs, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, commandArgs, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.on('error', () => reject(new Error(binary + ' could not be started.')));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(binary + ' failed with exit code ' + code + '.'));
      else resolvePromise(Buffer.concat(output).toString('utf8').trim());
    });
  });
}

async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function uploadStatus(client, prefix, name, status) {
  const objectKey = backupKey(prefix, 'status/' + name + '/latest.json');
  await client.putObject(objectKey, Buffer.from(JSON.stringify(status)), {
    immutable: false,
    contentType: 'application/json',
  });
}

async function readStatus(client, prefix, name, maximumAgeSeconds, nowMs) {
  const objectKey = backupKey(prefix, 'status/' + name + '/latest.json');
  let status;
  try {
    status = JSON.parse((await client.getObject(objectKey)).toString('utf8'));
  } catch {
    throw new Error('No valid successful ' + name + ' backup status marker exists.');
  }
  const completedAt = Date.parse(status.completedAt);
  const ageSeconds = (nowMs - completedAt) / 1000;
  if (!Number.isFinite(completedAt) || ageSeconds < -60 || ageSeconds > maximumAgeSeconds) {
    throw new Error('The latest ' + name + ' backup is outside its freshness objective.');
  }
  return { name, completedAt: new Date(completedAt).toISOString(), ageSeconds, backupId: status.backupId };
}

function databaseEnvironment() {
  const connectionString = requiredEnv('PLATFORM_BACKUP_DATABASE_URL');
  const connection = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)) {
    throw new Error('PLATFORM_BACKUP_DATABASE_URL must be a PostgreSQL connection URL.');
  }
  if (!process.env.PGPASSFILE && !process.env.PGPASSWORD) {
    throw new Error('Set PGPASSFILE to a protected backup-user password file; passwords are not read from the URL.');
  }
  if (process.env.PGPASSFILE) {
    return stat(process.env.PGPASSFILE).then((details) => {
      if ((details.mode & 0o077) !== 0) {
        throw new Error('PGPASSFILE permissions must be 0600 or stricter.');
      }
      return {
        ...process.env,
        PGHOST: connection.hostname,
        PGPORT: connection.port || '5432',
        PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
        PGUSER: decodeURIComponent(connection.username),
        PGSSLMODE: connection.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer',
      };
    });
  }
  return Promise.resolve({
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port || '5432',
    PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
    PGUSER: decodeURIComponent(connection.username),
    PGSSLMODE: connection.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer',
  });
}

async function backupPostgres() {
  const keys = await loadKeys();
  const client = createBackupClient();
  const prefix = safePrefix(process.env.PLATFORM_BACKUP_S3_PREFIX);
  const backupId = randomUUID();
  const createdAt = new Date().toISOString();
  const directory = await temporaryDirectory('platform-pg-backup-');
  try {
    const dataDirectory = join(directory, 'data');
    const archivePath = join(directory, 'postgres-base.tar.gz');
    const encryptedPath = archivePath + '.msapbk';
    await mkdir(dataDirectory, { mode: 0o700 });
    const pgEnv = await databaseEnvironment();
    const version = await runCommand('pg_basebackup', ['--version'], { env: pgEnv });
    await runCommand('pg_basebackup', [
      '--format=plain',
      '--wal-method=stream',
      '--manifest-checksums=SHA256',
      '--checkpoint=fast',
      '--no-password',
      '--pgdata=' + dataDirectory,
    ], { env: pgEnv });

    const tablespaceDirectory = join(dataDirectory, 'pg_tblspc');
    try {
      const tablespaces = await readdir(tablespaceDirectory);
      if (tablespaces.length > 0) {
        throw new Error('PostgreSQL tablespaces require explicit mapping before this backup runner can archive them safely.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await runCommand('tar', [
      '--create',
      '--gzip',
      '--file=' + archivePath,
      '--directory=' + dataDirectory,
      '.',
    ]);
    const encrypted = await encryptBackupFile({
      sourcePath: archivePath,
      destinationPath: encryptedPath,
      key: keys.activeKey,
      keyId: keys.activeKeyId,
      context: 'postgres:' + backupId,
    });
    const objectKey = backupKey(prefix, 'postgres/' + backupId + '/base.tar.gz.msapbk');
    await client.putFile(objectKey, encryptedPath, {
      metadata: {
        'x-amz-meta-plaintext-sha256': encrypted.sha256,
        'x-amz-meta-key-id': keys.activeKeyId,
        'x-amz-meta-backup-id': backupId,
      },
    });
    const manifest = {
      format: 'multi-streamer-audio-platform.postgres-backup',
      version: 1,
      backupId,
      createdAt,
      pgBaseBackupVersion: version,
      format: 'multi-streamer-audio-platform.postgres-backup',
      keyId: keys.activeKeyId,
      walMethod: 'stream',
      manifestChecksums: 'SHA256',
      archive: objectKey,
      archiveSha256: encrypted.sha256,
      plaintextBytes: encrypted.plaintextBytes,
    };
    const manifestKey = backupKey(prefix, 'postgres/' + backupId + '/manifest.json');
    await client.putObject(manifestKey, Buffer.from(JSON.stringify(manifest)), {
      contentType: 'application/json',
    });
    await uploadStatus(client, prefix, 'postgres', { status: 'ok', completedAt: new Date().toISOString(), backupId });
    process.stdout.write(JSON.stringify({ status: 'ok', kind: 'postgres', backupId, objectKey, keyId: keys.activeKeyId }) + '\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function listAllObjects(client) {
  const objects = [];
  let continuationToken;
  do {
    const page = await client.listObjects({ continuationToken });
    objects.push(...page.contents);
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    if (page.isTruncated && !continuationToken) {
      throw new Error('Object storage returned a truncated page without a continuation token.');
    }
  } while (continuationToken);
  return objects;
}

async function backupObjects() {
  const keys = await loadKeys();
  const backup = createBackupClient();
  const sourceBucket = requiredEnv('OBJECT_STORAGE_BUCKET');
  const source = createObjectStorageClient(sourceBucket);
  const prefix = safePrefix(process.env.PLATFORM_BACKUP_S3_PREFIX);
  const backupEndpoint = new URL(requiredEnv('PLATFORM_BACKUP_S3_ENDPOINT'));
  const sourceEndpoint = new URL(process.env.OBJECT_STORAGE_INTERNAL_ENDPOINT
    || requiredEnv('OBJECT_STORAGE_ENDPOINT'));
  if (backupEndpoint.origin === sourceEndpoint.origin
    && process.env.PLATFORM_BACKUP_S3_BUCKET === sourceBucket) {
    throw new Error('Backup bucket must differ from the live object-storage bucket.');
  }

  const snapshotId = randomUUID();
  const startedAt = new Date().toISOString();
  const directory = await temporaryDirectory('platform-objects-backup-');
  try {
    const manifest = {
      format: 'multi-streamer-audio-platform.object-backup',
      version: 1,
      snapshotId,
      sourceBucket,
      startedAt,
      keyId: keys.activeKeyId,
      objects: [],
    };
    for (const sourceObject of await listAllObjects(source)) {
      const objectId = randomUUID();
      const sourcePath = join(directory, objectId + '.source');
      const encryptedPath = join(directory, objectId + '.msapbk');
      const sourceMetadata = await source.getFile(sourceObject.key, sourcePath);
      const encrypted = await encryptBackupFile({
        sourcePath,
        destinationPath: encryptedPath,
        key: keys.activeKey,
        keyId: keys.activeKeyId,
        context: 'objects:' + snapshotId + ':' + objectId,
      });
      const objectKey = backupKey(prefix, 'objects/' + snapshotId + '/data/' + objectId + '.msapbk');
      await backup.putFile(objectKey, encryptedPath, {
        metadata: {
          'x-amz-meta-plaintext-sha256': encrypted.sha256,
          'x-amz-meta-key-id': keys.activeKeyId,
        },
      });
      manifest.objects.push({
        objectId,
        key: sourceObject.key,
        contentType: sourceMetadata.contentType || 'application/octet-stream',
        bytes: encrypted.plaintextBytes,
        sha256: encrypted.sha256,
        archive: objectKey,
      });
      await rm(sourcePath, { force: true });
      await rm(encryptedPath, { force: true });
    }

    const manifestPath = join(directory, 'manifest.json');
    const encryptedManifestPath = manifestPath + '.msapbk';
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const encryptedManifest = await encryptBackupFile({
      sourcePath: manifestPath,
      destinationPath: encryptedManifestPath,
      key: keys.activeKey,
      keyId: keys.activeKeyId,
      context: 'objects:' + snapshotId + ':manifest',
    });
    const manifestKey = backupKey(prefix, 'objects/' + snapshotId + '/manifest.json.msapbk');
    await backup.putFile(manifestKey, encryptedManifestPath, {
      metadata: {
        'x-amz-meta-plaintext-sha256': encryptedManifest.sha256,
        'x-amz-meta-key-id': keys.activeKeyId,
      },
    });
    await uploadStatus(backup, prefix, 'objects', {
      status: 'ok',
      completedAt: new Date().toISOString(),
      backupId: snapshotId,
      objectCount: manifest.objects.length,
    });
    process.stdout.write(JSON.stringify({
      status: 'ok',
      kind: 'objects',
      snapshotId,
      objectCount: manifest.objects.length,
      manifestKey,
      keyId: keys.activeKeyId,
    }) + '\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function archiveWal(sourcePath, filename) {
  if (!walFilenamePattern.test(filename ?? '')) throw new Error('WAL filename is invalid.');
  const keys = await loadKeys();
  const client = createBackupClient();
  const prefix = safePrefix(process.env.PLATFORM_BACKUP_S3_PREFIX);
  const directory = await temporaryDirectory('platform-wal-archive-');
  try {
    const encryptedPath = join(directory, filename + '.msapbk');
    const encrypted = await encryptBackupFile({
      sourcePath: resolve(sourcePath),
      destinationPath: encryptedPath,
      key: keys.activeKey,
      keyId: keys.activeKeyId,
      context: 'wal:' + filename.toUpperCase(),
    });
    const objectKey = backupKey(prefix, 'wal/' + filename.toUpperCase() + '.msapbk');
    await client.putFile(objectKey, encryptedPath, {
      metadata: {
        'x-amz-meta-plaintext-sha256': encrypted.sha256,
        'x-amz-meta-key-id': keys.activeKeyId,
      },
    });
    await uploadStatus(client, prefix, 'wal', {
      status: 'ok',
      completedAt: new Date().toISOString(),
      filename: filename.toUpperCase(),
      sha256: encrypted.sha256,
      keyId: keys.activeKeyId,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function restoreWal(filename, destinationPath) {
  if (!walFilenamePattern.test(filename ?? '')) throw new Error('WAL filename is invalid.');
  const keys = await loadKeys();
  const client = createBackupClient();
  const prefix = safePrefix(process.env.PLATFORM_BACKUP_S3_PREFIX);
  const directory = await temporaryDirectory('platform-wal-restore-');
  try {
    const encryptedPath = join(directory, filename + '.msapbk');
    await client.getFile(backupKey(prefix, 'wal/' + filename.toUpperCase() + '.msapbk'), encryptedPath);
    await decryptBackupFile({
      sourcePath: encryptedPath,
      destinationPath: resolve(destinationPath),
      keyRing: keys.keys,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function restorePostgres(backupId, targetDirectory, targetTime) {
  const id = ensureBackupId(backupId);
  const keys = await loadKeys();
  const client = createBackupClient();
  const prefix = safePrefix(process.env.PLATFORM_BACKUP_S3_PREFIX);
  const manifestKey = backupKey(prefix, 'postgres/' + id + '/manifest.json');
  const manifest = JSON.parse((await client.getObject(manifestKey)).toString('utf8'));
  if (
    manifest.format !== 'multi-streamer-audio-platform.postgres-backup' ||
    manifest.version !== 1 ||
    manifest.backupId !== id ||
    typeof manifest.archive !== 'string'
  ) {
    throw new Error('PostgreSQL backup manifest is invalid.');
  }
  const absoluteTarget = resolve(targetDirectory);
  const parent = dirname(absoluteTarget);
  await mkdir(parent, { recursive: true });
  const directory = await temporaryDirectory('platform-postgres-restore-');
  const extractedDirectory = join(directory, 'data');
  try {
    const encryptedPath = join(directory, 'base.tar.gz.msapbk');
    const archivePath = join(directory, 'base.tar.gz');
    await client.getFile(manifest.archive, encryptedPath);
    await decryptBackupFile({
      sourcePath: encryptedPath,
      destinationPath: archivePath,
      keyRing: keys.keys,
    });
    await mkdir(extractedDirectory, { mode: 0o700 });
    await runCommand('tar', [
      '--extract',
      '--gzip',
      '--file=' + archivePath,
      '--directory=' + extractedDirectory,
      '--no-same-owner',
      '--no-same-permissions',
    ]);
    await runCommand('pg_verifybackup', [extractedDirectory]);
    if (targetTime !== undefined) {
      const parsedTarget = new Date(targetTime);
      if (!Number.isFinite(parsedTarget.getTime())) throw new Error('Recovery target time must be a valid ISO timestamp.');
      const command = shellQuote(process.execPath) + ' ' + shellQuote(scriptPath) + ' restore-wal "%f" "%p"';
      const escapedCommand = command.replace(/'/g, "''");
      await appendFile(join(extractedDirectory, 'postgresql.auto.conf'),
        "\nrestore_command = '" + escapedCommand + "'\n"
        + "recovery_target_time = '" + parsedTarget.toISOString() + "'\n"
        + "recovery_target_action = 'promote'\n");
      await writeFile(join(extractedDirectory, 'recovery.signal'), '', { flag: 'wx', mode: 0o600 });
    }

    try {
      await stat(absoluteTarget);
      throw new Error('Restore target already exists; choose an empty target directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(extractedDirectory, absoluteTarget);
    process.stdout.write(JSON.stringify({
      status: 'verified',
      backupId: id,
      targetDirectory: absoluteTarget,
      recoveryTargetTime: targetTime ? new Date(targetTime).toISOString() : null,
    }) + '\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function shellQuote(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function restoreObjects(snapshotId, targetBucket) {
  const id = ensureBackupId(snapshotId);
  if (!targetBucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(targetBucket)) {
    throw new Error('Provide a valid empty target object-storage bucket name.');
  }
  const keys = await loadKeys();
  const backup = createBackupClient();
  const target = createObjectStorageClient(targetBucket);
  const prefix = safePrefix(process.env.PLATFORM_BACKUP_S3_PREFIX);
  const existing = await target.listObjects();
  if (existing.contents.length > 0 || existing.isTruncated) {
    throw new Error('Object restore target bucket must be empty.');
  }

  const directory = await temporaryDirectory('platform-objects-restore-');
  try {
    const encryptedManifestPath = join(directory, 'manifest.json.msapbk');
    const manifestPath = join(directory, 'manifest.json');
    const manifestKey = backupKey(prefix, 'objects/' + id + '/manifest.json.msapbk');
    await backup.getFile(manifestKey, encryptedManifestPath);
    await decryptBackupFile({
      sourcePath: encryptedManifestPath,
      destinationPath: manifestPath,
      keyRing: keys.keys,
    });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      manifest.format !== 'multi-streamer-audio-platform.object-backup' ||
      manifest.version !== 1 ||
      manifest.snapshotId !== id ||
      !Array.isArray(manifest.objects)
    ) {
      throw new Error('Object backup manifest is invalid.');
    }

    for (const entry of manifest.objects) {
      if (typeof entry.key !== 'string' || typeof entry.archive !== 'string') {
        throw new Error('Object backup manifest entry is invalid.');
      }
      const encryptedPath = join(directory, entry.objectId + '.msapbk');
      const restoredPath = join(directory, entry.objectId + '.restored');
      await backup.getFile(entry.archive, encryptedPath);
      const header = await decryptBackupFile({
        sourcePath: encryptedPath,
        destinationPath: restoredPath,
        keyRing: keys.keys,
      });
      if (header.sha256 !== entry.sha256 || header.plaintextBytes !== entry.bytes) {
        throw new Error('Restored object failed its snapshot manifest integrity check.');
      }
      await target.putFile(entry.key, restoredPath, {
        contentType: entry.contentType || 'application/octet-stream',
        immutable: false,
      });
      await rm(encryptedPath, { force: true });
      await rm(restoredPath, { force: true });
    }
    process.stdout.write(JSON.stringify({ status: 'restored', snapshotId: id, objectCount: manifest.objects.length, targetBucket }) + '\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyStatus() {
  const client = createBackupClient();
  const prefix = safePrefix(process.env.PLATFORM_BACKUP_S3_PREFIX);
  const now = Date.now();
  const postgres = await readStatus(
    client,
    prefix,
    'postgres',
    Number(process.env.PLATFORM_BACKUP_POSTGRES_MAX_AGE_SECONDS || 93600),
    now,
  );
  const objects = await readStatus(
    client,
    prefix,
    'objects',
    Number(process.env.PLATFORM_BACKUP_OBJECTS_MAX_AGE_SECONDS || 93600),
    now,
  );
  const wal = await readStatus(
    client,
    prefix,
    'wal',
    Number(process.env.PLATFORM_BACKUP_WAL_MAX_AGE_SECONDS || 900),
    now,
  );
  process.stdout.write(JSON.stringify({ status: 'ok', postgres, objects, wal }) + '\n');
}

const usage = 'Usage: node scripts/platform-backup.mjs <backup-postgres|backup-objects|archive-wal <source-path> <wal-filename>|restore-wal <wal-filename> <destination-path>|restore-postgres <backup-id> <target-data-dir> [recovery-target-time]|restore-objects <snapshot-id> <empty-target-bucket>|verify-status>';
try {
  switch (command) {
    case 'backup-postgres':
      await backupPostgres();
      break;
    case 'backup-objects':
      await backupObjects();
      break;
    case 'archive-wal':
      await archiveWal(args[0], args[1]);
      break;
    case 'restore-wal':
      await restoreWal(args[0], args[1]);
      break;
    case 'restore-postgres':
      if (args.length < 2) throw new Error(usage);
      await restorePostgres(args[0], args[1], args[2]);
      break;
    case 'restore-objects':
      await restoreObjects(args[0], args[1]);
      break;
    case 'verify-status':
      await verifyStatus();
      break;
    default:
      fail(usage);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'Platform backup command failed.');
}
