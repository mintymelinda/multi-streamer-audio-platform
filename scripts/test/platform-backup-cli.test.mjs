import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
