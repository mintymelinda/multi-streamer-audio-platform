-- Repair support-grant creation under forced RLS.
-- Only trusted SECURITY DEFINER functions owned by platform_migrator may
-- create grants; platform_runtime retains no direct table privileges.
CREATE POLICY workspace_support_access_trusted_insert
  ON public.workspace_support_access
  FOR INSERT
  TO platform_migrator
  WITH CHECK (
    workspace_id IS NOT NULL
    AND support_user_id IS NOT NULL
    AND granted_by_user_id = support_user_id
    AND support_twitch_user_id ~ '^[0-9]{1,32}$'
    AND length(btrim(reason)) BETWEEN 1 AND 1000
    AND cardinality(scopes) BETWEEN 1 AND 3
    AND scopes <@ ARRAY['workspace.read', 'requests.read', 'providers.read']::text[]
    AND expires_at > now()
  );
