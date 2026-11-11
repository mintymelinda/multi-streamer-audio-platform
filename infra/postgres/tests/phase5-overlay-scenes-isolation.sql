-- Workspace scene metadata and access-token hashes remain tenant isolated.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
DO $$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_a uuid := gen_random_uuid();
  workspace_b uuid := gen_random_uuid();
  scene_a uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_a, '980000001');
  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_b, '980000002');

  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
  VALUES (workspace_a, 'Overlay workspace A', user_a, '980000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
  VALUES (workspace_a, user_a, 'owner');

  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
  VALUES (workspace_b, 'Overlay workspace B', user_b, '980000002');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
  VALUES (workspace_b, user_b, 'owner');
  SET CONSTRAINTS ALL IMMEDIATE;

  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  INSERT INTO overlay_scenes (id, workspace_id, name, is_starter, access_token_hash, created_by_user_id)
  VALUES (scene_a, workspace_a, 'Now Playing', true, repeat('a', 64), user_a);
  UPDATE workspaces SET overlay_starter_provisioned_at = now() WHERE id = workspace_a;
  IF (SELECT count(*) FROM overlay_scenes WHERE id = scene_a) <> 1 THEN
    RAISE EXCEPTION 'workspace owner cannot read their scene';
  END IF;
  IF (SELECT count(*) FROM get_overlay_scene_snapshot(scene_a, repeat('a', 64))) <> 1 THEN
    RAISE EXCEPTION 'valid scene token cannot read its published snapshot';
  END IF;
  IF (SELECT count(*) FROM get_overlay_scene_snapshot(scene_a, repeat('b', 64))) <> 0 THEN
    RAISE EXCEPTION 'invalid scene token read a published snapshot';
  END IF;
  IF (SELECT count(*) FROM get_active_overlay_scene_ids(workspace_a)) <> 1 THEN
    RAISE EXCEPTION 'active scene lookup omitted a live scene';
  END IF;

  PERFORM set_config('app.user_id', user_b::text, true);
  PERFORM set_config('app.workspace_id', workspace_b::text, true);
  IF (SELECT count(*) FROM overlay_scenes WHERE id = scene_a) <> 0 THEN
    RAISE EXCEPTION 'another workspace can read scene metadata or token hashes';
  END IF;
  UPDATE overlay_scenes SET name = 'Compromised' WHERE id = scene_a;
  BEGIN
    INSERT INTO overlay_scenes (workspace_id, name, access_token_hash, created_by_user_id)
    VALUES (workspace_a, 'Cross-tenant scene', repeat('b', 64), user_b);
    RAISE EXCEPTION 'workspace member inserted a scene into another workspace';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  IF NOT EXISTS (SELECT 1 FROM overlay_scenes WHERE id = scene_a AND name = 'Now Playing') THEN
    RAISE EXCEPTION 'another workspace modified a scene';
  END IF;

  DELETE FROM overlay_scenes WHERE id = scene_a;
  IF FOUND IS NOT TRUE THEN
    RAISE EXCEPTION 'workspace owner could not delete their scene';
  END IF;
  IF (SELECT count(*) FROM get_overlay_scene_snapshot(scene_a, repeat('a', 64))) <> 0 THEN
    RAISE EXCEPTION 'deleted scene token still resolves a published snapshot';
  END IF;
  IF (SELECT count(*) FROM get_active_overlay_scene_ids(workspace_a)) <> 0 THEN
    RAISE EXCEPTION 'deleted scene remains in active scene lookup';
  END IF;
  IF (SELECT overlay_starter_provisioned_at FROM workspaces WHERE id = workspace_a) IS NULL THEN
    RAISE EXCEPTION 'deleting the starter scene cleared its one-time provisioning marker';
  END IF;
  INSERT INTO overlay_scenes (id, workspace_id, name, access_token_hash, created_by_user_id)
  VALUES (scene_a, workspace_a, 'Replacement', repeat('c', 64), user_a);
END;
$$;
ROLLBACK;
