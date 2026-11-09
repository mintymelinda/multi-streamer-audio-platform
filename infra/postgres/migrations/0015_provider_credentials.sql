-- Phase 3 item 27: encrypted provider credential lifecycle.
-- Credential material is envelope-encrypted by the API; this table never stores plaintext.

CREATE TABLE provider_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_instance_id uuid NOT NULL,
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  auth_tag text NOT NULL,
  wrapped_dek text NOT NULL,
  dek_nonce text NOT NULL,
  dek_auth_tag text NOT NULL,
  kek_version text NOT NULL CHECK (length(kek_version) BETWEEN 1 AND 80),
  format_version smallint NOT NULL CHECK (format_version = 1),
  granted_scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'authorization_expired', 'revocation_pending')),
  expires_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider_instance_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, provider_instance_id) REFERENCES provider_instances(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX provider_credentials_expiry ON provider_credentials (expires_at) WHERE status = 'connected' AND expires_at IS NOT NULL;
ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_credentials_member_access ON provider_credentials
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = provider_credentials.workspace_id
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.status = 'active'
  ))
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = provider_credentials.workspace_id
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.status = 'active'
  ));
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_credentials TO platform_runtime;
