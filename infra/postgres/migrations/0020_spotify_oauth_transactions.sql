-- Short-lived, one-time Spotify OAuth state bound to the initiating user session.
CREATE TABLE spotify_oauth_transactions (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
  verifier_ciphertext text NOT NULL, verifier_nonce text NOT NULL, verifier_auth_tag text NOT NULL,
  verifier_wrapped_dek text NOT NULL, verifier_dek_nonce text NOT NULL,
  verifier_dek_auth_tag text NOT NULL, verifier_kek_version text NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spotify_oauth_transactions_expiry ON spotify_oauth_transactions (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON spotify_oauth_transactions TO platform_runtime;
