-- Twitch OAuth state is pre-authentication or callback state, not user-readable
-- workspace data. Migration 0045 enables and forces RLS on every table carrying
-- workspace_id, including this shared state table. Permit only the trusted
-- application runtime to manage rows with one of the two valid state shapes.
CREATE POLICY twitch_oauth_states_runtime_access
ON public.twitch_oauth_states
FOR ALL
TO platform_runtime
USING (
  (purpose = 'login' AND actor_user_id IS NULL AND workspace_id IS NULL)
  OR
  (purpose = 'workspace_integration' AND actor_user_id IS NOT NULL AND workspace_id IS NOT NULL)
)
WITH CHECK (
  (purpose = 'login' AND actor_user_id IS NULL AND workspace_id IS NULL)
  OR
  (purpose = 'workspace_integration' AND actor_user_id IS NOT NULL AND workspace_id IS NOT NULL)
);
