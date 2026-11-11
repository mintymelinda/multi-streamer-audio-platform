-- Phase 7 item 62: owner-only workspace export and permanent deletion.
-- The migrator can read tenant rows only inside the SECURITY DEFINER export function.
DO $$
DECLARE table_name text;
BEGIN
  FOR table_name IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='workspace_id'
        AND a.attnum>0 AND NOT a.attisdropped
     WHERE n.nspname='public' AND c.relkind='r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    IF NOT EXISTS (SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=table_name
        AND policyname='workspace_lifecycle_migrator_export') THEN
      EXECUTE format('CREATE POLICY workspace_lifecycle_migrator_export ON public.%I FOR SELECT TO platform_migrator USING (true)',table_name);
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION export_workspace_data(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $workspace_export$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id',true),'')::uuid;
  workspace_record jsonb;
  table_name text;
  table_data jsonb;
  exported_tables jsonb := '{}'::jsonb;
BEGIN
  SELECT to_jsonb(w) INTO workspace_record
    FROM public.workspaces w
   WHERE w.id=p_workspace_id AND w.owner_user_id=actor_id;
  IF workspace_record IS NULL THEN
    RAISE EXCEPTION 'workspace export requires its active owner' USING ERRCODE='42501';
  END IF;

  FOR table_name IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='workspace_id'
        AND a.attnum>0 AND NOT a.attisdropped
     WHERE n.nspname='public' AND c.relkind='r'
       AND c.relname NOT IN (
         'outbox_events','twitch_eventsub_deliveries','user_notifications',
         'email_outbox','user_notification_deduplication',
         'provider_execution_states','playback_operations','playback_leases'
       )
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(to_jsonb(row_data) - ARRAY[''credential_ciphertext'',''credential_nonce'',''credential_auth_tag'',''wrapped_dek'',''dek_nonce'',''dek_auth_tag'',''kek_version'',''credential_format_version'',''ciphertext'',''nonce'',''auth_tag'',''access_token_hash'',''token_hash'',''pending_object_key'',''object_key'']), ''[]''::jsonb) FROM public.%I row_data WHERE workspace_id=$1',
      table_name
    ) INTO table_data USING p_workspace_id;
    exported_tables := exported_tables || jsonb_build_object(table_name,table_data);
  END LOOP;

  workspace_record := workspace_record - 'owner_user_id';
  RETURN jsonb_build_object(
    'format','multi-streamer-audio-platform.workspace-export',
    'schemaVersion',1,
    'exportedAt',now(),
    'workspace',workspace_record,
    'tables',exported_tables,
    'exclusions',jsonb_build_array(
      'OAuth credentials, encrypted credential envelopes, scene bearer-token hashes, invitation token hashes, and internal object-storage keys are excluded.',
      'Personal account data and user-wide notifications are available through the separate account export.',
      'Transient delivery, outbox, and playback-operation internals are excluded.',
      'Workspace asset metadata is included; asset file download links are supplied separately and expire after seven days.'
    )
  );
END;
$workspace_export$;

ALTER FUNCTION export_workspace_data(uuid) OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION export_workspace_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_workspace_data(uuid) TO platform_runtime;
