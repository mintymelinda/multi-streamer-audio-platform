# Encrypted backups, WAL recovery, and restore drills

This runbook describes the Phase 7 backup runner in `scripts/platform-backup.mjs`. It is separate from the deletion ledger: database/object backups must never replace or roll back the independent deletion/revocation ledger or its HMAC key.

## Recovery objectives

These are initial operating objectives, not measured guarantees:

| Data set | Initial RPO objective | Mechanism | Health threshold |
|---|---:|---|---:|
| PostgreSQL | 15 minutes | Daily physical base backup plus continuous WAL archive | 15 minutes since the last archived WAL segment |
| Object-storage assets | 24 hours | Daily encrypted inventory snapshot | 26 hours since the latest successful snapshot |
| Full service recovery | 4 hours (provisional) | Restore PostgreSQL/PITR, restore object assets, replay deletion ledger, validate, then reopen traffic | Must be measured in restore drills |

The 4-hour RTO is only a planning target for the current small deployment footprint. It is not a demonstrated restore time. Record actual elapsed time and data volume during each drill, and revise the objective when measured restore time or asset volume makes it unrealistic.

The database RPO depends on PostgreSQL archiving being enabled and every required WAL segment remaining available. A fresh status marker proves only that at least one segment was archived recently; it does not prove that the entire WAL chain is gap-free. A successful restore drill must prove the chain. The object snapshot is not a point-in-time S3 snapshot: pause writes to the source bucket for the duration of the job. The runner checks object ETags and inventory before/after copying and aborts when it detects changes, but only a write pause provides the intended stable inventory boundary.

## Storage and key separation

Use a dedicated backup bucket with a different name from the live object-storage bucket. Prefer a different S3 account, credentials, endpoint, and failure domain. Do not put backup archives in the live asset bucket or on the same storage volume as PostgreSQL.

Recommended bucket posture:

- Enable bucket versioning and Object Lock at bucket creation. Set a default COMPLIANCE retention period covering at least 35 days, subject to an approved retention policy.
- Deny `DeleteObject`, `DeleteObjectVersion`, `DeleteBucket`, retention changes, and legal-hold changes to routine backup credentials. Use a separate break-glass administrative identity for retention administration.
- Enforce TLS and block public access. The runner rejects non-HTTPS endpoints outside local development.
- Allow the backup identity to list the bucket and Get/Put/Head backup objects. The runner uses conditional `If-None-Match: *` creation for archive objects; it never deletes backup artifacts.
- Keep the deletion-ledger archive bucket separate from this backup bucket and from the live asset bucket. Follow [Deletion ledger and deletion-safe recovery](./deletion-ledger-recovery.md).
- Keep the backup key ring and an encrypted offline recovery copy outside both the database and backup buckets. A database/object backup without its matching key material is not recoverable.

The backup format uses streaming AES-256-GCM. Each archive records a versioned key ID, a purpose-specific context, a random nonce, an authentication tag, a SHA-256 plaintext digest, and the plaintext byte count. Restore checks the authentication tag, expected key/context, digest, and byte count before publishing the restored file. Never rename or copy an encrypted object to another backup identity and assume it will restore there.

### Create the backup key ring

Generate the initial key ring on a trusted operator host. The file must be readable only by the backup/restore OS identity:

```sh
umask 077
export PLATFORM_BACKUP_KEYRING_FILE=/secure/platform-backup/keyring.json
node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const keyId = 'backup-2026-11';
const document = {
  format: 'multi-streamer-audio-platform.backup-keyring',
  version: 1,
  activeKeyId: keyId,
  keys: { [keyId]: randomBytes(32).toString('hex') },
};
await writeFile(
  process.env.PLATFORM_BACKUP_KEYRING_FILE,
  JSON.stringify(document, null, 2) + '\n',
  { mode: 0o600, flag: 'wx' },
);
NODE
chmod 600 "$PLATFORM_BACKUP_KEYRING_FILE"
```

Seal an encrypted recovery copy of the complete key-ring file in an independent secret/recovery system. Test retrieval of that copy from a clean recovery host. Do not store the only copy beside the encrypted backup artifacts.

For key rotation, add a new random 32-byte key under a new ID, make it the `activeKeyId`, and retain every old key until all backups encrypted with it have expired and a restore drill has proved the remaining recovery set works. Do not delete old keys merely because the active key changed. The key-ring file is JSON containing raw key bytes encoded as hex; its 0600 permissions and independent encrypted recovery copy are mandatory.

## Runner configuration

The runner reads configuration from the process environment; it does not change Compose files, application environment files, or PostgreSQL configuration.

Backup bucket credentials:

