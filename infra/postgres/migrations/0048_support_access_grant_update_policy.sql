-- SECURITY DEFINER support readers lock grants while checking expiry/revocation.
-- PostgreSQL applies UPDATE RLS visibility to SELECT ... FOR UPDATE, so the
-- trusted function owner needs a narrowly-scoped policy for those row locks
-- and for the owner-authorized revocation UPDATE.
CREATE POLICY workspace_support_access_trusted_update
  ON public.workspace_support_access
  FOR UPDATE
  TO platform_migrator
  USING (
    support_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR EXISTS (
      SELECT 1
        FROM public.workspaces workspace_row
       WHERE workspace_row.id = workspace_support_access.workspace_id
         AND workspace_row.owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    support_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR EXISTS (
      SELECT 1
        FROM public.workspaces workspace_row
       WHERE workspace_row.id = workspace_support_access.workspace_id
         AND workspace_row.owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
  );
