-- Phase 5 item 46: make starter-scene creation idempotent per workspace.
ALTER TABLE overlay_scenes
  ADD COLUMN is_starter boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX overlay_scenes_one_starter_per_workspace
  ON overlay_scenes (workspace_id)
  WHERE is_starter;

COMMENT ON COLUMN overlay_scenes.is_starter IS
  'Marks the automatically provisioned first-use scene; at most one starter scene exists per workspace.';
