-- Phase 6 item 58: public status exposes curated incidents and administration is scoped/audited.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  admin_id uuid := gen_random_uuid();
  ordinary_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO platform_users (id, twitch_user_id)
  VALUES (admin_id, '980000058'), (ordinary_id, '980000059');

  INSERT INTO platform_administrators (user_id, twitch_user_id, role, permissions)
  VALUES (admin_id, '980000058', 'admin', ARRAY['status.manage']);

  PERFORM set_config('test.service_status_admin_id', admin_id::text, true);
  PERFORM set_config('test.service_status_ordinary_id', ordinary_id::text, true);
END;
$$;

SET LOCAL ROLE platform_runtime;

DO $$
DECLARE
  admin_id uuid := current_setting('test.service_status_admin_id')::uuid;
  ordinary_id uuid := current_setting('test.service_status_ordinary_id')::uuid;
  incident_id uuid;
  visible_count integer;
  active_count integer;
BEGIN
  IF has_table_privilege(current_user, 'public.platform_service_incidents', 'SELECT')
     OR has_table_privilege(current_user, 'public.platform_service_incidents', 'INSERT')
     OR has_table_privilege(current_user, 'public.platform_service_incidents', 'UPDATE') THEN
    RAISE EXCEPTION 'runtime role can access service incident table directly';
  END IF;

  PERFORM set_config('app.user_id', ordinary_id::text, true);
  SELECT count(*) INTO visible_count FROM list_public_service_incidents();
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'unexpected public incidents in isolated test';
  END IF;

  BEGIN
    PERFORM * FROM list_platform_service_incidents();
    RAISE EXCEPTION 'ordinary account received incident administration access';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM set_config('app.user_id', admin_id::text, true);
  SELECT set_platform_service_incident(
    NULL,
    'Dashboard response delays',
    'Some dashboard requests are taking longer than usual.',
    'investigating',
    'degraded',
    ARRAY['dashboard', 'api']
  ) INTO incident_id;

  SELECT count(*) INTO visible_count
    FROM list_public_service_incidents()
   WHERE id = incident_id
     AND status = 'investigating'
     AND affected_services = ARRAY['dashboard', 'api'];
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'published incident was not visible through the curated public function';
  END IF;

  PERFORM set_platform_service_incident(
    incident_id,
    'Dashboard response delays',
    'The cause has been identified and a fix is being prepared.',
    'identified',
    'degraded',
    ARRAY['dashboard', 'api']
  );
  PERFORM set_platform_service_incident(
    incident_id,
    'Dashboard response delays',
    'A fix is deployed and we are monitoring recovery.',
    'monitoring',
    'degraded',
    ARRAY['dashboard', 'api']
  );
  PERFORM set_platform_service_incident(
    incident_id,
    'Dashboard response delays',
    'The dashboard has returned to normal operation.',
    'resolved',
    'degraded',
    ARRAY['dashboard', 'api']
  );

  SELECT count(*) INTO active_count
    FROM list_public_service_incidents()
   WHERE id = incident_id AND status = 'resolved' AND resolved_at IS NOT NULL;
  IF active_count <> 1 THEN
    RAISE EXCEPTION 'resolved incident was not retained in public incident history';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM list_platform_service_incidents()
     WHERE id = incident_id AND status = 'resolved'
  ) THEN
    RAISE EXCEPTION 'status administrator cannot view incident history';
  END IF;
END;
$$;

RESET ROLE;

DO $$
DECLARE
  incident_count integer;
BEGIN
  SELECT count(*) INTO incident_count
    FROM platform_administration_audit
   WHERE action IN ('service_incident.created', 'service_incident.updated')
     AND details->>'title' = 'Dashboard response delays';
  IF incident_count <> 4 THEN
    RAISE EXCEPTION 'incident creation and each public update were not audited';
  END IF;
END;
$$;

ROLLBACK;
