-- Repair Phase 6 support audit writes under forced RLS.
-- The runtime role cannot write this table directly; trusted SECURITY DEFINER
-- functions execute as platform_migrator and may append only known audit events.
CREATE POLICY workspace_support_access_audit_trusted_insert
  ON public.workspace_support_access_audit
  FOR INSERT
  TO platform_migrator
  WITH CHECK (
    workspace_id IS NOT NULL
    AND actor_user_id IS NOT NULL
    AND length(btrim(reason)) BETWEEN 1 AND 1000
    AND action IN (
      'workspace.diagnostics.read',
      'support_access.granted',
      'support_access.content_read',
      'support_access.audit_viewed',
      'support_access.revoked'
    )
  );