- `PLATFORM_BACKUP_S3_ENDPOINT`
- `PLATFORM_BACKUP_S3_BUCKET`
- `PLATFORM_BACKUP_S3_ACCESS_KEY`
- `PLATFORM_BACKUP_S3_SECRET_KEY`
- Optional `PLATFORM_BACKUP_S3_REGION` (default `us-east-1`)
- Optional `PLATFORM_BACKUP_S3_PREFIX` (default `v1/platform`)
- `PLATFORM_BACKUP_KEYRING_FILE`

PostgreSQL base-backup credentials:

- `PLATFORM_BACKUP_DATABASE_URL` (PostgreSQL URL; do not include a password)
- `PGPASSFILE` (0600 password file for the backup OS identity)
- Optional `PGSSLMODE`; the runner defaults to `require` unless the URL explicitly supplies `sslmode`. Prefer `verify-full` with a trusted `PGSSLROOTCERT` in production.

The PostgreSQL backup role needs the privileges required by `pg_basebackup`, including replication connection access, and should have no application write privileges. For a replication connection, the password-file database field is `replication`. Install a compatible `pg_basebackup`, `pg_verifybackup`, and `tar` on the runner host. The runner currently fails closed when the source PostgreSQL data directory uses tablespaces; explicit tablespace mapping is not implemented.

Live object-storage backup uses a dedicated read-only identity:

- `OBJECT_STORAGE_ENDPOINT` or `OBJECT_STORAGE_INTERNAL_ENDPOINT`
- `OBJECT_STORAGE_BUCKET`
- `OBJECT_STORAGE_BACKUP_READ_ACCESS_KEY`
- `OBJECT_STORAGE_BACKUP_READ_SECRET_KEY`
- Optional `OBJECT_STORAGE_REGION` and `OBJECT_STORAGE_ALLOW_INSECURE_HTTP` (the HTTP opt-in is local-development-only)

Object restore uses a separate write identity:

- `OBJECT_STORAGE_RESTORE_ACCESS_KEY`
- `OBJECT_STORAGE_RESTORE_SECRET_KEY`

Grant the source identity only ListBucket/GetObject (including HEAD) on the live bucket. Grant the restore identity only the list/head/put operations needed for an explicitly provisioned empty recovery bucket. Do not reuse the application's runtime object-storage credentials.

The backup-bucket identity must support ListBucket, GetObject/HeadObject, and PutObject in the backup bucket. It must not have delete or retention-administration permissions. The backup runner uses one backup bucket for encrypted PostgreSQL archives, WAL, object snapshots, manifests, and append-only status records.

## PostgreSQL continuous WAL archiving

On the PostgreSQL server, provision a WAL-archiver execution environment with Node.js 26.13 or newer, the repository script, the key ring, and the backup-bucket variables above. The process that PostgreSQL invokes must be able to read the key ring and reach the backup endpoint. Do not assume the application container's Node runtime or environment is automatically visible to the PostgreSQL server.

Configure PostgreSQL through the operator's normal managed configuration process (not by editing this repository's Compose or environment files):

```conf
wal_level = replica
archive_mode = on
archive_timeout = '5min'
archive_command = 'node /absolute/path/to/scripts/platform-backup.mjs archive-wal "%p" "%f"'
```

Use an absolute Node executable path if the PostgreSQL process has a restricted `PATH`. Restart PostgreSQL when required for `archive_mode`; reload configuration for settings that support reload. Confirm `pg_stat_archiver` is making progress and inspect the PostgreSQL server log for non-zero `archive_command` results. A failed upload must make the command fail so PostgreSQL retries rather than silently discarding a WAL segment.

The command accepts 24-hex WAL segment names, eight-hex timeline `.history` files, and PostgreSQL backup-history names in the `24hex.8hex.backup` form. It stores immutable encrypted objects. A duplicate retry succeeds only when the already stored encrypted object has the same content digest. It writes at most one append-only WAL health record per 15-minute window so a bucket-wide Object Lock default does not require overwriting a mutable marker.

If an otherwise idle database produces no WAL segments, a stale WAL status may indicate no recent archive event rather than data loss. Choose an operational heartbeat policy (for example, periodic WAL switching under controlled load) or tune the alert threshold to the workload. Never suppress an alert without checking `pg_stat_archiver` and the retained WAL chain.

## Schedule and health monitoring

Run the two full backups daily, with writes paused to the asset bucket during the object snapshot:

```sh
node scripts/platform-backup.mjs backup-postgres
# Pause writes to the live asset bucket for the full snapshot window.
node scripts/platform-backup.mjs backup-objects
node scripts/platform-backup.mjs verify-status
```

