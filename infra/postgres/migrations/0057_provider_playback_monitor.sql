-- Expose only the minimal active Lyrion playback identities needed by the
-- restricted worker to poll provider state. No credentials or media URLs leave
-- the API's tenant-scoped database context.
CREATE FUNCTION public.platform_list_active_provider_playback()
RETURNS TABLE (
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
    execution.id,
    execution.workspace_id,
    execution.request_id,
    execution.provider_instance_id,
    execution.dispatch_generation,
    CASE
      WHEN request.source = 'twitch_reward' THEN workspace.owner_user_id
      ELSE request.submitted_by_user_id
    END
  FROM public.provider_execution_states execution
  JOIN public.media_requests request
    ON request.workspace_id = execution.workspace_id
   AND request.id = execution.request_id
  JOIN public.workspaces workspace ON workspace.id = execution.workspace_id
  JOIN public.provider_instances provider
    ON provider.workspace_id = execution.workspace_id
   AND provider.id = execution.provider_instance_id
  WHERE execution.state = 'playing'
    AND request.status = 'playing'
    AND workspace.status = 'active'
    AND provider.provider_id = 'lyrion'
    AND provider.enabled = true
    AND CASE
      WHEN request.source = 'twitch_reward' THEN workspace.owner_user_id
      ELSE request.submitted_by_user_id
    END IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.workspace_memberships membership
        JOIN public.platform_users account ON account.id = membership.user_id
       WHERE membership.workspace_id = execution.workspace_id
         AND membership.user_id = CASE
           WHEN request.source = 'twitch_reward' THEN workspace.owner_user_id
           ELSE request.submitted_by_user_id
         END
         AND membership.status = 'active'
         AND account.status = 'active'
    )
    AND EXISTS (
      SELECT 1
        FROM public.provider_output_assignments assignment
       WHERE assignment.workspace_id = execution.workspace_id
         AND assignment.provider_instance_id = execution.provider_instance_id
         AND assignment.active = true
    );
END;
$function$;

GRANT USAGE, CREATE ON SCHEMA public TO platform_provider_execution_owner;
ALTER FUNCTION public.platform_list_active_provider_playback()
  OWNER TO platform_provider_execution_owner;
REVOKE CREATE ON SCHEMA public FROM platform_provider_execution_owner;
REVOKE ALL ON FUNCTION public.platform_list_active_provider_playback() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_list_active_provider_playback()
  TO platform_provider_worker;
