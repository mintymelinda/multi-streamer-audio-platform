-- Enforce logical queue head and output occupancy at the worker trust boundary.
GRANT SELECT (priority, sequence) ON public.logical_queue_entries TO platform_provider_execution_owner;
GRANT SELECT (workspace_id, output_id, request_id, status) ON public.playback_operations TO platform_provider_execution_owner;

-- Revalidate both media-source and playback-output restrictions when a worker
-- redelivers an in-progress execution. The coordinator's idempotency record and
-- fenced output lease remain the authority for side-effect recovery.
GRANT SELECT (provider) ON public.media_requests TO platform_provider_execution_owner;
CREATE OR REPLACE FUNCTION platform_validate_provider_execution_job(
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
DECLARE
  v_source request_source;
  v_submitted_by uuid;
  v_owner_id uuid;
  v_actor_id uuid;
  v_workspace_status workspace_status;
BEGIN
  IF session_user <> 'platform_provider_worker' THEN
    RAISE EXCEPTION 'provider execution validation is restricted to its worker identity'
      USING ERRCODE = '42501';
  END IF;
  IF p_dispatch_generation IS NULL OR p_dispatch_generation < 1 THEN RETURN; END IF;

  SELECT r.source, r.submitted_by_user_id, w.owner_user_id, w.status
    INTO v_source, v_submitted_by, v_owner_id, v_workspace_status
    FROM public.media_requests r
    JOIN public.workspaces w ON w.id = r.workspace_id
   WHERE r.id = p_request_id AND r.workspace_id = p_workspace_id;
  IF NOT FOUND OR v_workspace_status <> 'active' THEN RETURN; END IF;

  IF v_source = 'twitch_reward' THEN
    v_actor_id := v_owner_id;
    IF NOT EXISTS (
      SELECT 1
        FROM public.twitch_eventsub_intake i
       WHERE i.workspace_id = p_workspace_id
         AND i.routed_request_id = p_request_id
         AND i.event_id = (
           SELECT r.source_event_id
             FROM public.media_requests r
            WHERE r.id = p_request_id AND r.workspace_id = p_workspace_id
         )
         AND i.routing_status = 'processed'
         AND i.service_actor_user_id = v_owner_id
    ) THEN RETURN; END IF;
  ELSE
    v_actor_id := v_submitted_by;
    IF v_actor_id IS NULL OR v_source NOT IN ('dashboard', 'moderator', 'api') THEN RETURN; END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.workspace_memberships m
      JOIN public.platform_users u ON u.id = m.user_id
     WHERE m.workspace_id = p_workspace_id
       AND m.user_id = v_actor_id
       AND m.status = 'active'
       AND u.status = 'active'
  ) THEN RETURN; END IF;

  RETURN QUERY
  SELECT s.id, s.workspace_id, s.request_id, s.provider_instance_id,
    s.state, s.attempt, s.dispatch_generation, r.source, r.status, v_actor_id,
    p.provider_id, p.contract_version, p.capabilities, p.connection_health,
    o.output_id, o.player_id, r.media_id, r.media_url, r.title, r.artist, r.duration_ms, r.metadata
  FROM public.provider_execution_states s
  JOIN public.media_requests r
    ON r.workspace_id = s.workspace_id AND r.id = s.request_id
  JOIN public.provider_instances p
    ON p.workspace_id = s.workspace_id AND p.id = s.provider_instance_id
  JOIN public.provider_output_assignments o
    ON o.workspace_id = s.workspace_id
   AND o.provider_instance_id = s.provider_instance_id
   AND o.active = true
  WHERE s.id = p_execution_state_id
    AND s.workspace_id = p_workspace_id
    AND s.request_id = p_request_id
    AND s.provider_instance_id = p_provider_instance_id
    AND s.dispatch_generation = p_dispatch_generation
    AND s.state IN ('queued', 'retry_wait', 'resolving')
    AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= now())
    AND r.source = v_source
    AND r.status = 'queued'
    AND r.provider IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.provider_instances source_provider
       WHERE source_provider.workspace_id = r.workspace_id
         AND source_provider.provider_id = r.provider
         AND source_provider.enabled = true
         AND source_provider.connection_health = 'healthy'
         AND COALESCE((source_provider.capabilities->>'resolve')::boolean, false) = true
         AND (
           source_provider.provider_id <> 'spotify'
           OR EXISTS (
             SELECT 1 FROM public.provider_credentials source_credential
              WHERE source_credential.workspace_id = r.workspace_id
                AND source_credential.provider_instance_id = source_provider.id
                AND source_credential.status = 'connected'
                AND (source_credential.expires_at IS NULL OR source_credential.expires_at > now())
           )
         )
    )
    AND p.enabled = true
    AND COALESCE((p.capabilities->>'playback')::boolean, false) = true
    AND (
      NOT (p.capabilities ? 'supportedSourceProviderIds')
      OR ((p.capabilities->'supportedSourceProviderIds') ? r.provider)
    )
    AND p.connection_health = 'healthy'
    AND COALESCE((
      SELECT policy.enabled
        FROM public.workspace_playback_policies policy
       WHERE policy.workspace_id = p_workspace_id
    ), true) = true
    AND NOT EXISTS (
      SELECT 1
        FROM public.workspace_provider_path_restrictions restriction
       WHERE restriction.workspace_id = p_workspace_id
         AND restriction.provider_id IN (p.provider_id, r.provider)
         AND restriction.disabled_at IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
        FROM public.rights_content_blocks block
       WHERE block.workspace_id = p_workspace_id
         AND block.content_id IN (r.media_id, p.provider_id || ':' || r.media_id, r.provider || ':' || r.media_id)
    )
    AND EXISTS (
      SELECT 1
        FROM public.logical_queue_entries q
       WHERE q.workspace_id = p_workspace_id AND q.request_id = p_request_id
    )
    -- A provider job may not bypass an earlier queued/resolving/ready request.
    -- Playing requests occupy only their assigned output lane, allowing other
    -- configured outputs to serve later logical queue entries concurrently.
    AND NOT EXISTS (
      SELECT 1
        FROM public.logical_queue_entries earlier_queue
        JOIN public.media_requests earlier_request
          ON earlier_request.workspace_id = earlier_queue.workspace_id
         AND earlier_request.id = earlier_queue.request_id
        JOIN public.logical_queue_entries current_queue
          ON current_queue.workspace_id = p_workspace_id
         AND current_queue.request_id = p_request_id
       WHERE earlier_queue.workspace_id = p_workspace_id
         AND earlier_queue.request_id <> p_request_id
         AND earlier_request.status IN ('queued', 'resolving', 'ready')
         AND (
           earlier_queue.priority > current_queue.priority
           OR (
             earlier_queue.priority = current_queue.priority
             AND earlier_queue.sequence < current_queue.sequence
           )
         )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM public.provider_execution_states other_execution
       WHERE other_execution.workspace_id = p_workspace_id
         AND other_execution.request_id = p_request_id
         AND other_execution.id <> s.id
         AND other_execution.state IN ('resolving', 'ready', 'playing')
    )
    -- A stale queue row must not allow a second request to take an output
    -- that still has a resolving/ready/playing execution or uncertain command.
    AND NOT EXISTS (
      SELECT 1
        FROM public.provider_execution_states active_execution
        JOIN public.provider_output_assignments active_output
          ON active_output.workspace_id = active_execution.workspace_id
         AND active_output.provider_instance_id = active_execution.provider_instance_id
         AND active_output.active = true
       WHERE active_execution.workspace_id = p_workspace_id
         AND active_output.output_id = o.output_id
         AND active_execution.request_id <> p_request_id
         AND active_execution.state IN ('resolving', 'ready', 'playing')
    )
    AND NOT EXISTS (
      SELECT 1
        FROM public.playback_operations active_operation
       WHERE active_operation.workspace_id = p_workspace_id
         AND active_operation.output_id = o.output_id
         AND active_operation.request_id <> p_request_id
         AND active_operation.status IN ('pending', 'executing', 'uncertain')
    )
    AND (
      p.provider_id <> 'spotify'
      OR EXISTS (
        SELECT 1
          FROM public.provider_credentials credential
         WHERE credential.workspace_id = p_workspace_id
           AND credential.provider_instance_id = p_provider_instance_id
           AND credential.status = 'connected'
           AND (credential.expires_at IS NULL OR credential.expires_at > now())
      )
    )
  LIMIT 1;
END;
$function$;