Schedule `verify-status` at least every five minutes and alert on a non-zero exit code. It prints JSON with the latest successful PostgreSQL, object, and WAL status and their ages. Default freshness thresholds are 26 hours for PostgreSQL and object snapshots and 15 minutes for WAL; set `PLATFORM_BACKUP_POSTGRES_MAX_AGE_SECONDS`, `PLATFORM_BACKUP_OBJECTS_MAX_AGE_SECONDS`, or `PLATFORM_BACKUP_WAL_MAX_AGE_SECONDS` only to reviewed positive integer values. A health check is not a substitute for inspecting archiver errors, storage quota, credentials, and WAL continuity.

The runner does not prune archives. Apply an approved bucket lifecycle/retention policy only after confirming that no retained base backup still needs the WAL segments being considered for expiry. Retain a recoverable base backup and its entire WAL chain for every point-in-time recovery window. Record backup IDs, snapshot IDs, key IDs, and object keys in an independently recoverable inventory.

## Restore procedure

Perform restoration in an isolated recovery environment. Do not point these commands at a live database directory or a non-empty object bucket.

1. Stop API and worker services and prevent new writes to the live object-storage bucket.
2. Recover the key ring and backup-bucket read credentials independently. Recover PostgreSQL credential/CA material and the separately managed integration-credential KEKs required by the application.
3. Choose the PostgreSQL backup UUID from the independent backup inventory. Restore to a new, empty data directory:

   ```sh
   node scripts/platform-backup.mjs restore-postgres <backup-id> /recovery/postgres-data
   ```

   The command downloads the archive, checks the authenticated encryption context and manifest digest, decrypts into a private temporary file, extracts it, and runs `pg_verifybackup`. It refuses to replace an existing target directory.
4. For point-in-time recovery, provide an ISO timestamp as the third argument:

   ```sh
   node scripts/platform-backup.mjs restore-postgres <backup-id> /recovery/postgres-data 2026-11-12T14:30:00Z
   ```

   The runner installs `restore_command`, `recovery_target_time`, `recovery_target_action = 'promote'`, and `restore_target_timeline = 'latest'`. PostgreSQL calls the same script's `restore-wal` command for each required segment/history file. Keep the backup key ring and backup-bucket access available to the PostgreSQL process throughout recovery.
5. Start the restored PostgreSQL instance in isolation and verify recovery reached the requested target. Inspect PostgreSQL logs and application-level integrity checks.
6. Restore assets into a newly provisioned empty bucket using the separate restore identity:

   ```sh
   node scripts/platform-backup.mjs restore-objects <snapshot-id> <empty-target-bucket>
   ```

   If an object restore fails after writing some entries, abandon that partial target and use a new empty bucket for the next attempt. The current manifest preserves object keys, bytes, and Content-Type; it does not yet restore arbitrary user metadata, tags, ACLs, or object-lock settings. Verify whether the application relies on any of those properties before treating the asset restore as complete.
7. Restore the required schema migrations, then replay the newest independent deletion-ledger artifact and HMAC key using the procedure in [Deletion ledger and deletion-safe recovery](./deletion-ledger-recovery.md). Apply that ledger before starting API/workers or accepting user traffic. Also recover integration-credential KEKs independently; the backup archive key does not decrypt provider credentials.
8. Validate workspace isolation, request/queue state, provider credential availability, storage object counts/digests, overlay access, and background jobs. Rotate sessions/secrets if the incident requires it, then reopen traffic.

A base backup alone does not guarantee PITR. Missing, expired, or inaccessible WAL segments must be treated as a failed recovery, not silently skipped.

## Restore drills and evidence

At least quarterly, and after any change to backup code, keys, PostgreSQL major version, or object-storage provider:

- Restore the latest PostgreSQL base backup to a clean isolated instance; run `pg_verifybackup` and database/application integrity checks.
- Restore to a timestamp after the base backup and prove PostgreSQL can replay the complete archived WAL chain, including any timeline history.
- Restore an object snapshot to a new empty bucket; compare key inventory and content digests and verify the required object headers.
- Recover the key ring from its independent encrypted copy, not the primary host copy.
- Replay the newest independent deletion ledger and verify that post-backup deletions/revocations remain enforced.
- Measure elapsed time, recovered-to timestamp, object count/bytes, missing/corrupt artifacts, and operator actions. Record actual RPO/RTO and exceptions in the recovery log.

Do not close the Phase 7 backup/restore acceptance items until an independent-key recovery drill, PostgreSQL PITR drill, object restore drill, deletion-ledger replay, and documented measured RPO/RTO have all passed.
