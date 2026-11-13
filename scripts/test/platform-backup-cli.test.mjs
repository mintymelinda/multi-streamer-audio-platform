import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const backupScript = fileURLToPath(new URL('../platform-backup.mjs', import.meta.url));

function runArchiveWal(filename) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      !name.startsWith('PLATFORM_BACKUP_') &&
      !name.startsWith('OBJECT_STORAGE_') &&
      name !== 'NODE_ENV',
    ),
  );
  env.PATH = process.env.PATH ?? '';
  env.NODE_ENV = 'test';
  return spawnSync(
    process.execPath,
    [backupScript, 'archive-wal', '/unused/wal-segment', filename],
    { encoding: 'utf8', env },
  );
}

test('rejects unsafe WAL archive filenames before reading backup credentials', () => {
  const result = runArchiveWal('../../secrets');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WAL filename is invalid/);
  assert.doesNotMatch(result.stderr, /PLATFORM_BACKUP_KEYRING_FILE is required/);
});

test('accepts PostgreSQL WAL segments and timeline history filenames', () => {
  for (const filename of [
    '000000010000000000000001',
    '00000002.history',
    '000000010000000000000001.00000028.backup',
  ]) {
    const result = runArchiveWal(filename);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PLATFORM_BACKUP_KEYRING_FILE is required/);
    assert.doesNotMatch(result.stderr, /WAL filename is invalid/);
  }
});

test('rejects the malformed short backup-history filename form', () => {
  const result = runArchiveWal('00000001.backup');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WAL filename is invalid/);
});

test('rejects PostgreSQL credentials embedded in the backup database URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-backup-cli-test-'));
  try {
    const keyFile = join(directory, 'keyring.json');
    await writeFile(keyFile, JSON.stringify({
      format: 'multi-streamer-audio-platform.backup-keyring',
      version: 1,
      activeKeyId: 'backup-test',
      keys: { 'backup-test': randomBytes(32).toString('hex') },
    }), { mode: 0o600 });
    const env = {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      PLATFORM_BACKUP_KEYRING_FILE: keyFile,
      PLATFORM_BACKUP_S3_ENDPOINT: 'https://objects.example.test',
      PLATFORM_BACKUP_S3_BUCKET: 'platform-backups',
      PLATFORM_BACKUP_S3_ACCESS_KEY: 'test-access',
      PLATFORM_BACKUP_S3_SECRET_KEY: 'test-secret',
      PLATFORM_BACKUP_DATABASE_URL: 'postgresql://backup-user:do-not-leak@db.example.test/platform',
    };
    const result = spawnSync(process.execPath, [backupScript, 'backup-postgres'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not contain a password/);
    assert.doesNotMatch(result.stderr, /do-not-leak/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
