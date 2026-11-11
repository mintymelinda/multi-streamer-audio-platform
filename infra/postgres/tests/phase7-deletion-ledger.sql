\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  function_owner text;
  function_definer boolean;
BEGIN
  SELECT pg_get_userbyid(proowner), prosecdef
    INTO function_owner, function_definer
    FROM pg_proc WHERE oid='export_platform_deletion_ledger()'::regprocedure;
  IF function_owner <> 'platform_migrator' OR NOT function_definer THEN
    RAISE EXCEPTION 'ledger export must be a migrator-owned SECURITY DEFINER function';
  END IF;
  SELECT pg_get_userbyid(proowner), prosecdef
    INTO function_owner, function_definer
    FROM pg_proc WHERE oid='replay_platform_deletion_ledger(jsonb)'::regprocedure;
  IF function_owner <> 'platform_migrator' OR NOT function_definer THEN
    RAISE EXCEPTION 'ledger replay must be a migrator-owned SECURITY DEFINER function';
  END IF;
  IF has_table_privilege('platform_runtime','platform_deletion_ledger','SELECT')
     OR has_table_privilege('platform_runtime','platform_deletion_ledger','INSERT')
     OR has_table_privilege('platform_runtime','platform_deletion_ledger','UPDATE')
     OR has_table_privilege('platform_runtime','platform_deletion_ledger','DELETE') THEN
    RAISE EXCEPTION 'runtime must not directly access the global deletion ledger';
  END IF;
  IF has_function_privilege('platform_runtime','export_platform_deletion_ledger()','EXECUTE')
     OR has_function_privilege('platform_runtime','replay_platform_deletion_ledger(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'runtime must not export or replay the global deletion ledger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='workspaces_deletion_ledger')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='platform_users_deletion_ledger')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='provider_credentials_deletion_ledger')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='workspace_integrations_deletion_ledger')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='workspace_memberships_deletion_ledger')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='workspace_invitations_deletion_ledger')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='platform_administrators_deletion_ledger')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='platform_users_access_ledger')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='user_sessions_deletion_ledger')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='workspaces_access_ledger')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='workspace_support_access_deletion_ledger') THEN
    RAISE EXCEPTION 'one or more deletion/revocation ledger triggers are missing';
  END IF;
END $$;

INSERT INTO platform_users (id, twitch_user_id) VALUES
  ('73000000-0000-4000-8000-000000000001', '730001'),
  ('73000000-0000-4000-8000-000000000002', '730002'),
  ('73000000-0000-4000-8000-000000000003', '730003'),
  ('73000000-0000-4000-8000-000000000004', '730004');

INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES
  ('74000000-0000-4000-8000-000000000001', 'Deleted workspace fixture', '73000000-0000-4000-8000-000000000001', '730001'),
  ('74000000-0000-4000-8000-000000000002', 'Surviving workspace fixture', '73000000-0000-4000-8000-000000000002', '730002');

INSERT INTO workspace_memberships (id, workspace_id, user_id, role) VALUES
  ('75000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', 'owner'),
  ('75000000-0000-4000-8000-000000000002', '74000000-0000-4000-8000-000000000002', '73000000-0000-4000-8000-000000000002', 'owner'),
  ('75000000-0000-4000-8000-000000000003', '74000000-0000-4000-8000-000000000002', '73000000-0000-4000-8000-000000000003', 'moderator');

INSERT INTO user_sessions (user_id, session_token_hash, csrf_token_hash, expires_at)
VALUES (
  '73000000-0000-4000-8000-000000000002',
  repeat('a',64),
  repeat('b',64),
  now() + interval '1 day'
);

SELECT set_config('app.user_id','73000000-0000-4000-8000-000000000003',true);
SELECT set_config('app.platform_status_reason','ledger test restriction',true);
UPDATE workspaces
   SET status='restricted', restriction_reason='ledger test restriction', updated_at=now()
 WHERE id='74000000-0000-4000-8000-000000000002';
SELECT set_config('app.platform_status_reason','ledger test suspension',true);
UPDATE platform_users
   SET status='suspended', suspended_at=now(), suspension_reason='ledger test suspension', updated_at=now()
 WHERE id='73000000-0000-4000-8000-000000000002';
UPDATE user_sessions
   SET revoked_at=now()
 WHERE user_id='73000000-0000-4000-8000-000000000002';
SELECT set_config('app.platform_status_reason','ledger test reinstatement',true);
UPDATE platform_users
   SET status='active', suspended_at=NULL, suspension_reason=NULL, updated_at=now()
 WHERE id='73000000-0000-4000-8000-000000000002';
SELECT set_config('app.platform_status_reason','',true);
SELECT set_config('app.user_id','',true);

INSERT INTO workspace_support_access (
  id, workspace_id, support_user_id, support_twitch_user_id, granted_by_user_id,
  reason, scopes, created_at, expires_at
) VALUES (
  '79000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002',
  '73000000-0000-4000-8000-000000000003',
  '730003',
  '73000000-0000-4000-8000-000000000002',
  'ledger test support grant',
  ARRAY['workspace.read']::text[],
  now(),
  now() + interval '1 hour'
);

