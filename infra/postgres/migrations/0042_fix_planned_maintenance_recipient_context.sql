-- Phase 6 item 59: materialize recipient IDs before changing transaction-local RLS identity.
CREATE OR REPLACE FUNCTION set_platform_planned_maintenance(
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
  recipient_user_id uuid;
  recipient_email text;
  recipient_ids uuid[];
  notification_id uuid;
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

  SELECT array_agg(r.user_id) INTO recipient_ids
    FROM public.platform_notification_recipients r WHERE r.active = true;

  FOREACH recipient_user_id IN ARRAY COALESCE(recipient_ids, ARRAY[]::uuid[])
  LOOP
    PERFORM set_config('app.user_id', recipient_user_id::text, true);
    SELECT e.email_address INTO recipient_email
      FROM public.user_notification_email_settings e
     WHERE e.user_id = recipient_user_id AND e.verified_at IS NOT NULL
       AND e.email_enabled = true
       AND e.category_preferences ->> 'platform' = 'true'
       AND e.priority_preferences ->> 'high' = 'true';

    INSERT INTO public.user_notifications (
      recipient_user_id, category, priority, event_type, title, body, href, group_key
    ) VALUES (
      recipient_user_id, 'platform', 'high', 'planned_maintenance.scheduled',
      notice_title, notice_body, '/status', 'planned-maintenance:' || saved_id::text
    ) RETURNING id INTO notification_id;

    IF recipient_email IS NOT NULL THEN
      INSERT INTO public.email_outbox (
        user_id, notification_id, recipient_email, subject, text_body, html_body, unique_key
      ) VALUES (
        recipient_user_id, notification_id, recipient_email, notice_title, notice_body,
        '<h2>' || replace(replace(replace(notice_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') ||
        '</h2><p>' || replace(replace(replace(notice_body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>',
        'planned-maintenance:' || saved_id::text || ':' || notification_id::text
      ) ON CONFLICT (unique_key) DO NOTHING;
    END IF;
    recipient_email := NULL;
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

CREATE OR REPLACE FUNCTION cancel_platform_planned_maintenance(target_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $cancel_maintenance$
DECLARE
  actor_id uuid := public.require_platform_permission('status.manage');
  saved record;
  recipient_user_id uuid;
  recipient_ids uuid[];
BEGIN
  UPDATE public.platform_planned_maintenance
     SET cancelled_at = now(), updated_at = now(), updated_by_user_id = actor_id
   WHERE id = target_id AND cancelled_at IS NULL
   RETURNING id, title INTO saved;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'planned maintenance was not found or is already cancelled'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT array_agg(r.user_id) INTO recipient_ids
    FROM public.platform_notification_recipients r WHERE r.active = true;
  FOREACH recipient_user_id IN ARRAY COALESCE(recipient_ids, ARRAY[]::uuid[])
  LOOP
    PERFORM set_config('app.user_id', recipient_user_id::text, true);
    INSERT INTO public.user_notifications (
      recipient_user_id, category, priority, event_type, title, body, href, group_key
    ) VALUES (
      recipient_user_id, 'platform', 'high', 'planned_maintenance.cancelled',
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
