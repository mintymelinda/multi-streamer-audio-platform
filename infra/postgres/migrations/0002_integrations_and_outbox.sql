-- Phase 2 prerequisite: encrypted integration credential envelopes and
-- transactional outbox records. Apply only with platform_migrator.

CREATE TABLE workspace_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('twitch', 'spotify', 'lyrion', 'youtube')),
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('connected', 'reauth_required', 'disconnected', 'error')),
  external_account_id text,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_auth_tag bytea,
  wrapped_dek bytea,
  dek_nonce bytea,
  dek_auth_tag bytea,
  kek_version text,
  credential_format_version smallint,
  token_expires_at timestamptz,
  last_validated_at timestamptz,
  last_error_code text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider),
  CHECK (
    (credential_ciphertext IS NULL AND credential_nonce IS NULL
      AND credential_auth_tag IS NULL AND wrapped_dek IS NULL
      AND dek_nonce IS NULL AND dek_auth_tag IS NULL AND kek_version IS NULL
      AND credential_format_version IS NULL)
    OR
    (credential_ciphertext IS NOT NULL AND credential_nonce IS NOT NULL
      AND credential_auth_tag IS NOT NULL AND wrapped_dek IS NOT NULL
      AND dek_nonce IS NOT NULL AND dek_auth_tag IS NOT NULL
      AND kek_version IS NOT NULL AND credential_format_version = 1)
  ),
  CHECK (status <> 'connected' OR credential_ciphertext IS NOT NULL)
);

CREATE INDEX workspace_integrations_workspace_status
  ON workspace_integrations (workspace_id, status, provider);

ALTER TABLE workspace_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_integrations FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_integrations_member_access ON workspace_integrations
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = workspace_integrations.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = workspace_integrations.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  );

GRANT SELECT, INSERT, UPDATE ON workspace_integrations TO platform_runtime;

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 160),
  aggregate_type text NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 80),
  aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 160),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_at timestamptz,
  lock_token uuid,
  published_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  CHECK ((locked_at IS NULL) = (lock_token IS NULL))
);

CREATE INDEX outbox_events_dispatch
  ON outbox_events (available_at, occurred_at, id)
  WHERE published_at IS NULL;

CREATE INDEX outbox_events_workspace_created
  ON outbox_events (workspace_id, created_at DESC);

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;

CREATE POLICY outbox_events_member_access ON outbox_events
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = outbox_events.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = outbox_events.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  );

GRANT SELECT, INSERT, UPDATE ON outbox_events TO platform_runtime;