INSERT INTO provider_instances (
  id, workspace_id, provider_id, instance_key, contract_version
) VALUES (
  '76000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002',
  'spotify', 'ledger-test', 1
);
INSERT INTO provider_credentials (
  id, workspace_id, provider_instance_id, ciphertext, nonce, auth_tag,
  wrapped_dek, dek_nonce, dek_auth_tag, kek_version, format_version
) VALUES (
  '77000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000001',
  'ciphertext', 'nonce', 'auth-tag', 'wrapped', 'dek-nonce', 'dek-auth-tag',
  'test-key-v1', 1
);

INSERT INTO workspace_integrations (
  id, workspace_id, provider, status, external_account_id,
  credential_ciphertext, credential_nonce, credential_auth_tag,
  wrapped_dek, dek_nonce, dek_auth_tag, kek_version, credential_format_version
) VALUES (
  '78000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002',
  'twitch', 'connected', '730002',
  decode('01','hex'), decode('02','hex'), decode('03','hex'),
  decode('04','hex'), decode('05','hex'), decode('06','hex'),
  'test-key-v1', 1
);

-- Exercise independently revoked membership and credentials, followed by
-- permanent workspace/account deletion.
UPDATE workspace_memberships
   SET status='revoked', revoked_at=now(), updated_at=now()
 WHERE workspace_id='74000000-0000-4000-8000-000000000002'
   AND user_id='73000000-0000-4000-8000-000000000003';
DELETE FROM provider_credentials
 WHERE id='77000000-0000-4000-8000-000000000001';
UPDATE workspace_integrations
   SET status='disconnected', disconnected_at=now(), updated_at=now()
 WHERE id='78000000-0000-4000-8000-000000000001';
UPDATE workspace_support_access
   SET revoked_at=now(), revoked_by_user_id='73000000-0000-4000-8000-000000000004'
 WHERE id='79000000-0000-4000-8000-000000000001';
DELETE FROM platform_users WHERE id='73000000-0000-4000-8000-000000000004';
DELETE FROM workspaces WHERE id='74000000-0000-4000-8000-000000000001';
DELETE FROM platform_users WHERE id='73000000-0000-4000-8000-000000000001';

-- Simulate restoring a database snapshot taken before those operations. The
-- replay guard permits only this recovery simulation to reintroduce stale rows.
SELECT set_config('app.deletion_ledger_replay','on',true);
INSERT INTO platform_users (id, twitch_user_id)
VALUES ('73000000-0000-4000-8000-000000000001', '730001');
INSERT INTO platform_users (id, twitch_user_id)
VALUES ('73000000-0000-4000-8000-000000000004', '730004');
INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
VALUES (
  '74000000-0000-4000-8000-000000000001',
  'Restored stale workspace',
  '73000000-0000-4000-8000-000000000001',
  '730001'
);
INSERT INTO workspace_memberships (id, workspace_id, user_id, role)
VALUES (
  '75000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001',
  'owner'
);
UPDATE workspace_memberships
   SET status='active', revoked_at=NULL, updated_at=now()
 WHERE workspace_id='74000000-0000-4000-8000-000000000002'
   AND user_id='73000000-0000-4000-8000-000000000003';
INSERT INTO provider_credentials (
  id, workspace_id, provider_instance_id, ciphertext, nonce, auth_tag,
  wrapped_dek, dek_nonce, dek_auth_tag, kek_version, format_version
) VALUES (
  '77000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000001',
  'stale-ciphertext', 'nonce', 'auth-tag', 'wrapped', 'dek-nonce', 'dek-auth-tag',
  'test-key-v1', 1
);
UPDATE workspace_integrations
   SET status='connected', disconnected_at=NULL, updated_at=now()
 WHERE id='78000000-0000-4000-8000-000000000001';
INSERT INTO workspace_support_access (
  id, workspace_id, support_user_id, support_twitch_user_id, granted_by_user_id,
  reason, scopes, created_at, expires_at
) VALUES (
  '79000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002',
  '73000000-0000-4000-8000-000000000003',
  '730003',
  '73000000-0000-4000-8000-000000000002',
  'stale support grant',
  ARRAY['workspace.read']::text[],
  now(),
  now() + interval '1 hour'
);
UPDATE workspace_support_access
   SET revoked_at=NULL, revoked_by_user_id=NULL
 WHERE id='79000000-0000-4000-8000-000000000001';
UPDATE workspaces
   SET status='active', restriction_reason=NULL, updated_at=now()
 WHERE id='74000000-0000-4000-8000-000000000002';
UPDATE platform_users
   SET status='active', suspended_at=NULL, suspension_reason=NULL, updated_at=now()
 WHERE id='73000000-0000-4000-8000-000000000002';
UPDATE user_sessions SET revoked_at=NULL
 WHERE user_id='73000000-0000-4000-8000-000000000002';
SELECT set_config('app.deletion_ledger_replay','',true);

