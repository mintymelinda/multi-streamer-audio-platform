-- Phase 3 item 32: configurable provider retry/failover policy and audited manual recovery.

CREATE TABLE workspace_provider_recovery_policies (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  automatic_retry_enabled boolean NOT NULL DEFAULT true,
  failover_enabled boolean NOT NULL DEFAULT true,
  failover_on_permanent_failure boolean NOT NULL DEFAULT false,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  base_delay_ms integer NOT NULL DEFAULT 5000 CHECK (base_delay_ms BETWEEN 250 AND 3600000),
  max_delay_ms integer NOT NULL DEFAULT 300000 CHECK (max_delay_ms BETWEEN 1000 AND 86400000),
  updated_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_delay_ms >= base_delay_ms)
);

CREATE TABLE provider_recovery_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('retry', 'reroute', 'skip', 'dismiss')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  from_provider_instance_id uuid,
  to_provider_instance_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, request_id)
    REFERENCES media_requests(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, from_provider_instance_id)
    REFERENCES provider_instances(workspace_id, id),
  FOREIGN KEY (workspace_id, to_provider_instance_id)
    REFERENCES provider_instances(workspace_id, id)
);

CREATE INDEX provider_recovery_actions_request
  ON provider_recovery_actions (workspace_id, request_id, created_at DESC);

ALTER TABLE workspace_provider_recovery_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_provider_recovery_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_recovery_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_recovery_actions FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_provider_recovery_policies_member_access
  ON workspace_provider_recovery_policies
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_provider_recovery_policies.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_provider_recovery_policies.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  );

CREATE POLICY provider_recovery_actions_member_access
  ON provider_recovery_actions
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = provider_recovery_actions.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = provider_recovery_actions.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  );

GRANT SELECT, INSERT, UPDATE ON workspace_provider_recovery_policies TO platform_runtime;
GRANT SELECT, INSERT ON provider_recovery_actions TO platform_runtime;
