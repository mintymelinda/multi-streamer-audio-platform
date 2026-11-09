-- Phase 3 item 30: durable playback operations, workspace policy, and fenced output leases.

CREATE TABLE workspace_playback_policies (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  updated_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE playback_leases (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_instance_id uuid NOT NULL,
  player_id text NOT NULL CHECK (length(player_id) BETWEEN 1 AND 200),
  lease_owner_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  fencing_token bigint NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider_instance_id, player_id),
  FOREIGN KEY (workspace_id, provider_instance_id)
    REFERENCES provider_instances(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX playback_leases_expiry
  ON playback_leases (expires_at);

CREATE TABLE playback_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_instance_id uuid NOT NULL,
  player_id text NOT NULL CHECK (length(player_id) BETWEEN 1 AND 200),
  output_id text CHECK (output_id IS NULL OR length(output_id) BETWEEN 1 AND 200),
  request_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  command text NOT NULL CHECK (command IN ('play', 'pause', 'resume', 'skip', 'seek')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (
    status IN ('pending', 'executing', 'completed', 'failed', 'uncertain', 'reconciled')
  ),
  result jsonb,
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 100),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  provider_playback_id text CHECK (
    provider_playback_id IS NULL OR length(provider_playback_id) <= 500
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, provider_instance_id)
    REFERENCES provider_instances(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX playback_operations_request_history
  ON playback_operations (workspace_id, request_id, created_at DESC);

CREATE INDEX playback_operations_recovery
  ON playback_operations (workspace_id, status, updated_at)
  WHERE status IN ('pending', 'executing', 'uncertain', 'failed');

ALTER TABLE workspace_playback_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_playback_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE playback_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE playback_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE playback_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE playback_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_playback_policies_member_access
  ON workspace_playback_policies
  USING (
    EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_playback_policies.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_playback_policies.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
        AND m.status = 'active'
    )
  );

CREATE POLICY playback_leases_member_access
  ON playback_leases
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = playback_leases.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = playback_leases.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  );

CREATE POLICY playback_operations_member_access
  ON playback_operations
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = playback_operations.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = playback_operations.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  );

GRANT SELECT, INSERT, UPDATE ON workspace_playback_policies TO platform_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON playback_leases TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON playback_operations TO platform_runtime;
