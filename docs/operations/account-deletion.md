# Account deletion

Phase 7, item 63 adds self-service permanent deletion of a platform account.

## User flow

The signed-in user opens **Account data → Delete your account** and types the exact confirmation phrase shown on the page. The dashboard sends an authenticated, CSRF-protected `DELETE /me` request. On success, the API clears the session cookies and returns HTTP 204.

## Deletion behavior

The database deletion function derives the target exclusively from the transaction-local authenticated `app.user_id`; the API never accepts a target user ID. The function is owned by `platform_migrator`, is `SECURITY DEFINER`, and is executable by `platform_runtime` without granting the runtime role direct account-table DELETE privileges.

Deletion removes the platform account, all server-side sessions, personal exports, notifications, notification and appearance preferences, optional email settings/outbox records, personal Spotify OAuth transactions, invitations addressed to the account's stable Twitch ID, and memberships in workspaces owned by other users. Revoked platform-administrator assignments are removed. Historical references to the account in workspace-owned records are set to NULL so playback/recovery, provider-output, rights-attestation, and content-block history remains intact without retaining the deleted account reference. Platform-administration audit events remain append-only except for the same foreign-key anonymization.

Workspaces the user only participates in are not deleted. Their integrations, provider credentials, settings, queues, assets, and other workspace-owned records remain. The account's membership is removed, and other workspace members retain their access.

## Required prerequisites

- A user who owns a workspace must permanently delete that workspace first through the separate workspace deletion workflow.
- An active platform administrator assignment must be revoked by an existing platform owner before the account can be deleted. The final active platform owner cannot be removed.
- If either prerequisite is unmet, deletion fails atomically with a clear conflict response. No personal data or session is removed.

## Integration boundary

Basic Twitch sign-in requests no scopes and discards the short-lived identity token. Provider credentials are workspace-owned rather than personal-account-owned. Deleting a non-owner account therefore does not disconnect another person's workspace integrations. Deleting an owned workspace first removes its stored credential material through the workspace deletion workflow; neither workflow claims that a third-party provider has confirmed remote token revocation.

Deletion-safe restoration and durable tombstones are implemented under Phase 7, item 64. Follow the [deletion ledger and recovery runbook](deletion-ledger-recovery.md) to export the signed ledger independently and replay it before restarting services after a restore.
