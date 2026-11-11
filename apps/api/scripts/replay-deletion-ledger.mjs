import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

const args = process.argv.slice(2);
const directoryIndex = args.indexOf('--directory');
const directory = directoryIndex >= 0 ? args[directoryIndex + 1] : undefined;
const databaseFile = process.env.DATABASE_URL_FILE;
if (!directory || !databaseFile) {
  throw new Error('Usage: DATABASE_URL_FILE=/secure/migrator-url pnpm --filter @platform/api replay:deletion-ledger -- --directory /secure/deletion-ledger');
}

const root = resolve(directory);
const connectionString = readFileSync(databaseFile, 'utf8').trim();
if (!connectionString) throw new Error('DATABASE_URL_FILE is empty.');

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(child);
  }
  return files;
}

const records = [];
for (const file of await walk(root)) {
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (record?.format !== 'multi-streamer-audio-platform.deletion-tombstone'
      || record.version !== 1
      || !['account', 'workspace', 'credential', 'membership_revocation'].includes(record.entityType)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.entityId)
      || ((record.entityType === 'credential' || record.entityType === 'membership_revocation') && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.workspaceId))
      || (record.entityType === 'credential' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.providerInstanceId))
      || (record.entityType === 'membership_revocation' && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.eventId) || typeof record.revokedAt !== 'string' || Number.isNaN(Date.parse(record.revokedAt))))
      || typeof record.deletedAt !== 'string'
      || Number.isNaN(Date.parse(record.deletedAt))) {
    throw new Error(`Invalid deletion tombstone: ${relative(root, file)}`);
  }
  const prefix = record.entityType === 'workspace' ? 'workspaces' : record.entityType === 'account' ? 'accounts' : record.entityType === 'credential' ? 'credentials' : 'membership-revocations';
  const expected = record.entityType === 'membership_revocation'
    ? join('v1', prefix, record.workspaceId.toLowerCase(), record.entityId.toLowerCase(), `${record.eventId}.json`)
    : join('v1', prefix, `${record.entityId.toLowerCase()}.json`);
  if (relative(root, file).split(sep).join('/') !== expected.split(sep).join('/')) {
    throw new Error(`Tombstone path does not match its entity identity: ${relative(root, file)}`);
  }
  records.push(record);
}

// Workspace tombstones must be replayed before account tombstones so the
// account-deletion guard sees the same lifecycle ordering as the live system.
records.sort((left, right) => {
  const rank = (record) => record.entityType === 'workspace' ? 0 : record.entityType === 'credential' ? 1 : record.entityType === 'membership_revocation' ? 2 : 3;
  return rank(left) - rank(right) || left.entityId.localeCompare(right.entityId);
});

const pool = new Pool({ connectionString, max: 1, application_name: 'deletion-ledger-replay' });
try {
  const identity = await pool.query('SELECT current_user AS role');
  if (identity.rows[0]?.role !== 'platform_migrator') {
    throw new Error('Deletion ledger replay must connect as platform_migrator.');
  }
  for (const record of records) {
    await pool.query('BEGIN');
    try {
      if (record.entityType === 'membership_revocation') {
        await pool.query('SELECT apply_membership_revocation($1::uuid, $2::uuid, $3::timestamptz)', [
          record.workspaceId, record.entityId, record.revokedAt,
        ]);
      } else if (record.entityType === 'credential') {
        await pool.query('SELECT apply_credential_tombstone($1::uuid, $2::uuid, $3::uuid)', [
          record.entityId, record.workspaceId, record.providerInstanceId,
        ]);
      } else {
        await pool.query('SELECT apply_deletion_tombstone($1, $2::uuid)', [
          record.entityType, record.entityId,
        ]);
      }
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
  console.log(`Replayed ${records.length} deletion tombstone(s) (workspaces, credentials, membership revocations, then accounts).`);
} finally {
  await pool.end();
}
