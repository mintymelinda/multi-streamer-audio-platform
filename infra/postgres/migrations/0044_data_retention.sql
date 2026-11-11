-- Phase 7 item 61: explicit retention classes and bounded, tenant-safe cleanup.
ALTER TABLE workspace_request_settings
  ADD COLUMN history_retention_days integer NOT NULL DEFAULT 14
    CHECK (history_retention_days IN (7, 14, 30, 90, 180, 365));

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_request_settings','media_requests','provider_execution_states',
    'playback_operations','playback_leases','twitch_eventsub_deliveries',
    'outbox_events','user_notifications','user_notification_preferences',
    'email_outbox','user_data_exports'
  ] LOOP
    EXECUTE format('CREATE POLICY %I ON %I TO platform_migrator USING (true) WITH CHECK (true)',
      table_name || '_retention_maintenance', table_name);
  END LOOP;
END $$;

CREATE FUNCTION run_platform_retention()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $retention$
DECLARE
  expired_requests integer := 0;
  expired_provider_states integer := 0;
  expired_playback_operations integer := 0;
  expired_leases integer := 0;
  expired_eventsub_deliveries integer := 0;
  expired_outbox_events integer := 0;
  expired_notifications integer := 0;
  expired_email_outbox integer := 0;
  expired_export_payloads integer := 0;
  expired_export_records integer := 0;
BEGIN
  WITH doomed AS (
    SELECT r.id FROM media_requests r
    LEFT JOIN workspace_request_settings s ON s.workspace_id = r.workspace_id
    WHERE r.status IN ('completed','rejected','cancelled','failed','skipped')
      AND COALESCE(r.completed_at,r.updated_at) <
          now() - make_interval(days => COALESCE(s.history_retention_days,14))
    ORDER BY COALESCE(r.completed_at,r.updated_at),r.id LIMIT 5000
  )
  DELETE FROM media_requests r USING doomed d WHERE r.id=d.id;
  GET DIAGNOSTICS expired_requests = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM provider_execution_states
    WHERE state IN ('completed','failed','cancelled') AND updated_at < now()-interval '30 days'
    ORDER BY updated_at,id LIMIT 5000
  )
  DELETE FROM provider_execution_states s USING doomed d WHERE s.id=d.id;
  GET DIAGNOSTICS expired_provider_states = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM playback_operations
    WHERE status IN ('completed','failed','reconciled') AND updated_at < now()-interval '30 days'
    ORDER BY updated_at,id LIMIT 5000
  )
  DELETE FROM playback_operations p USING doomed d WHERE p.id=d.id;
  GET DIAGNOSTICS expired_playback_operations = ROW_COUNT;

  WITH doomed AS (
    SELECT workspace_id,provider_instance_id,player_id FROM playback_leases
    WHERE expires_at < now()-interval '1 day'
    ORDER BY expires_at LIMIT 5000
  )
  DELETE FROM playback_leases p USING doomed d
   WHERE p.workspace_id=d.workspace_id AND p.provider_instance_id=d.provider_instance_id
     AND p.player_id=d.player_id;
  GET DIAGNOSTICS expired_leases = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM twitch_eventsub_deliveries
    WHERE status IN ('processed','dismissed') AND received_at < now()-interval '30 days'
    ORDER BY received_at,id LIMIT 5000
  )
  DELETE FROM twitch_eventsub_deliveries e USING doomed d WHERE e.id=d.id;
  GET DIAGNOSTICS expired_eventsub_deliveries = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM outbox_events
    WHERE published_at IS NOT NULL AND published_at < now()-interval '30 days'
    ORDER BY published_at,id LIMIT 5000
  )
  DELETE FROM outbox_events o USING doomed d WHERE o.id=d.id;
  GET DIAGNOSTICS expired_outbox_events = ROW_COUNT;

  WITH doomed AS (
    SELECT n.id FROM user_notifications n
    LEFT JOIN user_notification_preferences p ON p.user_id=n.recipient_user_id
    WHERE n.category NOT IN ('account','security')
      AND n.created_at < now()-make_interval(days => COALESCE(p.retention_days,90))
    ORDER BY n.created_at,n.id LIMIT 5000
  )
  DELETE FROM user_notifications n USING doomed d WHERE n.id=d.id;
  GET DIAGNOSTICS expired_notifications = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM email_outbox WHERE status IN ('sent','failed')
      AND created_at < now()-interval '30 days'
    ORDER BY created_at,id LIMIT 5000
  )
  DELETE FROM email_outbox e USING doomed d WHERE e.id=d.id;
  GET DIAGNOSTICS expired_email_outbox = ROW_COUNT;

  UPDATE user_data_exports SET status='expired',export_data=NULL,locked_at=NULL
  WHERE id IN (
    SELECT id FROM user_data_exports
    WHERE status='completed' AND expires_at<=now()
    ORDER BY expires_at LIMIT 5000
  );
  GET DIAGNOSTICS expired_export_payloads = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM user_data_exports WHERE status IN ('expired','failed')
      AND requested_at < now()-interval '30 days'
    ORDER BY requested_at,id LIMIT 5000
  )
  DELETE FROM user_data_exports e USING doomed d WHERE e.id=d.id;
  GET DIAGNOSTICS expired_export_records = ROW_COUNT;

  RETURN jsonb_build_object(
    'requests',expired_requests,'providerExecutionStates',expired_provider_states,
    'playbackOperations',expired_playback_operations,'playbackLeases',expired_leases,
    'eventSubDeliveries',expired_eventsub_deliveries,'publishedOutboxEvents',expired_outbox_events,
    'notifications',expired_notifications,'emailOutbox',expired_email_outbox,
    'exportPayloads',expired_export_payloads,'exportRecords',expired_export_records
  );
END;
$retention$;

ALTER FUNCTION run_platform_retention() OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION run_platform_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_platform_retention() TO platform_worker;
