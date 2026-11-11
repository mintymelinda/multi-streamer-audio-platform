-- Dedicated provider execution worker identity and database-side validation capability.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_provider_worker') THEN
    RAISE EXCEPTION 'platform_provider_worker must be provisioned before migrations';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_provider_execution_owner') THEN
    RAISE EXCEPTION 'platform_provider_execution_owner must be provisioned before migrations';
  END IF;
END;
$$;
GRANT USAGE ON SCHEMA public TO platform_provider_execution_owner;
GRANT SELECT (id, status) ON platform_users TO platform_provider_execution_owner;
GRANT SELECT (id, owner_user_id, status) ON workspaces TO platform_provider_execution_owner;
GRANT SELECT (workspace_id, user_id, status) ON workspace_memberships TO platform_provider_execution_owner;
GRANT SELECT (
  id, workspace_id, source, submitted_by_user_id, source_event_id, status,
  media_id, media_url, title, artist, duration_ms, metadata
) ON media_requests TO platform_provider_execution_owner;
GRANT SELECT (workspace_id, request_id) ON logical_queue_entries TO platform_provider_execution_owner;
GRANT SELECT (
  id, workspace_id, provider_id, contract_version, capabilities, connection_health, enabled
) ON provider_instances TO platform_provider_execution_owner;
GRANT SELECT (
  id, workspace_id, request_id, provider_instance_id, state, attempt,
  dispatch_generation, next_attempt_at
) ON provider_execution_states TO platform_provider_execution_owner;
GRANT SELECT (workspace_id, provider_instance_id, output_id, player_id, active)
  ON provider_output_assignments TO platform_provider_execution_owner;
GRANT SELECT (workspace_id, routed_request_id, event_id, routing_status, service_actor_user_id)
  ON twitch_eventsub_intake TO platform_provider_execution_owner;
GRANT SELECT (workspace_id, enabled) ON workspace_playback_policies TO platform_provider_execution_owner;
GRANT SELECT (workspace_id, provider_id, disabled_at)
  ON workspace_provider_path_restrictions TO platform_provider_execution_owner;
GRANT SELECT (workspace_id, content_id) ON rights_content_blocks TO platform_provider_execution_owner;
GRANT SELECT (workspace_id, provider_instance_id, status, expires_at)
  ON provider_credentials TO platform_provider_execution_owner;