SET LOCAL ROLE platform_migrator;
SELECT replay_platform_deletion_ledger(export_platform_deletion_ledger());
-- A second pass must be idempotent and preserve the same journal.
SELECT replay_platform_deletion_ledger(export_platform_deletion_ledger());
DO $$
BEGIN
  BEGIN
    UPDATE platform_deletion_ledger
       SET metadata = metadata || '{"tampered":true}'::jsonb
     WHERE entry_id = (SELECT min(entry_id) FROM platform_deletion_ledger);
    RAISE EXCEPTION 'append-only deletion ledger accepted an update';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_users WHERE id='73000000-0000-4000-8000-000000000001'
      OR twitch_user_id='730001') THEN
    RAISE EXCEPTION 'deleted user was resurrected by restore replay';
  END IF;
  IF EXISTS (SELECT 1 FROM platform_users WHERE id='73000000-0000-4000-8000-000000000004'
      OR twitch_user_id='730004') THEN
    RAISE EXCEPTION 'deleted support-access revoker was resurrected by restore replay';
  END IF;
  IF EXISTS (SELECT 1 FROM workspaces WHERE id='74000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'deleted workspace was resurrected by restore replay';
  END IF;
  IF EXISTS (SELECT 1 FROM provider_credentials WHERE id='77000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'revoked provider credential was resurrected by restore replay';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workspace_integrations
     WHERE id='78000000-0000-4000-8000-000000000001'
       AND credential_ciphertext IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM workspace_integrations
     WHERE id='78000000-0000-4000-8000-000000000001'
       AND status='disconnected' AND credential_ciphertext IS NULL
  ) THEN
    RAISE EXCEPTION 'revoked Twitch integration credential was resurrected by restore replay';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspaces
     WHERE id='74000000-0000-4000-8000-000000000002'
       AND status='restricted' AND restriction_reason='ledger test restriction'
  ) THEN
    RAISE EXCEPTION 'workspace restriction was resurrected by restore replay';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM platform_users
     WHERE id='73000000-0000-4000-8000-000000000002'
       AND status='active' AND suspended_at IS NULL AND suspension_reason IS NULL
  ) THEN
    RAISE EXCEPTION 'latest account reinstatement state was not restored';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM user_sessions
     WHERE user_id='73000000-0000-4000-8000-000000000002'
       AND revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'suspended account session was resurrected by restore replay';
  END IF;
  IF EXISTS (SELECT 1 FROM workspace_support_access WHERE id='79000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'revoked support access was resurrected by restore replay';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspace_memberships
     WHERE workspace_id='74000000-0000-4000-8000-000000000002'
       AND user_id='73000000-0000-4000-8000-000000000003'
       AND status='revoked'
  ) THEN
    RAISE EXCEPTION 'revoked workspace access was resurrected by restore replay';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform_deletion_ledger WHERE event_type='workspace.deleted')
     OR NOT EXISTS (SELECT 1 FROM platform_deletion_ledger WHERE event_type='user.deleted')
     OR NOT EXISTS (SELECT 1 FROM platform_deletion_ledger WHERE event_type='credential.revoked')
     OR NOT EXISTS (SELECT 1 FROM platform_deletion_ledger WHERE event_type='membership.revoked')
     OR NOT EXISTS (SELECT 1 FROM platform_deletion_ledger WHERE event_type='support_access.revoked')
     OR NOT EXISTS (SELECT 1 FROM platform_deletion_ledger WHERE event_type='workspace.access.revoked')
     OR NOT EXISTS (SELECT 1 FROM platform_deletion_ledger WHERE event_type='user.access.revoked')
     OR NOT EXISTS (SELECT 1 FROM platform_deletion_ledger WHERE event_type='user.access.granted')
     OR NOT EXISTS (SELECT 1 FROM platform_deletion_ledger WHERE event_type='session.revoked') THEN
    RAISE EXCEPTION 'expected deletion and revocation events were not persisted';
  END IF;
END $$;

-- Once the external ledger has been replayed, normal writes cannot recreate
-- permanent user, workspace, or credential identities from stale data.
DO $$
BEGIN
  BEGIN
    INSERT INTO platform_users (id, twitch_user_id)
    VALUES ('73000000-0000-4000-8000-000000000004', '730001');
    RAISE EXCEPTION 'deleted Twitch identity was allowed to sign up again';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (
      '74000000-0000-4000-8000-000000000001',
      'Resurrection attempt',
      '73000000-0000-4000-8000-000000000002',
      '730002'
    );
    RAISE EXCEPTION 'deleted workspace ID was allowed to be reused';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO provider_credentials (
      id, workspace_id, provider_instance_id, ciphertext, nonce, auth_tag,
      wrapped_dek, dek_nonce, dek_auth_tag, kek_version, format_version
    ) VALUES (
      '77000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000002',
      '76000000-0000-4000-8000-000000000001',
      'ciphertext', 'nonce', 'auth-tag', 'wrapped', 'dek-nonce', 'dek-auth-tag',
      'test-key-v1', 1
    );
    RAISE EXCEPTION 'revoked credential ID was allowed to be reused';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
