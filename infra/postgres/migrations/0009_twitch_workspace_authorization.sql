-- Separate the platform sign-in OAuth flow from workspace-scoped Twitch
-- broadcaster authorization. The callback must be bound to the initiating
-- platform user and verified workspace, and state remains single-use.
ALTER TABLE twitch_oauth_states
  ADD COLUMN purpose text NOT NULL DEFAULT 'login'
    CHECK (purpose IN ('login', 'workspace_integration')),
  ADD COLUMN actor_user_id uuid REFERENCES platform_users(id) ON DELETE CASCADE,
  ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT twitch_oauth_states_purpose_context CHECK (
    (purpose = 'login' AND actor_user_id IS NULL AND workspace_id IS NULL)
    OR
    (purpose = 'workspace_integration' AND actor_user_id IS NOT NULL AND workspace_id IS NOT NULL)
  );

CREATE INDEX twitch_oauth_states_workspace_expiry
  ON twitch_oauth_states (workspace_id, expires_at)
  WHERE purpose = 'workspace_integration';
