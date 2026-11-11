-- Phase 5: backfill starter scenes created before the default Now Playing layout existed.
WITH starter_defaults AS (
  SELECT
    id,
    jsonb_build_object(
      'version', 1,
      'canvas', jsonb_build_object(
        'mode', 'responsive',
        'width', 1920,
        'height', 1080,
        'snap', true,
        'snapSize', 2
      ),
      'transition', jsonb_build_object('type', 'none', 'durationMs', 320),
      'reducedMotion', false,
      'elements', jsonb_build_array(
        jsonb_build_object(
          'id', gen_random_uuid()::text,
          'type', 'now-playing',
          'name', 'Now Playing',
          'text', 'Now Playing',
          'x', 5,
          'y', 5,
          'width', 42,
          'height', 24,
          'locked', false,
          'animation', jsonb_build_object(
            'enter', 'fade',
            'exit', 'fade',
            'durationMs', 240,
            'delayMs', 0,
            'trigger', 'always'
          )
        )
      )
    ) AS state
  FROM overlay_scenes
  WHERE is_starter = true
    AND published_state IS NULL
    AND CASE
      WHEN jsonb_typeof(draft_state->'elements') = 'array'
      THEN jsonb_array_length(draft_state->'elements') = 0
      ELSE false
    END
)
UPDATE overlay_scenes AS scenes
   SET draft_state = starter_defaults.state,
       published_state = starter_defaults.state,
       published_at = now(),
       updated_at = now()
  FROM starter_defaults
 WHERE scenes.id = starter_defaults.id;
