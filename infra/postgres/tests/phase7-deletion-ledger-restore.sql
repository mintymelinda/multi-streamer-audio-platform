\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  function_owner text;
  function_definer boolean;
BEGIN
  SELECT pg_get_userbyid(proowner), prosecdef
    INTO function_owner, function_definer
    FROM pg_proc
   WHERE oid = 'apply_deletion_tombstone(text,uuid)'::regprocedure;
  IF function_owner <> 'platform_migrator' OR NOT function_definer THEN
    RAISE EXCEPTION 'deletion replay must be a migrator-owned SECURITY DEFINER function';
  END IF;
  IF NOT has_function_privilege('platform_migrator', 'apply_deletion_tombstone(text,uuid)', 'EXECUTE')
     OR has_function_privilege('platform_runtime', 'apply_deletion_tombstone(text,uuid)', 'EXECUTE')
     OR has_function_privilege('platform_worker', 'apply_deletion_tombstone(text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'deletion replay execute privilege is not restricted to platform_migrator';
  END IF;
  IF NOT has_function_privilege('platform_migrator', 'apply_credential_tombstone(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('platform_runtime', 'apply_credential_tombstone(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('platform_worker', 'apply_credential_tombstone(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'credential tombstone replay execute privilege is not restricted to platform_migrator';
  END IF;
END $;

INSERT INTO platform_users (id, twitch_user_id) VALUES
  ('74000000-0000-4000-8000-000000000001', '740001'),
  ('74000000-0000-4000-8000-000000000002', '740002');

INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES
  ('75000000-0000-4000-8000-000000000001', 'Tombstoned workspace', '74000000-0000-4000-8000-000000000001', '740001'),
  ('75000000-0000-4000-8000-000000000002', 'Surviving workspace', '74000000-0000-4000-8000-000000000002', '740002');

INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES
  ('75000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 'owner'),
  ('75000000-0000-4000-8000-000000000002', '74000000-0000-4000-8000-000000000002', 'owner'),
  ('75000000-0000-4000-8000-000000000002', '74000000-0000-4000-8000-000000000001', 'moderator');

-- Replaying only a workspace tombstone must preserve its former owner's
-- account and unrelated memberships/workspaces.
SELECT apply_deletion_tombstone('workspace', '75000000-0000-4000-8000-000000000001');
SELECT apply_deletion_tombstone('workspace', '75000000-0000-4000-8000-000000000001');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspaces WHERE id = '75000000-0000-4000-8000-000000000001')
     OR NOT EXISTS (SELECT 1 FROM platform_users WHERE id = '74000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'workspace tombstone did not delete only the workspace';
  END IF;
END $$;

-- An account tombstone removes the account and its memberships, but never
-- removes the unrelated workspace or its owner.
SELECT apply_deletion_tombstone('account', '74000000-0000-4000-8000-000000000001');
SELECT apply_deletion_tombstone('account', '74000000-0000-4000-8000-000000000001');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_users WHERE id = '74000000-0000-4000-8000-000000000001')
     OR EXISTS (SELECT 1 FROM workspace_memberships WHERE user_id = '74000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'account tombstone did not remove the account and memberships';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = '75000000-0000-4000-8000-000000000002')
     OR NOT EXISTS (SELECT 1 FROM platform_users WHERE id = '74000000-0000-4000-8000-000000000002')
     OR NOT EXISTS (
       SELECT 1 FROM workspace_memberships
        WHERE workspace_id = '75000000-0000-4000-8000-000000000002'
          AND user_id = '74000000-0000-4000-8000-000000000002'
          AND role = 'owner'
     ) THEN
    RAISE EXCEPTION 'deletion replay damaged another workspace or its owner';
  END IF;
END $$;

-- A credential tombstone removes only the matching workspace/provider identity.
INSERT INTO provider_instances (id, workspace_id, provider_id, instance_key, contract_version)
VALUES ('76000000-0000-4000-8000-000000000001',
        '75000000-0000-4000-8000-000000000002', 'spotify', 'spotify-primary', 1);
SELECT set_config('app.user_id', '74000000-0000-4000-8000-000000000002', true);
SELECT set_config('app.workspace_id', '75000000-0000-4000-8000-000000000002', true);
INSERT INTO provider_credentials (
  id, workspace_id, provider_instance_id, ciphertext, nonce, auth_tag,
  wrapped_dek, dek_nonce, dek_auth_tag, kek_version, format_version
) VALUES (
  '77000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000001',
  'ciphertext', 'nonce', 'tag', 'wrapped', 'dek-nonce', 'dek-tag', 'test', 1
);
SELECT apply_credential_tombstone(
  '77000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000001'
);
SELECT apply_credential_tombstone(
  '77000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000001'
);
DO $
BEGIN
  IF EXISTS (SELECT 1 FROM provider_credentials WHERE id = '77000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'credential tombstone did not remove the encrypted credential';
  END IF;
END $;

ROLLBACK;
