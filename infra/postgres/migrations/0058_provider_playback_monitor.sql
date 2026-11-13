-- Natural completion is observed against the exact durable playback session
-- and dispatch generation. A failed queue-manager call can be retried safely.
ALTER TABLE public.playback_sessions
  ADD COLUMN queue_advance_dispatched_at timestamptz;

DROP INDEX public.playback_sessions_monitor;
CREATE INDEX playback_sessions_monitor
  ON public.playback_sessions (status, queue_advance_dispatched_at, observed_at, started_at)
  WHERE status IN ('playing', 'paused')
     OR (status = 'completed' AND queue_advance_dispatched_at IS NULL);

CREATE FUNCTION public.platform_list_active_playback_sessions()
RETURNS TABLE (
  playback_session_id uuid,
  execution_state_id uuid,
  workspace_id uuid,
  request_id uuid,
  provider_instance_id uuid,
  dispatch_generation integer,
  actor_user_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF session_user <> 'platform_provider_worker' THEN
    RAISE EXCEPTION 'provider playback monitoring is restricted to its worker identity'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    session.id,
    session.execution_state_id,
    session.workspace_id,
    session.request_id,
    session.provider_instance_id,
    session.dispatch_generation,
    workspace.owner_user_id
  FROM public.playback_sessions session
  JOIN public.provider_execution_states execution
    ON execution.workspace_id = session.workspace_id
   AND execution.id = session.execution_state_id
   AND execution.request_id = session.request_id
   AND execution.provider_instance_id = session.provider_instance_id
   AND execution.dispatch_generation = session.dispatch_generation
  JOIN public.media_requests request
    ON request.workspace_id = session.workspace_id
   AND request.id = session.request_id
  JOIN public.workspaces workspace
    ON workspace.id = session.workspace_id
  JOIN public.platform_users owner_account
    ON owner_account.id = workspace.owner_user_id
   AND owner_account.status = 'active'
  JOIN public.workspace_memberships owner_membership
    ON owner_membership.workspace_id = workspace.id
   AND owner_membership.user_id = workspace.owner_user_id
   AND owner_membership.status = 'active'
  JOIN public.provider_instances provider
    ON provider.workspace_id = session.workspace_id
   AND provider.id = session.provider_instance_id
  WHERE workspace.status = 'active'
    AND (
      (
        session.status = 'completed'
        AND session.queue_advance_dispatched_at IS NULL
        AND request.status = 'completed'
        AND execution.state = 'completed'
      )
      OR (
        session.status IN ('playing', 'paused')
        AND request.status = 'playing'
        AND execution.state = 'playing'
        AND provider.provider_id = 'lyrion'
        AND provider.enabled = true
        AND provider.connection_health = 'healthy'
        AND EXISTS (
          SELECT 1 FROM public.provider_output_assignments assignment
          WHERE assignment.workspace_id = session.workspace_id
            AND assignment.provider_instance_id = session.provider_instance_id
            AND assignment.output_id = session.output_id
            AND assignment.player_id = session.player_id
            AND assignment.active = true
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.playback_operations active_operation
          WHERE active_operation.workspace_id = session.workspace_id
            AND active_operation.output_id = session.output_id
            AND active_operation.status IN ('pending', 'executing', 'uncertain')
        )
      )
    )
  ORDER BY session.started_at
  LIMIT 500;
END;
$function$;

GRANT USAGE, CREATE ON SCHEMA public TO platform_provider_execution_owner;
ALTER FUNCTION public.platform_list_active_playback_sessions()
  OWNER TO platform_provider_execution_owner;
REVOKE CREATE ON SCHEMA public FROM platform_provider_execution_owner;
REVOKE ALL ON FUNCTION public.platform_list_active_playback_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_list_active_playback_sessions()
  TO platform_provider_worker;
