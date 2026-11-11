-- Phase 5 item 52: centrally configurable platform-wide overlay scene safety ceiling.
-- The runtime role can read the setting but cannot change it; operators update it
-- through the privileged database administration path until platform administration
-- is implemented in Phase 6.
CREATE TABLE platform_settings (
  setting_key text PRIMARY KEY,
  setting_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (setting_key, setting_value)
VALUES ('overlay_scene_safety_ceiling', '1000'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

GRANT SELECT ON platform_settings TO platform_runtime;

-- A trigger-maintained global count avoids relying on tenant-scoped RLS queries
-- and makes the ceiling race-safe across concurrent workspace scene creation.
CREATE TABLE platform_scene_usage (
  usage_key text PRIMARY KEY CHECK (usage_key = 'overlay_scenes'),
  scene_count bigint NOT NULL CHECK (scene_count >= 0)
);

INSERT INTO platform_scene_usage (usage_key, scene_count)
SELECT 'overlay_scenes', count(*) FROM overlay_scenes;

CREATE FUNCTION enforce_overlay_scene_safety_ceiling()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_count bigint;
  configured_ceiling bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(7219045201);

  SELECT scene_count
    INTO current_count
    FROM public.platform_scene_usage
   WHERE usage_key = 'overlay_scenes'
   FOR UPDATE;

  IF TG_OP = 'INSERT' THEN
    SELECT CASE
             WHEN jsonb_typeof(setting_value) = 'number'
              AND (setting_value #>> '{}') ~ '^[1-9][0-9]*$'
             THEN (setting_value #>> '{}')::bigint
             ELSE 1000
           END
      INTO configured_ceiling
      FROM public.platform_settings
     WHERE setting_key = 'overlay_scene_safety_ceiling';

    configured_ceiling := COALESCE(configured_ceiling, 1000);
    IF current_count >= configured_ceiling THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'OVERLAY_SCENE_SAFETY_CEILING_REACHED';
    END IF;

    UPDATE public.platform_scene_usage
       SET scene_count = scene_count + 1
     WHERE usage_key = 'overlay_scenes';
    RETURN NEW;
  END IF;

  UPDATE public.platform_scene_usage
     SET scene_count = GREATEST(0, scene_count - 1)
   WHERE usage_key = 'overlay_scenes';
  RETURN OLD;
END;
$$;

CREATE TRIGGER overlay_scenes_enforce_global_ceiling
BEFORE INSERT OR DELETE ON overlay_scenes
FOR EACH ROW EXECUTE FUNCTION enforce_overlay_scene_safety_ceiling();

GRANT DELETE ON overlay_scenes TO platform_runtime;

-- Default privileges grant runtime DML on newly created tables. Explicitly
-- narrow these global control tables so only the definer trigger can mutate
-- usage counters and only the migrator/operator can change the configured cap.
REVOKE ALL ON platform_scene_usage FROM platform_runtime;
REVOKE INSERT, UPDATE, DELETE ON platform_settings FROM platform_runtime;
REVOKE ALL ON FUNCTION enforce_overlay_scene_safety_ceiling() FROM PUBLIC, platform_runtime;
