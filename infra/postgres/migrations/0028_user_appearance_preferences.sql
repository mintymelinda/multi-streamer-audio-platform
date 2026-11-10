-- Phase 4 item 44: account-wide appearance preferences shared across workspaces.
CREATE TABLE user_appearance_preferences (
  user_id uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  theme text NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
  accent_color text NOT NULL DEFAULT 'violet'
    CHECK (accent_color IN ('violet', 'blue', 'teal', 'green', 'orange', 'rose')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_appearance_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_appearance_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY user_appearance_preferences_self_access
  ON user_appearance_preferences FOR ALL
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_appearance_preferences TO platform_runtime;

-- Personal account exports include only the requesting user's appearance settings.
GRANT SELECT ON user_appearance_preferences TO platform_worker;