CREATE FUNCTION platform_validate_provider_execution_job(
  p_execution_state_id uuid, p_workspace_id uuid, p_request_id uuid,
  p_provider_instance_id uuid, p_dispatch_generation integer
)
RETURNS TABLE (
  execution_state_id uuid, workspace_id uuid, request_id uuid, provider_instance_id uuid,
  state text, attempt integer, dispatch_generation integer,
  request_source request_source, request_status request_status, actor_user_id uuid,
  provider_id text, contract_version integer, capabilities jsonb, connection_health text,
  output_id text, player_id text, media_id text, media_url text, title text, artist text,
  duration_ms bigint, metadata jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE v_source request_source; v_submitted_by uuid; v_owner_id uuid; v_actor_id uuid; v_workspace_status workspace_status;
BEGIN
  IF session_user <> 'platform_provider_worker' THEN
    RAISE EXCEPTION 'provider execution validation is restricted to its worker identity' USING ERRCODE = '42501';
  END IF;
  IF p_dispatch_generation IS NULL OR p_dispatch_generation < 1 THEN RETURN; END IF;
  SELECT r.source, r.submitted_by_user_id, w.owner_user_id, w.status
    INTO v_source, v_submitted_by, v_owner_id, v_workspace_status
    FROM public.media_requests r JOIN public.workspaces w ON w.id = r.workspace_id
   WHERE r.id = p_request_id AND r.workspace_id = p_workspace_id;
  IF NOT FOUND OR v_workspace_status <> 'active' THEN RETURN; END IF;
  IF v_source = 'twitch_reward' THEN
    v_actor_id := v_owner_id;
    IF NOT EXISTS (
      SELECT 1 FROM public.twitch_eventsub_intake i
       WHERE i.workspace_id = p_workspace_id AND i.routed_request_id = p_request_id
         AND i.event_id = (SELECT r.source_event_id FROM public.media_requests r
                            WHERE r.id = p_request_id AND r.workspace_id = p_workspace_id)
         AND i.routing_status = 'processed' AND i.service_actor_user_id = v_owner_id
    ) THEN RETURN; END IF;
  ELSE
    v_actor_id := v_submitted_by;
    IF v_actor_id IS NULL OR v_source NOT IN ('dashboard', 'moderator', 'api') THEN RETURN; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_memberships m
                  JOIN public.platform_users u ON u.id = m.user_id
                 WHERE m.workspace_id = p_workspace_id AND m.user_id = v_actor_id
                   AND m.status = 'active' AND u.status = 'active')
  THEN RETURN; END IF;
  RETURN QUERY
  SELECT s.id, s.workspace_id, s.request_id, s.provider_instance_id,
    s.state, s.attempt, s.dispatch_generation, r.source, r.status, v_actor_id,
    p.provider_id, p.contract_version, p.capabilities, p.connection_health,
    o.output_id, o.player_id, r.media_id, r.media_url, r.title, r.artist, r.duration_ms, r.metadata
  FROM public.provider_execution_states s
  JOIN public.media_requests r ON r.workspace_id = s.workspace_id AND r.id = s.request_id
  JOIN public.provider_instances p ON p.workspace_id = s.workspace_id AND p.id = s.provider_instance_id
  JOIN public.provider_output_assignments o
    ON o.workspace_id = s.workspace_id AND o.provider_instance_id = s.provider_instance_id AND o.active = true
  WHERE s.id = p_execution_state_id AND s.workspace_id = p_workspace_id
    AND s.request_id = p_request_id AND s.provider_instance_id = p_provider_instance_id
    AND s.dispatch_generation = p_dispatch_generation
    AND s.state IN ('queued', 'retry_wait') AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= now())
    AND r.source = v_source AND r.status = 'queued'
    AND p.enabled = true AND p.connection_health = 'healthy'
    AND COALESCE((SELECT policy.enabled FROM public.workspace_playback_policies policy
                   WHERE policy.workspace_id = p_workspace_id), true) = true
    AND NOT EXISTS (SELECT 1 FROM public.workspace_provider_path_restrictions restriction
      WHERE restriction.workspace_id = p_workspace_id AND restriction.provider_id = p.provider_id
        AND restriction.disabled_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM public.rights_content_blocks block
      WHERE block.workspace_id = p_workspace_id
        AND block.content_id IN (r.media_id, p.provider_id || ':' || r.media_id))
    AND EXISTS (SELECT 1 FROM public.logical_queue_entries q
      WHERE q.workspace_id = p_workspace_id AND q.request_id = p_request_id)
    AND (p.provider_id <> 'spotify' OR EXISTS (SELECT 1 FROM public.provider_credentials credential
      WHERE credential.workspace_id = p_workspace_id AND credential.provider_instance_id = p_provider_instance_id
        AND credential.status = 'connected' AND (credential.expires_at IS NULL OR credential.expires_at > now())))
  LIMIT 1;
END;
$function$;
ALTER FUNCTION platform_validate_provider_execution_job(uuid, uuid, uuid, uuid, integer)
  OWNER TO platform_provider_execution_owner;
REVOKE ALL ON FUNCTION platform_validate_provider_execution_job(uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_validate_provider_execution_job(uuid, uuid, uuid, uuid, integer)
  TO platform_provider_worker;
GRANT CONNECT ON DATABASE platform TO platform_provider_worker;
GRANT USAGE ON SCHEMA public TO platform_provider_worker;
-- No table, sequence, or schema-creation grants are given to the worker login.
