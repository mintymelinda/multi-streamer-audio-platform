-- Allow the restricted provider worker to defer a queued job that is
-- currently blocked by logical queue order, output occupancy, or a transient
-- authorization/provider condition. Queue Manager can later create a fresh
-- dispatch generation when the request becomes eligible.
GRANT UPDATE (state, next_attempt_at, last_error_code, updated_at)
  ON public.provider_execution_states TO platform_provider_execution_owner;

CREATE OR REPLACE FUNCTION public.platform_defer_provider_execution_job(
  p_execution_state_id uuid,
  p_workspace_id uuid,
  p_request_id uuid,
  p_provider_instance_id uuid,
  p_dispatch_generation integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_deferred boolean := false;
BEGIN
  IF session_user <> 'platform_provider_worker' THEN
    RAISE EXCEPTION 'provider execution deferral is restricted to its worker identity'
      USING ERRCODE = '42501';
  END IF;
  IF p_dispatch_generation IS NULL OR p_dispatch_generation < 1 THEN
    RETURN false;
  END IF;

  UPDATE public.provider_execution_states s
     SET state = 'retry_wait',
         next_attempt_at = NULL,
         last_error_code = 'DISPATCH_DEFERRED',
         updated_at = now()
    FROM public.media_requests r
   WHERE s.id = p_execution_state_id
     AND s.workspace_id = p_workspace_id
     AND s.request_id = p_request_id
     AND s.provider_instance_id = p_provider_instance_id
     AND s.dispatch_generation = p_dispatch_generation
     AND s.state IN ('queued', 'resolving')
     AND r.workspace_id = s.workspace_id
     AND r.id = s.request_id
     AND r.status = 'queued'
     AND EXISTS (
       SELECT 1
         FROM public.logical_queue_entries q
        WHERE q.workspace_id = s.workspace_id
          AND q.request_id = s.request_id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.playback_operations active_operation
        WHERE active_operation.workspace_id = s.workspace_id
          AND active_operation.request_id = s.request_id
          AND active_operation.status IN ('pending', 'executing', 'uncertain')
     )
  RETURNING true INTO v_deferred;

  RETURN COALESCE(v_deferred, false);
END;
$function$;

ALTER FUNCTION public.platform_defer_provider_execution_job(uuid, uuid, uuid, uuid, integer)
  OWNER TO platform_provider_execution_owner;
REVOKE ALL ON FUNCTION public.platform_defer_provider_execution_job(uuid, uuid, uuid, uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_defer_provider_execution_job(uuid, uuid, uuid, uuid, integer)
  TO platform_provider_worker;
