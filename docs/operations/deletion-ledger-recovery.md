# Deletion ledger and recovery replay

Phase 7 item 64 protects permanent workspace and account deletions from ordinary database/object-storage restoration.

## Ledger design

Every successful permanent workspace/account deletion and confirmed provider-credential disconnection and workspace-membership revocation write versioned tombstones to a dedicated S3-compatible bucket before its PostgreSQL transaction commits. Object keys are deterministic (v1/workspaces/UUID.json, v1/accounts/UUID.json, and v1/credentials/UUID.json, and v1/membership-revocations/workspace-UUID/user-UUID/event-UUID.json), writes use conditional create semantics, and retries are idempotent. Tombstones contain only entity kinds, internal UUIDs, format version, event timestamps, and a random event ID where needed; they do not retain Twitch IDs, names, credential material, or workspace content.

The ledger is deliberately separate from PostgreSQL and the workspace asset bucket. Configure its endpoint and credentials independently:

- DELETION_LEDGER_ENDPOINT / DELETION_LEDGER_INTERNAL_ENDPOINT
- DELETION_LEDGER_BUCKET
- DELETION_LEDGER_ACCESS_KEY / DELETION_LEDGER_SECRET_KEY
- DELETION_LEDGER_REGION

If the ledger is unavailable or unconfigured, permanent deletion fails closed and the database transaction rolls back. Do not silently fall back to a PostgreSQL-only tombstone.

## Production storage requirements

The ledger endpoint must be in a separate failure and backup domain from the application database and ordinary asset storage. Replicate it off-host. The bucket must have S3 Object Lock enabled at creation and a default COMPLIANCE retention period covering the platform's maximum backup-retention and recovery horizon. Do not use a bucket that can be recreated from an ordinary NAS/object-storage snapshot.

Provision a dedicated application identity with only PutObject permission for this bucket (the API does not need read or delete access). It must not have DeleteObject, PutObjectRetention, PutObjectLegalHold, bucket-policy, lifecycle, or bucket-delete permissions. Use a separate recovery identity with ListBucket/GetObject read access. Keep the recovery credentials and database migrator credentials outside the restored backup set.

The local Compose stack creates a separate MinIO bucket with Object Lock and a long COMPLIANCE retention period for development. Local root credentials are for development only and are not an acceptable production credential model.

## Restore procedure

Do not expose the restored application to users or start API/worker processes until tombstones have been replayed.

1. Restore PostgreSQL and ordinary workspace object storage from the selected backup/PITR point into an isolated recovery environment.
2. Using the separate recovery identity, copy the complete ledger to a protected local directory. For MinIO/S3-compatible storage, for example:

       mc mirror ledger-recovery/platform-deletion-ledger /secure/recovery/deletion-ledger

   The mirror must contain the complete v1/ prefix. Do not use a destructive mirror option.
3. Run the replay tool against the restored database using the dedicated platform_migrator connection string:

       DATABASE_URL_FILE=/secure/recovery/platform-migrator-url \
         pnpm --filter @platform/api replay:deletion-ledger -- \
         --directory /secure/recovery/deletion-ledger

4. Confirm the tool reports the expected tombstone count and exits successfully. It validates record format, UUIDs, object-key/entity identity, and the database role before making changes.
5. Verify deleted workspace/account IDs are absent, then run the normal tenant-isolation and authorization checks. Only then bring API/workers online.

Replay is idempotent. Workspace tombstones are always applied first, then credential tombstones, then membership-revocation tombstones, then account tombstones so account deletion runs after its owned workspace has been removed. Credential tombstones carry the workspace and provider-instance UUIDs and remove only the matching encrypted credential row. Workspace deletion cascades through workspace-owned credentials, integrations, memberships, invitations, scenes, and other tenant records. A provider disconnect writes its own credential tombstone after remote revocation is confirmed, preventing a stale database backup from restoring that encrypted credential. Membership-revocation tombstones carry the membership's revoked_at timestamp; replay will not override a newer re-invitation or reactivation. Account deletion uses the existing account-deletion function, removing personal records and access while preserving unrelated workspaces. A tombstone for an already-absent entity is a successful no-op.

If replay fails for any record, keep the restored environment isolated, fix the cause, and rerun the complete replay. Do not start the service with a partially replayed ledger.

## Scope and limits

This mechanism records permanent workspace/account deletion and provider credential disconnection and workspace-membership revocation. It does not replace the separate backup/PITR, off-NAS backup, key-recovery, retention, or restore-drill work tracked by Phase 7 items 65–66. Provider-side revocation still depends on the provider's own revocation API; the ledger prevents deleted platform credential records and access grants from returning from a stale backup but cannot prove that a third-party token was remotely revoked.
