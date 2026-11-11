-- Phase 7 item 63: permanent deletion of a platform account.
-- Workspace-owned records retain their history while nullable actor references
-- are cleared when the referenced account is deleted.
BEGIN;

ALTER TABLE provider_output_assignments
  ALTER COLUMN assigned_by DROP NOT NULL;
ALTER TABLE provider_output_assignments
  DROP CONSTRAINT provider_output_assignments_assigned_by_fkey,
  ADD CONSTRAINT provider_output_assignments_assigned_by_fkey
    FOREIGN KEY (assigned_by) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE playback_operations
  ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE playback_operations
  DROP CONSTRAINT playback_operations_requested_by_fkey,
  ADD CONSTRAINT playback_operations_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE provider_recovery_actions
  ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE provider_recovery_actions
  DROP CONSTRAINT provider_recovery_actions_actor_user_id_fkey,
  ADD CONSTRAINT provider_recovery_actions_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE workspace_rights_attestations
  ALTER COLUMN accepted_by_user_id DROP NOT NULL;
ALTER TABLE workspace_rights_attestations
  DROP CONSTRAINT workspace_rights_attestations_accepted_by_user_id_fkey,
  ADD CONSTRAINT workspace_rights_attestations_accepted_by_user_id_fkey
    FOREIGN KEY (accepted_by_user_id) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE rights_content_blocks
  ALTER COLUMN blocked_by_user_id DROP NOT NULL;
ALTER TABLE rights_content_blocks
  DROP CONSTRAINT rights_content_blocks_blocked_by_user_id_fkey,
  ADD CONSTRAINT rights_content_blocks_blocked_by_user_id_fkey
    FOREIGN KEY (blocked_by_user_id) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE workspace_provider_path_restrictions
  ALTER COLUMN disabled_by_user_id DROP NOT NULL;
ALTER TABLE workspace_provider_path_restrictions
  DROP CONSTRAINT workspace_provider_path_restrictions_disabled_by_user_id_fkey,
  ADD CONSTRAINT workspace_provider_path_restrictions_disabled_by_user_id_fkey
    FOREIGN KEY (disabled_by_user_id) REFERENCES platform_users(id) ON DELETE SET NULL;

-- Platform administration history is append-only except for FK anonymization
-- performed by ON DELETE SET NULL. All business/audit fields remain immutable.
CREATE OR REPLACE FUNCTION prevent_platform_administration_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id
     AND NEW.action = OLD.action
     AND NEW.reason = OLD.reason
     AND NEW.details = OLD.details
     AND NEW.created_at = OLD.created_at
     AND (
       (OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL)
       OR (OLD.target_user_id IS NOT NULL AND NEW.target_user_id IS NULL)
     )
     AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id OR NEW.actor_user_id IS NULL)
     AND (NEW.target_user_id IS NOT DISTINCT FROM OLD.target_user_id OR NEW.target_user_id IS NULL) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'platform administration audit records are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION delete_current_platform_account()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $account_delete$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  actor_twitch_id text;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'authenticated account context is required'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('account-delete:' || actor_id::text, 0));

  SELECT twitch_user_id
    INTO actor_twitch_id
    FROM public.platform_users
   WHERE id = actor_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'account was not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.workspaces
     WHERE owner_user_id = actor_id
  ) THEN
    RAISE EXCEPTION 'delete your owned workspace before deleting this account'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.platform_administrators
     WHERE user_id = actor_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'platform administrator access must be revoked before deleting this account'
      USING ERRCODE = '42501';
  END IF;

  -- Invitations addressed to this stable Twitch identity are personal account
  -- records. Memberships in other people's workspaces are removed, but those
  -- workspaces and their integrations/configuration remain untouched.
  DELETE FROM public.workspace_invitations
   WHERE invited_twitch_user_id = actor_twitch_id;

  DELETE FROM public.workspace_memberships
   WHERE user_id = actor_id;

  -- A previously revoked administrator assignment no longer grants access and
  -- must be removed to release its RESTRICT foreign key to platform_users.
  DELETE FROM public.platform_administrators
   WHERE user_id = actor_id AND revoked_at IS NOT NULL;

  -- Cascades remove sessions, personal exports, notifications, preferences,
  -- email settings/outbox, Spotify OAuth transactions, and other personal rows.
  -- Workspace-owned historical actor references are anonymized by SET NULL.
  DELETE FROM public.platform_users
   WHERE id = actor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'account deletion did not remove the authenticated account'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN actor_id;
END;
$account_delete$;

ALTER FUNCTION delete_current_platform_account() OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION delete_current_platform_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_current_platform_account() TO platform_runtime;

COMMIT;
