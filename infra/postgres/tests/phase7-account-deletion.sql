\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  function_owner text;
  function_definer boolean;
  runtime_execute boolean;
BEGIN
  SELECT pg_get_userbyid(proowner), prosecdef,
         has_function_privilege('platform_runtime', oid, 'EXECUTE')
    INTO function_owner, function_definer, runtime_execute
    FROM pg_proc
   WHERE oid = 'delete_current_platform_account()'::regprocedure;
  IF function_owner <> 'platform_migrator' OR NOT function_definer OR NOT runtime_execute THEN
    RAISE EXCEPTION 'account deletion must be a migrator-owned SECURITY DEFINER function executable by runtime';
  END IF;
  IF has_function_privilege('platform_runtime', 'delete_current_platform_account()', 'EXECUTE') IS NOT TRUE
     OR has_table_privilege('platform_runtime', 'platform_users', 'DELETE') THEN
    RAISE EXCEPTION 'runtime account deletion boundary is incorrect';
  END IF;
  IF has_column_privilege('platform_runtime', 'platform_administrators', 'user_id', 'SELECT') THEN
    RAISE EXCEPTION 'runtime must not receive direct platform administrator table access';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid IN (
       'provider_output_assignments'::regclass,
       'playback_operations'::regclass,
       'provider_recovery_actions'::regclass,
       'workspace_rights_attestations'::regclass,
       'rights_content_blocks'::regclass,
       'workspace_provider_path_restrictions'::regclass
     )
       AND confrelid = 'platform_users'::regclass
       AND confdeltype <> 'n'
  ) THEN
    RAISE EXCEPTION 'workspace history actor references must use ON DELETE SET NULL';
  END IF;
END $$;

INSERT INTO platform_users (id, twitch_user_id) VALUES
  ('71000000-0000-4000-8000-000000000001', '710001'),
  ('71000000-0000-4000-8000-000000000002', '710002'),
  ('71000000-0000-4000-8000-000000000003', '710003');

INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES
  ('72000000-0000-4000-8000-000000000001', 'Account deletion fixture', '71000000-0000-4000-8000-000000000001', '710001'),
  ('72000000-0000-4000-8000-000000000002', 'Owned workspace blocker', '71000000-0000-4000-8000-000000000003', '710003');

INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'owner'),
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002', 'moderator'),
  ('72000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000003', 'owner');

INSERT INTO platform_administrators (user_id, twitch_user_id, role, permissions, revoked_at)
VALUES ('71000000-0000-4000-8000-000000000002', '710002', 'admin', ARRAY['accounts.read'], NULL);

INSERT INTO platform_administration_audit (actor_user_id, target_user_id, action, reason)
VALUES ('71000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000002', 'test.account_deletion', 'Exercise audit anonymization');

INSERT INTO user_sessions (user_id, session_token_hash, csrf_token_hash, expires_at)
VALUES ('71000000-0000-4000-8000-000000000002', repeat('a', 64), repeat('b', 64), now() + interval '1 day');

SELECT set_config('app.user_id', '71000000-0000-4000-8000-000000000002', true);
INSERT INTO user_notification_preferences (user_id) VALUES ('71000000-0000-4000-8000-000000000002');
INSERT INTO user_appearance_preferences (user_id) VALUES ('71000000-0000-4000-8000-000000000002');
INSERT INTO user_notification_email_settings (user_id) VALUES ('71000000-0000-4000-8000-000000000002');
INSERT INTO user_notifications (recipient_user_id, category, event_type, title)
VALUES ('71000000-0000-4000-8000-000000000002', 'account', 'test.account_deletion', 'Deletion test notification');
INSERT INTO user_data_exports (user_id) VALUES ('71000000-0000-4000-8000-000000000002');
INSERT INTO workspace_invitations (workspace_id, invited_twitch_user_id, assigned_role, token_hash, expires_at)
VALUES ('72000000-0000-4000-8000-000000000001', '710002', 'moderator', repeat('c', 64), now() + interval '1 day');

SET LOCAL ROLE platform_runtime;

-- An account that owns a workspace must delete that workspace first.
SELECT set_config('app.user_id', '71000000-0000-4000-8000-000000000003', true);
DO $$
BEGIN
  PERFORM delete_current_platform_account();
  RAISE EXCEPTION 'account deletion unexpectedly allowed while owning a workspace';
EXCEPTION WHEN foreign_key_violation THEN
  IF SQLERRM NOT LIKE '%delete your owned workspace%' THEN RAISE; END IF;
END $$;

-- An active platform administrator must first be revoked by the platform owner.
SELECT set_config('app.user_id', '71000000-0000-4000-8000-000000000002', true);
DO $$
BEGIN
  PERFORM delete_current_platform_account();
  RAISE EXCEPTION 'account deletion unexpectedly allowed for an active platform administrator';
EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM NOT LIKE '%platform administrator access must be revoked%' THEN RAISE; END IF;
END $;

-- Simulate the platform owner revoking the assignment, then delete the account.
RESET ROLE;
UPDATE platform_administrators SET revoked_at = now()
 WHERE user_id = '71000000-0000-4000-8000-000000000002';
SET LOCAL ROLE platform_runtime;
SELECT set_config('app.user_id', '71000000-0000-4000-8000-000000000002', true);
SELECT delete_current_platform_account();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_users WHERE id = '71000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'deleted account row remains';
  END IF;
  IF EXISTS (SELECT 1 FROM user_sessions WHERE user_id = '71000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'account sessions were not deleted';
  END IF;
  IF EXISTS (SELECT 1 FROM user_notification_preferences WHERE user_id = '71000000-0000-4000-8000-000000000002')
     OR EXISTS (SELECT 1 FROM user_appearance_preferences WHERE user_id = '71000000-0000-4000-8000-000000000002')
     OR EXISTS (SELECT 1 FROM user_notification_email_settings WHERE user_id = '71000000-0000-4000-8000-000000000002')
     OR EXISTS (SELECT 1 FROM user_notifications WHERE recipient_user_id = '71000000-0000-4000-8000-000000000002')
     OR EXISTS (SELECT 1 FROM user_data_exports WHERE user_id = '71000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'personal account data was not cascaded';
  END IF;
  IF EXISTS (SELECT 1 FROM workspace_memberships WHERE user_id = '71000000-0000-4000-8000-000000000002')
     OR EXISTS (SELECT 1 FROM platform_administrators WHERE user_id = '71000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'account memberships or revoked administrator assignment remain';
  END IF;
  PERFORM set_config('app.user_id', '71000000-0000-4000-8000-000000000001', true);
  PERFORM set_config('app.workspace_id', '72000000-0000-4000-8000-000000000001', true);
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = '72000000-0000-4000-8000-000000000001')
     OR NOT EXISTS (
       SELECT 1 FROM workspace_memberships
        WHERE workspace_id = '72000000-0000-4000-8000-000000000001'
          AND user_id = '71000000-0000-4000-8000-000000000001'
          AND role = 'owner'
     ) THEN
    RAISE EXCEPTION 'account deletion damaged a workspace owned by another user';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workspace_invitations
     WHERE workspace_id = '72000000-0000-4000-8000-000000000001'
       AND invited_twitch_user_id = '710002'
  ) THEN
    RAISE EXCEPTION 'invitations addressed to the deleted account remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM platform_administration_audit
     WHERE action = 'test.account_deletion'
       AND (actor_user_id IS NOT NULL OR target_user_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'platform administration audit references were not anonymized';
  END IF;
END $$;

ROLLBACK;
