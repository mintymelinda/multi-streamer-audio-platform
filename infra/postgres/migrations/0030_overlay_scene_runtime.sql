-- Phase 5 item 46: token-authenticated read-only scene snapshots and realtime lookup.
ALTER TABLE overlay_scenes
  ADD COLUMN published_state jsonb;

CREATE FUNCTION get_overlay_scene_snapshot(p_scene_id uuid, p_token_hash text)
RETURNS TABLE (
  scene_id uuid,
  workspace_id uuid,
  scene_name text,
  published_state jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.workspace_id, s.name, s.published_state
    FROM public.overlay_scenes s
   WHERE s.id = p_scene_id
     AND s.access_token_hash = p_token_hash
     AND s.token_revoked_at IS NULL
$$;

CREATE FUNCTION get_active_overlay_scene_ids(p_workspace_id uuid)
RETURNS TABLE (scene_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id
    FROM public.overlay_scenes s
   WHERE s.workspace_id = p_workspace_id
     AND s.access_token_hash IS NOT NULL
     AND s.token_revoked_at IS NULL
$$;

REVOKE ALL ON FUNCTION get_overlay_scene_snapshot(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_active_overlay_scene_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_overlay_scene_snapshot(uuid, text) TO platform_runtime;
GRANT EXECUTE ON FUNCTION get_active_overlay_scene_ids(uuid) TO platform_runtime;
