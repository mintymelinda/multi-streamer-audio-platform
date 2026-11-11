-- Platform administration uses a separate role and narrowly scoped permissions.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  owner_id uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  target_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO platform_users (id, twitch_user_id)
  VALUES
    (owner_id, '980000010'),
    (admin_id, '980000011'),
    (target_id, '980000012');

  INSERT INTO platform_administrators (user_id, role)
  VALUES (owner_id, 'owner');

  INSERT INTO platform_administrators (user_id, role, permissions, appointed_by_user_id)
  VALUES (
    admin_id,
    'admin',
    ARRAY['administrators.read', 'administrators.manage', 'accounts.read'],
    owner_id
  );

  PERFORM set_config('test.platform_owner_id', owner_id::text, true);
  PERFORM set_config('test.platform_admin_id', admin_id::text, true);
END;
$$;

SET LOCAL ROLE platform_runtime;

DO $$
DECLARE
  owner_id uuid := current_setting('test.platform_owner_id')::uuid;
  admin_id uuid := current_setting('test.platform_admin_id')::uuid;
  access_role platform_administrator_role;
  listed_count integer;
BEGIN
  IF has_table_privilege(current_user, 'public.platform_administrators', 'SELECT')
     OR has_table_privilege(current_user, 'public.platform_administrators', 'INSERT')
     OR has_table_privilege(current_user, 'public.platform_administration_audit', 'SELECT')
     OR has_table_privilege(current_user, 'public.platform_administration_audit', 'INSERT') THEN
    RAISE EXCEPTION 'runtime role can directly access protected platform administration tables';
  END IF;

  PERFORM set_config('app.user_id', owner_id::text, true);
  SELECT role INTO access_role FROM get_current_platform_administrator();
  IF access_role <> 'owner' THEN
    RAISE EXCEPTION 'platform owner access lookup failed';
  END IF;

  SELECT count(*) INTO listed_count FROM list_platform_administrators();
  IF listed_count <> 2 THEN
    RAISE EXCEPTION 'platform owner cannot list the administrator directory';
  END IF;

  BEGIN
    PERFORM revoke_platform_administrator(owner_id, 'final owner protection test');
    RAISE EXCEPTION 'the final platform owner was revoked';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  PERFORM set_config('app.user_id', admin_id::text, true);
  SELECT role INTO access_role FROM get_current_platform_administrator();
  IF access_role <> 'admin' THEN
    RAISE EXCEPTION 'platform administrator access lookup failed';
  END IF;

  SELECT count(*) INTO listed_count FROM list_platform_administrators();
  IF listed_count <> 2 THEN
    RAISE EXCEPTION 'administrator with directory permission cannot list assignments';
  END IF;

  PERFORM set_config('app.user_id', (SELECT id::text FROM platform_users WHERE twitch_user_id = '980000012'), true);
  IF EXISTS (SELECT 1 FROM get_current_platform_administrator()) THEN
    RAISE EXCEPTION 'ordinary platform account received administrator access';
  END IF;
  BEGIN
    PERFORM * FROM list_platform_administrators();
    RAISE EXCEPTION 'ordinary platform account read the administrator directory';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM set_config('app.user_id', admin_id::text, true);

  BEGIN
    PERFORM appoint_platform_administrator(
      '980000012', 'owner', ARRAY['administrators.read'], 'must not escalate to owner'
    );
    RAISE EXCEPTION 'administrator appointed a platform owner';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM appoint_platform_administrator(
      '980000010', 'admin', ARRAY['administrators.read'], 'must not demote an owner'
    );
    RAISE EXCEPTION 'administrator changed an owner assignment';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM appoint_platform_administrator(
      '980000012', 'admin', ARRAY['settings.write'], 'must not grant unheld permission'
    );
    RAISE EXCEPTION 'administrator granted a permission they do not hold';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM appoint_platform_administrator(
    '980000012',
    'admin',
    ARRAY['administrators.read', 'accounts.read'],
    'grant only held permissions'
  );

  SELECT count(*) INTO listed_count
    FROM list_platform_administrators()
   WHERE twitch_user_id = '980000012'
     AND role = 'admin'
     AND permissions = ARRAY['administrators.read', 'accounts.read'];
  IF listed_count <> 1 THEN
    RAISE EXCEPTION 'administrator appointment did not persist the scoped permissions';
  END;

  BEGIN
    PERFORM revoke_platform_administrator(owner_id, 'administrator cannot revoke owner');
    RAISE EXCEPTION 'administrator revoked a platform owner';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

ROLLBACK;
