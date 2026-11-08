-- Persist workspace-owned Twitch reward links and the single feature handler
-- selected for each reward. Twitch metadata is trigger identity, never behavior.
-- Manual links remain pending_verification until a Twitch API reconciliation
-- confirms that the reward still exists and belongs to this broadcaster.

CREATE TABLE twitch_reward_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  twitch_reward_id text NOT NULL CHECK (length(twitch_reward_id) BETWEEN 1 AND 128),
  reward_title text NOT NULL CHECK (length(btrim(reward_title)) BETWEEN 1 AND 45),
  reward_prompt text CHECK (reward_prompt IS NULL OR length(reward_prompt) <= 200),
  reward_cost integer NOT NULL CHECK (reward_cost BETWEEN 1 AND 1000000),
  feature_key text NOT NULL CHECK (feature_key IN ('media_request')),
  feature_settings jsonb NOT NULL DEFAULT '{"inputMode":"url_or_search","priority":0}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  sync_state text NOT NULL DEFAULT 'pending_verification'
    CHECK (sync_state IN (
      'pending_verification', 'synced', 'attention_required',
      'deleted_on_twitch', 'sync_unknown'
    )),
  last_synced_at timestamptz,
  last_sync_error_code text,
  created_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, twitch_reward_id),
  CHECK (jsonb_typeof(feature_settings) = 'object'),
  CHECK (
    feature_key <> 'media_request'
    OR (
      (feature_settings - ARRAY['inputMode', 'priority']::text[]) = '{}'::jsonb
      AND COALESCE(feature_settings->>'inputMode' IN ('url_or_search', 'url_only', 'text_only'), false)
      AND COALESCE(jsonb_typeof(feature_settings->'priority') = 'number', false)
      AND COALESCE((feature_settings->>'priority')::integer BETWEEN 0 AND 100, false)
      AND COALESCE(
        (feature_settings->>'priority')::numeric = (feature_settings->>'priority')::integer,
        false
      )
    )
  )
);

CREATE INDEX twitch_reward_mappings_workspace_enabled
  ON twitch_reward_mappings (workspace_id, enabled, feature_key);

ALTER TABLE twitch_reward_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE twitch_reward_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY twitch_reward_mappings_member_access ON twitch_reward_mappings
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = twitch_reward_mappings.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = twitch_reward_mappings.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  );

GRANT SELECT, INSERT, UPDATE ON twitch_reward_mappings TO platform_runtime;
-- Deliberately grant no mapping-table access to platform_worker. Redemption
-- processing will use a narrowly scoped domain operation rather than broad
-- worker access to workspace configuration or request tables.
