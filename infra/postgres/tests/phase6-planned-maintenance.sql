-- Phase 6 item 59: planned maintenance is curated, permission-gated, and notified.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  admin_id uuid := gen_random_uuid();
  recipient_id uuid := gen_random_uuid();
  ordinary_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO platform_users (id, twitch_user_id)
  VALUES (admin_id, '980000061'), (recipient_id, '980000062'), (ordinary_id, '980000063');
  INSERT INTO platform_administrators (user_id, twitch_user_id, role, permissions)
  VALUES (admin_id, '980000061', 'admin', ARRAY['status.manage']);
  PERFORM set_config('test.maintenance_admin_id', admin_id::text, true);
  PERFORM set_config('test.maintenance_recipient_id', recipient_id::text, true);
  PERFORM set_config('test.maintenance_ordinary_id', ordinary_id::text, true);
END;
$$;

SET LOCAL ROLE platform_runtime;

DO $$
DECLARE
  admin_id uuid := current_setting('test.maintenance_admin_id')::uuid;
  recipient_id uuid := current_setting('test.maintenance_recipient_id')::uuid;
  ordinary_id uuid := current_setting('test.maintenance_ordinary_id')::uuid;
  maintenance_id uuid;
  visible_count integer;
BEGIN
  IF has_table_privilege(current_user, 'public.platform_planned_maintenance', 'SELECT')
     OR has_table_privilege(current_user, 'public.platform_planned_maintenance', 'INSERT')
     OR has_table_privilege(current_user, 'public.platform_planned_maintenance', 'UPDATE') THEN
    RAISE EXCEPTION 'runtime role can access planned maintenance table directly';
  END IF;

  PERFORM set_config('app.user_id', ordinary_id::text, true);
  BEGIN
    PERFORM * FROM list_platform_planned_maintenance();
    RAISE EXCEPTION 'ordinary account received maintenance administration access';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM set_config('app.user_id', admin_id::text, true);
  SELECT set_platform_planned_maintenance(
    NULL, 'Database maintenance window',
    'The database will be upgraded during this window.',
    'Dashboard and playback requests may be unavailable for up to 20 minutes.',
    ARRAY['api', 'dashboard', 'playback'],
    now() + interval '2 days', now() + interval '2 days 20 minutes'
  ) INTO maintenance_id;

  SELECT count(*) INTO visible_count FROM list_public_planned_maintenance()
   WHERE id = maintenance_id AND state = 'scheduled'
     AND expected_impact LIKE '%20 minutes%';
  IF visible_count <> 1 THEN RAISE EXCEPTION 'published maintenance was not visible in public status'; END IF;

  PERFORM set_config('app.user_id', recipient_id::text, true);
  SELECT count(*) INTO visible_count FROM user_notifications
   WHERE event_type = 'planned_maintenance.scheduled'
     AND title = 'Planned maintenance: Database maintenance window';
  IF visible_count <> 1 THEN RAISE EXCEPTION 'advance maintenance notification was not delivered to recipient inbox'; END IF;

  PERFORM set_config('app.user_id', admin_id::text, true);
  SELECT count(*) INTO visible_count FROM list_platform_planned_maintenance() WHERE id = maintenance_id;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'administrator cannot list planned maintenance'; END IF;

  PERFORM cancel_platform_planned_maintenance(maintenance_id);
  PERFORM set_config('app.user_id', recipient_id::text, true);
  SELECT count(*) INTO visible_count FROM user_notifications
   WHERE event_type = 'planned_maintenance.cancelled'
     AND title = 'Planned maintenance cancelled: Database maintenance window';
  IF visible_count <> 1 THEN RAISE EXCEPTION 'maintenance cancellation notice was not delivered'; END IF;

  SELECT count(*) INTO visible_count FROM list_public_planned_maintenance() WHERE id = maintenance_id;
  IF visible_count <> 0 THEN RAISE EXCEPTION 'cancelled maintenance remains public'; END IF;
END;
$$;

RESET ROLE;

DO $$
DECLARE audit_count integer;
BEGIN
  SELECT count(*) INTO audit_count FROM platform_administration_audit
   WHERE action IN ('planned_maintenance.created', 'planned_maintenance.cancelled')
     AND details->>'title' = 'Database maintenance window';
  IF audit_count <> 2 THEN RAISE EXCEPTION 'maintenance publication and cancellation were not audited'; END IF;
END;
$$;

ROLLBACK;
