-- Phase 6 item 59: planned maintenance notices and advance recipient notifications.
BEGIN;

CREATE TABLE platform_planned_maintenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 5 AND 160),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 10 AND 2000),
  expected_impact text NOT NULL CHECK (length(btrim(expected_impact)) BETWEEN 5 AND 1000),
  affected_services text[] NOT NULL CHECK (
    cardinality(affected_services) BETWEEN 1 AND 9
    AND affected_services <@ ARRAY[
      'all', 'api', 'dashboard', 'overlay', 'playback',
      'authentication', 'twitch', 'spotify', 'lyrion'
    ]::text[]
  ),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  cancelled_at timestamptz,
  created_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX platform_planned_maintenance_window
  ON platform_planned_maintenance (starts_at, ends_at)
  WHERE cancelled_at IS NULL;
REVOKE ALL ON platform_planned_maintenance FROM PUBLIC, platform_runtime, platform_worker;

-- The SECURITY DEFINER maintenance functions need to enumerate active account
-- IDs for recipient fan-out, but do not expose those records to the API.
CREATE POLICY platform_users_maintenance_recipient_scan
  ON platform_users FOR SELECT TO platform_runtime
  USING (platform_has_permission('status.manage'));

CREATE FUNCTION list_public_planned_maintenance()
RETURNS TABLE (
  id uuid, title text, summary text, expected_impact text,
  affected_services text[], starts_at timestamptz, ends_at timestamptz,
  created_at timestamptz, updated_at timestamptz, state text
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $public_maintenance$
  SELECT m.id, m.title, m.summary, m.expected_impact, m.affected_services,
         m.starts_at, m.ends_at, m.created_at, m.updated_at,
         CASE WHEN m.starts_at > now() THEN 'scheduled'
              WHEN m.ends_at IS NOT NULL AND m.ends_at <= now() THEN 'completed'
              ELSE 'in_progress' END
    FROM public.platform_planned_maintenance m
   WHERE m.cancelled_at IS NULL
     AND (m.ends_at IS NULL OR m.ends_at >= now() - interval '7 days')
   ORDER BY m.starts_at ASC LIMIT 100
$public_maintenance$;

CREATE FUNCTION list_platform_planned_maintenance()
RETURNS TABLE (
  id uuid, title text, summary text, expected_impact text,
  affected_services text[], starts_at timestamptz, ends_at timestamptz,
  created_at timestamptz, updated_at timestamptz, cancelled_at timestamptz, state text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $admin_maintenance$
BEGIN
  PERFORM public.require_platform_permission('status.manage');
  RETURN QUERY
    SELECT m.id, m.title, m.summary, m.expected_impact, m.affected_services,
           m.starts_at, m.ends_at, m.created_at, m.updated_at, m.cancelled_at,
           CASE WHEN m.cancelled_at IS NOT NULL THEN 'cancelled'
                WHEN m.starts_at > now() THEN 'scheduled'
                WHEN m.ends_at IS NOT NULL AND m.ends_at <= now() THEN 'completed'
                ELSE 'in_progress' END
      FROM public.platform_planned_maintenance m
     ORDER BY m.starts_at DESC LIMIT 200;
END;
$admin_maintenance$;

CREATE FUNCTION set_platform_planned_maintenance(
  target_id uuid, maintenance_title text, maintenance_summary text,
  impact_description text, services text[], start_time timestamptz, end_time timestamptz
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $save_maintenance$
DECLARE
  actor_id uuid := public.require_platform_permission('status.manage');
  saved_id uuid;
  revision integer;
  recipient record;
  notice_title text;
  notice_body text;
BEGIN
  IF maintenance_title IS NULL OR length(btrim(maintenance_title)) NOT BETWEEN 5 AND 160
     OR maintenance_summary IS NULL OR length(btrim(maintenance_summary)) NOT BETWEEN 10 AND 2000
     OR impact_description IS NULL OR length(btrim(impact_description)) NOT BETWEEN 5 AND 1000
     OR services IS NULL OR cardinality(services) NOT BETWEEN 1 AND 9
     OR NOT (services <@ ARRAY[
       'all', 'api', 'dashboard', 'overlay', 'playback',
       'authentication', 'twitch', 'spotify', 'lyrion'
     ]::text[])
     OR start_time IS NULL OR start_time <= now()
     OR (end_time IS NOT NULL AND end_time <= start_time) THEN
    RAISE EXCEPTION 'valid future maintenance window, impact, and affected services are required'
      USING ERRCODE = '22023';
  END IF;

  IF target_id IS NULL THEN
    INSERT INTO public.platform_planned_maintenance (
      title, summary, expected_impact, affected_services, starts_at, ends_at,
      created_by_user_id, updated_by_user_id
    ) VALUES (
      btrim(maintenance_title), btrim(maintenance_summary), btrim(impact_description),
      services, start_time, end_time, actor_id, actor_id
    ) RETURNING id INTO saved_id;
    revision := 1;
  ELSE
    UPDATE public.platform_planned_maintenance
       SET title = btrim(maintenance_title), summary = btrim(maintenance_summary),
           expected_impact = btrim(impact_description), affected_services = services,
           starts_at = start_time, ends_at = end_time,
           updated_by_user_id = actor_id, updated_at = now()
     WHERE id = target_id AND cancelled_at IS NULL
     RETURNING id INTO saved_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'planned maintenance was not found or has been cancelled'
        USING ERRCODE = 'P0002';
    END IF;
    revision := 2;
  END IF;

  notice_title := 'Planned maintenance: ' || btrim(maintenance_title);
  notice_body := btrim(maintenance_summary) || E'\n\nExpected impact: ' ||
    btrim(impact_description) || E'\n\nScheduled start: ' ||
    to_char(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' ||
    CASE WHEN end_time IS NULL THEN '' ELSE E'\nScheduled end: ' ||
      to_char(end_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' END;

  FOR recipient IN
    SELECT u.id AS user_id, e.email_address
      FROM public.platform_users u
      LEFT JOIN public.user_notification_email_settings e
        ON e.user_id = u.id AND e.verified_at IS NOT NULL AND e.email_enabled = true
       AND e.category_preferences ->> 'platform' = 'true'
       AND e.priority_preferences ->> 'high' = 'true'
     WHERE u.status = 'active'
  LOOP
    PERFORM set_config('app.user_id', recipient.user_id::text, true);
    INSERT INTO public.user_notifications (
      recipient_user_id, category, priority, event_type, title, body, href, group_key
    ) VALUES (
      recipient.user_id, 'platform', 'high', 'planned_maintenance.scheduled',
      notice_title, notice_body, '/status', 'planned-maintenance:' || saved_id::text
    );

    IF recipient.email_address IS NOT NULL THEN
      INSERT INTO public.email_outbox (
        user_id, notification_id, recipient_email, subject, text_body, html_body, unique_key
      )
      SELECT recipient.user_id, n.id, recipient.email_address, notice_title,
             notice_body,
             '<h2>' || replace(replace(replace(notice_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') ||
             '</h2><p>' || replace(replace(replace(notice_body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>',
             'planned-maintenance:' || saved_id::text || ':' || recipient.user_id::text || ':' || revision::text
        FROM public.user_notifications n
       WHERE n.recipient_user_id = recipient.user_id
         AND n.event_type = 'planned_maintenance.scheduled'
         AND n.group_key = 'planned-maintenance:' || saved_id::text
       ORDER BY n.created_at DESC LIMIT 1
      ON CONFLICT (unique_key) DO NOTHING;
    END IF;
  END LOOP;
  PERFORM set_config('app.user_id', actor_id::text, true);

  INSERT INTO public.platform_administration_audit (actor_user_id, action, reason, details)
  VALUES (
    actor_id,
    CASE WHEN target_id IS NULL THEN 'planned_maintenance.created' ELSE 'planned_maintenance.updated' END,
    CASE WHEN target_id IS NULL THEN 'Planned maintenance notice published' ELSE 'Planned maintenance notice updated' END,
    jsonb_build_object('maintenance_id', saved_id, 'title', btrim(maintenance_title),
      'affected_services', services, 'starts_at', start_time, 'ends_at', end_time,
      'notification_revision', revision)
  );
  RETURN saved_id;
END;
$save_maintenance$;

CREATE FUNCTION cancel_platform_planned_maintenance(target_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $cancel_maintenance$
DECLARE
  actor_id uuid := public.require_platform_permission('status.manage');
  saved record;
  recipient record;
BEGIN
  UPDATE public.platform_planned_maintenance
     SET cancelled_at = now(), updated_at = now(), updated_by_user_id = actor_id
   WHERE id = target_id AND cancelled_at IS NULL
   RETURNING id, title INTO saved;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'planned maintenance was not found or is already cancelled'
      USING ERRCODE = 'P0002';
  END IF;

  FOR recipient IN
    SELECT DISTINCT u.id AS user_id
      FROM public.platform_users u
     WHERE u.status = 'active'
       AND EXISTS (
         SELECT 1 FROM public.user_notifications n
          WHERE n.recipient_user_id = u.id
            AND n.group_key = 'planned-maintenance:' || saved.id::text
       )
  LOOP
    PERFORM set_config('app.user_id', recipient.user_id::text, true);
    INSERT INTO public.user_notifications (
      recipient_user_id, category, priority, event_type, title, body, href, group_key
    ) VALUES (
      recipient.user_id, 'platform', 'high', 'planned_maintenance.cancelled',
      'Planned maintenance cancelled: ' || saved.title,
      'The previously announced maintenance has been cancelled. No interruption is expected from this operation.',
      '/status', 'planned-maintenance-cancelled:' || saved.id::text
    );
  END LOOP;
  PERFORM set_config('app.user_id', actor_id::text, true);

  INSERT INTO public.platform_administration_audit (actor_user_id, action, reason, details)
  VALUES (actor_id, 'planned_maintenance.cancelled', 'Planned maintenance notice cancelled',
          jsonb_build_object('maintenance_id', saved.id, 'title', saved.title));
  RETURN true;
END;
$cancel_maintenance$;

REVOKE ALL ON FUNCTION list_public_planned_maintenance() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_platform_planned_maintenance() FROM PUBLIC;
REVOKE ALL ON FUNCTION set_platform_planned_maintenance(uuid, text, text, text, text[], timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_platform_planned_maintenance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_public_planned_maintenance() TO platform_runtime;
GRANT EXECUTE ON FUNCTION list_platform_planned_maintenance() TO platform_runtime;
GRANT EXECUTE ON FUNCTION set_platform_planned_maintenance(uuid, text, text, text, text[], timestamptz, timestamptz) TO platform_runtime;
GRANT EXECUTE ON FUNCTION cancel_platform_planned_maintenance(uuid) TO platform_runtime;

COMMIT;
