-- Phase 5: update only untouched starter scenes to the agreed Now Playing geometry.
-- Edited scenes are deliberately left alone; the default is not a forced redesign.
BEGIN;

ALTER TABLE overlay_scenes DISABLE ROW LEVEL SECURITY;

WITH eligible_starters AS (
  SELECT
    id,
    jsonb_set(
      jsonb_set(draft_state, '{elements,0,width}', '58'::jsonb),
      '{elements,0,height}',
      '18'::jsonb
    ) AS updated_state
  FROM overlay_scenes
  WHERE is_starter = true
    AND published_state IS NOT NULL
    AND draft_state = published_state
    AND jsonb_typeof(draft_state->'elements') = 'array'
    AND jsonb_array_length(draft_state->'elements') = 1
    AND draft_state->'elements'->0->>'type' = 'now-playing'
    AND draft_state->'elements'->0->>'name' = 'Now Playing'
    AND draft_state->'elements'->0->>'text' = 'Now Playing'
    AND draft_state->'elements'->0->>'x' = '5'
    AND draft_state->'elements'->0->>'y' = '5'
    AND draft_state->'elements'->0->>'width' = '42'
    AND draft_state->'elements'->0->>'height' = '24'
)
UPDATE overlay_scenes AS scenes
   SET draft_state = eligible_starters.updated_state,
       published_state = eligible_starters.updated_state,
       updated_at = now()
  FROM eligible_starters
 WHERE scenes.id = eligible_starters.id;

ALTER TABLE overlay_scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE overlay_scenes FORCE ROW LEVEL SECURITY;

COMMIT;
