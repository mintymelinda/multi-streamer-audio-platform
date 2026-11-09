-- Phase 3 item 31: provider-specific execution state without owning request lifecycle or order.

CREATE TABLE provider_execution_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  request_id uuid NOT NULL,
  provider_instance_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'resolving', 'ready', 'playing', 'retry_wait', 'completed', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, request_id, provider_instance_id),
  FOREIGN KEY (workspace_id, request_id)
    REFERENCES media_requests(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, provider_instance_id)
    REFERENCES provider_instances(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX provider_execution_states_due
  ON provider_execution_states (workspace_id, state, next_attempt_at, updated_at)
  WHERE state IN ('queued', 'retry_wait');

CREATE INDEX provider_execution_states_request
  ON provider_execution_states (workspace_id, request_id, updated_at DESC);

ALTER TABLE provider_execution_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_execution_states FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_execution_states_member_access
  ON provider_execution_states
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = provider_execution_states.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = provider_execution_states.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  );

GRANT SELECT, INSERT, UPDATE ON provider_execution_states TO platform_runtime;
