# Deletion ledger and deletion-safe recovery

Phase 7, item 64 adds a database event journal plus a signed, portable ledger artifact. The database journal records permanent workspace/account deletion and revocation of provider credentials, workspace memberships, invitations, support grants, platform-administrator access, and account/workspace access restrictions, and individual session revocations.

## Why the external artifact is required

A PostgreSQL backup or point-in-time restore can roll the database back to a time before a deletion or revocation. A journal stored only in that same backup would roll back too. The signed ledger artifact must therefore be copied to durable storage independent of the PostgreSQL backup set and retained across restores. Keep it outside the database host/volume and outside any restore operation that replaces the database.

The ledger contains stable Twitch numeric IDs and internal UUIDs. Treat it as restricted personal/security data. Protect the artifact at rest and in transit. The HMAC key must be at least 32 bytes and must be recovered independently of the database backup and ledger artifact.

This mechanism applies to deletion and revocation events recorded after migration `0050_deletion_ledger.sql` is installed. Deletions that occurred before this migration cannot be reconstructed retroactively.

## Configure the signing key

Generate a random key using a trusted operator workstation or secret-management process:

```sh
openssl rand -hex 32
```

Store the resulting value in the operator's independent secret store as `DELETION_LEDGER_HMAC_KEY`. Do not commit it, place it in the database, or store it beside the ledger artifact. The recovery commands also require `DATABASE_URL` for a privileged PostgreSQL connection.

## Export and preserve the ledger

After destructive or access-revocation operations, and before taking a backup, export the complete journal:

```sh
export DATABASE_URL='postgresql://platform_migrator:…@database-host/platform'
export DELETION_LEDGER_HMAC_KEY='…'
node scripts/deletion-ledger.mjs export /secure/offsite/platform-deletion-ledger.json
```

The command writes:
- `platform-deletion-ledger.json`: the complete versioned event document.
- `platform-deletion-ledger.json.hmac`: an HMAC-SHA256 signature for that exact document.

Copy both files to an independent, access-controlled, versioned/offsite location. Preserve prior copies according to the operational retention policy. A successful export to the local filesystem is not an offsite copy; verify the independent copy before considering the ledger protected. The ledger is cumulative, so the latest complete signed artifact supersedes earlier artifacts for replay, but retaining versions provides additional recovery options.

## Restore procedure

1. Stop API and worker services so no user or background activity can occur during recovery.
2. Restore the PostgreSQL backup/PITR target.
3. Apply all migrations required by the application version being restored, including `0050_deletion_ledger.sql`.
4. Retrieve the latest complete ledger artifact and the HMAC key from their independent recovery locations.
5. Verify and replay the artifact using the privileged migrator connection:

   ```sh
   export DATABASE_URL='postgresql://platform_migrator:…@restored-database/platform'
   export DELETION_LEDGER_HMAC_KEY='…'
   node scripts/deletion-ledger.mjs replay /secure/offsite/platform-deletion-ledger.json
   ```

6. Do not start application services if signature verification or replay fails. Investigate the error and recover the correct artifact/key first.
7. After successful replay, verify the restored database and then start API/workers.

Replay is idempotent: existing journal entries are not duplicated, workspace and account tombstones are applied before dependent membership state, and credential tombstones target the original credential UUID so a later reconnect with a new credential ID is not removed. For each workspace/member pair, the latest recorded grant/revocation event determines the restored membership state. Workspace deletion cascades remove workspace-owned credentials and data; account deletion removes account rows and memberships. New account, workspace, or credential writes using permanently tombstoned identities/IDs are rejected.

## Operational boundaries

- The ledger is not a substitute for PostgreSQL backups, WAL/PITR, object-storage backups, or encryption-key recovery; those are separate Phase 7 items.
- The artifact must be exported and copied independently. This migration does not silently claim that the application has an offsite storage destination or that a local file is durable.
- Run replay only after restoring the database and applying the current schema migrations, and before starting API/workers.
- Use a dedicated `platform_migrator` connection. The API runtime and worker roles cannot read, export, or replay the global ledger.
- The ledger is append-only. Do not edit its JSON manually. A malformed or invalidly signed artifact is rejected.
- Protect and test recovery of the HMAC key independently. Losing the key makes the external artifact unverifiable.
