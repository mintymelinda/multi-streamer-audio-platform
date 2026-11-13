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
const walFilenamePattern = /^(?:[0-9a-f]{24}|[0-9a-f]{8}\.history|[0-9a-f]{24}\.[0-9a-f]{8}\.backup)$/i;
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

function createObjectStorageClient(bucket, purpose = 'backup-read') {
  const credentialPrefix = purpose === 'restore'
    ? 'OBJECT_STORAGE_RESTORE'
    : 'OBJECT_STORAGE_BACKUP_READ';
  return createPlatformBackupS3Client({
    endpoint: process.env.OBJECT_STORAGE_INTERNAL_ENDPOINT
      || requiredEnv('OBJECT_STORAGE_ENDPOINT'),
    bucket: bucket || requiredEnv('OBJECT_STORAGE_BUCKET'),
    accessKey: requiredEnv(credentialPrefix + '_ACCESS_KEY'),
    secretKey: requiredEnv(credentialPrefix + '_SECRET_KEY'),
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
  const completedAt = new Date(status.completedAt);
  if (!Number.isFinite(completedAt.getTime())) {
    throw new Error('Backup status timestamp is invalid.');
  }
  const windowStart = name === 'wal'
    ? new Date(Math.floor(completedAt.getTime() / 900_000) * 900_000)
    : completedAt;
  const timestamp = windowStart.toISOString().replace(/[-:.]/g, '');
  const suffix = name === 'wal' ? '' : '-' + ensureBackupId(status.backupId);
  const objectKey = backupKey(prefix, 'status/' + name + '/' + timestamp + suffix + '.json');
  if (name === 'wal' && await client.headObject(objectKey)) return;
  try {
    await client.putObject(objectKey, Buffer.from(JSON.stringify(status)), {
      contentType: 'application/json',
    });
  } catch (error) {
    if (name === 'wal' && await client.headObject(objectKey)) return;
    throw error;
  }
}

async function readStatus(client, prefix, name, maximumAgeSeconds, nowMs) {
  const statusPrefix = backupKey(prefix, 'status/' + name + '/');
  const markers = await listAllObjects(client, statusPrefix);
  const latest = markers
    .filter((marker) => Number.isFinite(Date.parse(marker.lastModified)))
    .sort((left, right) => Date.parse(right.lastModified) - Date.parse(left.lastModified))[0];
  if (!latest) {
    throw new Error('No successful ' + name + ' backup status marker exists.');
  }
  let status;
  try {
    status = JSON.parse((await client.getObject(latest.key)).toString('utf8'));
  } catch {
    throw new Error('No valid successful ' + name + ' backup status marker exists.');
  }
  const completedAt = Date.parse(status?.completedAt);
  if (!status || typeof status !== 'object' || status.status !== 'ok') {
    throw new Error('No valid successful ' + name + ' backup status marker exists.');
  }
  const ageSeconds = (nowMs - completedAt) / 1000;
  if (
    !Number.isFinite(completedAt) ||
    ageSeconds < -60 ||
    ageSeconds > maximumAgeSeconds
  ) {
    throw new Error('The latest ' + name + ' backup is outside its freshness objective.');
  }
  return { name, completedAt: new Date(completedAt).toISOString(), ageSeconds, backupId: status.backupId };
}

async function databaseEnvironment() {
  const connectionString = requiredEnv('PLATFORM_BACKUP_DATABASE_URL');
  const connection = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)) {
    throw new Error('PLATFORM_BACKUP_DATABASE_URL must be a PostgreSQL connection URL.');
  }
  if (!process.env.PGPASSFILE) {
    throw new Error('Set PGPASSFILE to a protected backup-user password file; passwords are not read from the URL.');
  }
  const details = await stat(process.env.PGPASSFILE);
  if ((details.mode & 0o077) !== 0) {
    throw new Error('PGPASSFILE permissions must be 0600 or stricter.');
  }
  return {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port || '5432',
    PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
    PGUSER: decodeURIComponent(connection.username),
    PGSSLMODE: connection.searchParams.get('sslmode') || process.env.PGSSLMODE || 'require',
  };
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

async function listAllObjects(client, prefix = '') {
  const objects = [];
  let continuationToken;
  do {
    const page = await client.listObjects({ prefix, continuationToken });
    objects.push(...page.contents);
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    if (page.isTruncated && !continuationToken) {
      throw new Error('Object storage returned a truncated page without a continuation token.');
    }
  } while (continuationToken);
  return objects;
}

function objectInventoryFingerprint(objects) {
  return JSON.stringify(
    objects
      .map(({ key, size, etag }) => ({ key, size, etag }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  );
}

async function backupObjects() {
  const keys = await loadKeys();
  const backup = createBackupClient();
  const sourceBucket = requiredEnv('OBJECT_STORAGE_BUCKET');
  const source = createObjectStorageClient(sourceBucket);
  const prefix = safePrefix(process.env.PLATFORM_BACKUP_S3_PREFIX);
  if (process.env.PLATFORM_BACKUP_S3_BUCKET === sourceBucket) {
    throw new Error('Backup bucket must differ from the live object-storage bucket.');
  }

  const snapshotId = randomUUID();
  const startedAt = new Date().toISOString();
  const directory = await temporaryDirectory('platform-objects-backup-');
  try {
    const initialObjects = await listAllObjects(source);
    const initialInventory = objectInventoryFingerprint(initialObjects);
    const manifest = {
      format: 'multi-streamer-audio-platform.object-backup',
      version: 1,
      snapshotId,
      sourceBucket,
      startedAt,
      keyId: keys.activeKeyId,
      objects: [],
    };
    for (const sourceObject of initialObjects) {
      const objectId = randomUUID();
      const sourcePath = join(directory, objectId + '.source');
      const encryptedPath = join(directory, objectId + '.msapbk');
      const before = await source.headObject(sourceObject.key);
      if (!before || before.etag !== sourceObject.etag || before.contentLength !== sourceObject.size) {
        throw new Error('Object storage changed during backup inventory; rerun with writes paused.');
      }
      const sourceMetadata = await source.getFile(sourceObject.key, sourcePath);
      const after = await source.headObject(sourceObject.key);
      if (
        !after ||
        after.etag !== sourceObject.etag ||
        after.contentLength !== sourceObject.size ||
        sourceMetadata.contentLength !== sourceObject.size
      ) {
        throw new Error('Object changed while it was being copied; no consistent snapshot was published.');
      }
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

    const finalInventory = objectInventoryFingerprint(await listAllObjects(source));
    if (finalInventory !== initialInventory) {
      throw new Error('Object inventory changed during backup; pause object writes and rerun the snapshot.');
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
    if (/^[0-9a-f]{24}$/i.test(filename)) {
      await uploadStatus(client, prefix, 'wal', {
        status: 'ok',
        completedAt: new Date().toISOString(),
        filename: filename.toUpperCase(),
        sha256: encrypted.sha256,
        keyId: keys.activeKeyId,
      });
    }
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
      context: 'wal:' + filename.toUpperCase(),
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
    manifest.archive !== backupKey(prefix, 'postgres/' + id + '/base.tar.gz.msapbk') ||
    typeof manifest.keyId !== 'string' ||
    typeof manifest.archiveSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(manifest.archiveSha256)
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
    const archiveHeader = await decryptBackupFile({
      sourcePath: encryptedPath,
      destinationPath: archivePath,
      keyRing: keys.keys,
      keyId: manifest.keyId,
      context: 'postgres:' + id,
    });
    if (archiveHeader.sha256 !== manifest.archiveSha256) {
      throw new Error('PostgreSQL archive does not match its backup manifest.');
    }
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
        + "recovery_target_action = 'promote'\n"
        + "restore_target_timeline = 'latest'\n");
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
  const target = createObjectStorageClient(targetBucket, 'restore');
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
    const manifestHeader = await decryptBackupFile({
      sourcePath: encryptedManifestPath,
      destinationPath: manifestPath,
      keyRing: keys.keys,
      context: 'objects:' + id + ':manifest',
    });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      manifest.format !== 'multi-streamer-audio-platform.object-backup' ||
      manifest.version !== 1 ||
      manifest.snapshotId !== id ||
      !Array.isArray(manifest.objects) ||
      typeof manifest.keyId !== 'string' ||
      manifest.keyId !== manifestHeader.keyId
    ) {
      throw new Error('Object backup manifest is invalid.');
    }

    for (const entry of manifest.objects) {
      if (
        typeof entry.key !== 'string' ||
        !backupIdPattern.test(entry.objectId ?? '') ||
        entry.archive !== backupKey(prefix, 'objects/' + id + '/data/' + entry.objectId + '.msapbk')
      ) {
        throw new Error('Object backup manifest entry is invalid.');
      }
      const encryptedPath = join(directory, entry.objectId + '.msapbk');
      const restoredPath = join(directory, entry.objectId + '.restored');
      await backup.getFile(entry.archive, encryptedPath);
      const header = await decryptBackupFile({
        sourcePath: encryptedPath,
        destinationPath: restoredPath,
        keyRing: keys.keys,
        keyId: manifest.keyId,
        context: 'objects:' + id + ':' + entry.objectId,
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

function maximumAgeSeconds(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(name + ' must be a positive whole number of seconds.');
  }
  return value;
}

async function verifyStatus() {
  const client = createBackupClient();
  const prefix = safePrefix(process.env.PLATFORM_BACKUP_S3_PREFIX);
  const now = Date.now();
  const postgres = await readStatus(
    client,
    prefix,
    'postgres',
    maximumAgeSeconds('PLATFORM_BACKUP_POSTGRES_MAX_AGE_SECONDS', 93600),
    now,
  );
  const objects = await readStatus(
    client,
    prefix,
    'objects',
    maximumAgeSeconds('PLATFORM_BACKUP_OBJECTS_MAX_AGE_SECONDS', 93600),
    now,
  );
  const wal = await readStatus(
    client,
    prefix,
    'wal',
    maximumAgeSeconds('PLATFORM_BACKUP_WAL_MAX_AGE_SECONDS', 900),
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
