# Deletion ledger and deletion-safe recovery

Phase 7, item 64 adds a database event journal plus a signed, portable ledger artifact. The database journal records permanent workspace/account deletion and revocation of provider credentials, workspace memberships, invitations, support grants, platform-administrator access, and account/workspace access restrictions, and individual session revocations.

## Why the external artifact is required

A PostgreSQL backup or point-in-time restore can roll the database back to a time before a deletion or revocation. A journal stored only in that same backup would roll back too. The signed ledger artifact must therefore be copied to durable storage independent of the PostgreSQL backup set and retained across restores. The recommended destination is a dedicated S3-compatible bucket with Object Lock, separate from the workspace asset bucket and excluded from ordinary database/object-storage restore operations. Keep the bucket outside the database host/volume and in a separate failure/backup domain.

The ledger contains stable Twitch numeric IDs and internal UUIDs. Treat it as restricted personal/security data. Protect the artifact at rest and in transit. The HMAC key must be at least 32 bytes and must be recovered independently of the database backup and ledger artifact. Configure `DELETION_LEDGER_S3_ENDPOINT`, `DELETION_LEDGER_S3_BUCKET`, `DELETION_LEDGER_S3_PREFIX`, and `DELETION_LEDGER_S3_REGION`. Use `DELETION_LEDGER_S3_WRITE_ACCESS_KEY` / `DELETION_LEDGER_S3_WRITE_SECRET_KEY` for export and `DELETION_LEDGER_S3_READ_ACCESS_KEY` / `DELETION_LEDGER_S3_READ_SECRET_KEY` for recovery; a shared `DELETION_LEDGER_S3_ACCESS_KEY` / `DELETION_LEDGER_S3_SECRET_KEY` pair is supported for local development only. `DELETION_LEDGER_S3_ALLOW_INSECURE_HTTP` is a local-development-only opt-in and is ignored when `NODE_ENV=production`.

This mechanism applies to deletion and revocation events recorded after migration `0050_deletion_ledger.sql` is installed. Deletions that occurred before this migration cannot be reconstructed retroactively.

## Configure the signing key

Generate a random key using a trusted operator workstation or secret-management process:

```sh
openssl rand -hex 32
```

Store the resulting value in the operator's independent secret store as `DELETION_LEDGER_HMAC_KEY`. Do not commit it, place it in the database, or store it beside the ledger artifact. The recovery commands also require `DATABASE_URL` for a privileged PostgreSQL connection.

## Export and preserve the ledger

After destructive or access-revocation operations, and before taking a backup, export the complete journal directly to the dedicated S3-compatible archive:

```sh
export DATABASE_URL='postgresql://platform_migrator:…@database-host/platform'
export DELETION_LEDGER_HMAC_KEY='…'
node scripts/deletion-ledger.mjs export-s3
```

The command writes one signed bundle to a unique immutable object key under `DELETION_LEDGER_S3_PREFIX`, then prints the export UUID and full `s3://` object path. Record that export UUID in the backup/recovery inventory. The bundle contains the complete versioned ledger document and its HMAC-SHA256 signature. Each export uses a new UUID key and conditional creation; the CLI never overwrites or deletes prior exports.

For offline/manual operation, the file-based `export` command remains available and writes the JSON document plus a `.hmac` sidecar. Copy both files to an independent, access-controlled location. A successful local file export is not an offsite copy.

## Restore procedure

1. Stop API and worker services so no user or background activity can occur during recovery.
2. Restore the PostgreSQL backup/PITR target.
3. Apply all migrations required by the application version being restored, including `0050_deletion_ledger.sql`.
4. Retrieve the export UUID recorded with the backup/recovery inventory and recover the HMAC key independently.
5. Verify and replay the S3 artifact using the privileged migrator connection:

   ```sh
   export DATABASE_URL='postgresql://platform_migrator:…@restored-database/platform'
   export DELETION_LEDGER_HMAC_KEY='…'
   node scripts/deletion-ledger.mjs replay-s3 <export-id>
   ```

   The recovery identity needs only GetObject for the archive objects; no write/delete permission is required. For offline recovery, the existing file-based `replay` command accepts the JSON file and its `.hmac` sidecar.
6. Do not start application services if signature verification or replay fails. Investigate the error and recover the correct artifact/key first.
7. After successful replay, verify the restored database and then start API/workers.

Replay is idempotent: existing journal entries are not duplicated, workspace and account tombstones are applied before dependent membership state, and credential tombstones target the original credential UUID so a later reconnect with a new credential ID is not removed. For each workspace/member pair, the latest recorded grant/revocation event determines the restored membership state. Workspace deletion cascades remove workspace-owned credentials and data; account deletion removes account rows and memberships. New account, workspace, or credential writes using permanently tombstoned identities/IDs are rejected.

## Operational boundaries

- The ledger is not a substitute for PostgreSQL backups, WAL/PITR, object-storage backups, or encryption-key recovery; those are separate Phase 7 items.
- Production must provision the archive bucket independently of the ordinary workspace asset bucket and exclude it from database/object-storage restore operations. Configure Object Lock at bucket creation and a default COMPLIANCE retention period covering the maximum backup-retention and recovery horizon.
- The export identity should have PutObject only. The recovery identity should have GetObject only for the archive objects; neither identity may delete objects, change retention/legal holds, change bucket policy, or delete the bucket. Keep recovery credentials and the HMAC key outside the restored backup set.
- The local Compose stack creates a separate MinIO bucket with Object Lock and a 100-year COMPLIANCE retention period for development only. Local root credentials are not an acceptable production credential model.
- The artifact must be exported and preserved independently. A local file or a bucket on the same backup/restore failure domain is not sufficient.
- Run replay only after restoring the database and applying the current schema migrations, and before starting API/workers.
- Use a dedicated `platform_migrator` connection. The API runtime and worker roles cannot read, export, or replay the global ledger. The transaction-local replay context is authenticated by a private token stored in the database; do not set `app.deletion_ledger_replay` manually. Only the migrator-owned replay function can activate it.
- The ledger is append-only. Do not edit its JSON manually. A malformed or invalidly signed artifact is rejected.
- Protect and test recovery of the HMAC key independently. Losing the key makes the external artifact unverifiable.
