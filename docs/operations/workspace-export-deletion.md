# Workspace export and permanent deletion

Phase 7, item 62 adds owner-only workspace export and permanent deletion.

## Export

Authenticated workspace owners can download a JSON document from `GET /workspaces/:workspaceId/export`. The export includes the workspace record and all persisted workspace-owned rows with a `workspace_id` column, excluding transient outbox/EventSub delivery, notification, and playback-operation internals.

Credential ciphertext and key envelopes, scene bearer-token hashes, invitation token hashes, and internal object-storage keys are stripped. Asset metadata is included with individual seven-day presigned download links. Download asset files before those links expire.

Personal account details and user-wide notification history remain available from the separate account export. The export has a 50 MiB JSON safety limit.

Only the current workspace owner may export. Membership in the workspace, including Admin, is insufficient.

## Permanent deletion

Authenticated owners can permanently delete a workspace through `DELETE /workspaces/:workspaceId` with JSON body `{"confirmationName":"exact workspace name"}`. The exact name is required to reduce accidental deletion.

The operation locks the workspace, deletes all ready and pending object-storage asset objects, then deletes the workspace row. The database cascades remove its scenes (immediately invalidating overlay URLs/tokens), integrations and encrypted credentials, provider configuration, requests and queues, invitations, memberships, workspace settings, rights workflow records, and other workspace-owned rows. If object storage deletion fails, the database transaction is rolled back and the owner can retry; some earlier object deletes may already have succeeded, but retries are safe because missing objects count as deleted.

The platform account is retained. Deleting a workspace releases the owner's one-workspace ownership slot. This operation does not delete the platform account or the user's other workspace memberships.

The database is authoritative for workspace and overlay access. No new overlay lookup can resolve a deleted scene. Provider credential material is removed from the platform database; this operation does not claim that every third-party provider has confirmed remote token revocation.

## Security and recovery boundary

The export function is a restricted SECURITY DEFINER function owned by `platform_migrator`, with explicit owner verification. It returns only rows belonging to the requested workspace and strips secret-bearing columns. The API runtime receives EXECUTE only; the migrator's row visibility is granted through table-specific SELECT policies.

Deletion is performed in one owner-verified database transaction after private object deletion succeeds. Workspace-owned relational data is removed through foreign-key cascades. Account deletion is covered by item 63. Workspace deletion is recorded in the signed [deletion ledger](deletion-ledger-recovery.md), which must be preserved independently and replayed before services restart after a backup restore.
