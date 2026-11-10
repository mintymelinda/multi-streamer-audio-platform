-- Phase 5 item 47: isolate editable scene drafts from published OBS state.
ALTER TABLE overlay_scenes
  ADD COLUMN draft_state jsonb NOT NULL
    DEFAULT '{"version":1,"elements":[]}'::jsonb,
  ADD COLUMN draft_revision bigint NOT NULL DEFAULT 0
    CHECK (draft_revision >= 0),
  ADD COLUMN published_at timestamptz;

COMMENT ON COLUMN overlay_scenes.draft_state IS
  'Workspace-private editable scene document; never returned by public overlay runtime.';
COMMENT ON COLUMN overlay_scenes.published_state IS
  'Last explicitly published scene document; the read-only overlay runtime exposes only this value.';
