-- Phase 6 item 60: operator rights-holder review, enforcement, and escalation.
BEGIN;

-- SECURITY DEFINER functions run as platform_migrator. Keep cross-workspace
-- access in this separate role; the API runtime receives EXECUTE only.
CREATE POLICY platform_users_rights_operator_access ON platform_users
  FOR SELECT TO platform_migrator USING (true);
CREATE POLICY rights_reports_platform_operator_access ON rights_holder_reports
  FOR ALL TO platform_migrator USING (true) WITH CHECK (true);
CREATE POLICY rights_report_events_platform_operator_access ON rights_report_events
  FOR ALL TO platform_migrator USING (true) WITH CHECK (true);
CREATE POLICY rights_content_blocks_platform_operator_access ON rights_content_blocks
  FOR ALL TO platform_migrator USING (true) WITH CHECK (true);
CREATE POLICY provider_path_restrictions_platform_operator_access ON workspace_provider_path_restrictions
  FOR ALL TO platform_migrator USING (true) WITH CHECK (true);
CREATE POLICY workspaces_rights_operator_access ON workspaces
  FOR ALL TO platform_migrator USING (true) WITH CHECK (true);

CREATE FUNCTION list_platform_rights_reports(status_filter text DEFAULT NULL, search_term text DEFAULT NULL)
RETURNS TABLE (
  id uuid, workspace_id uuid, workspace_name text, broadcaster_twitch_user_id text,
  claimant_name text, claimant_contact text, provider_id text, media_id text,
  content_url text, allegation text, evidence jsonb, status text,
  assigned_reviewer_user_id uuid, assigned_reviewer_twitch_user_id text,
  decision text, decision_reason text, decided_by_user_id uuid, decided_at timestamptz,
  created_at timestamptz, updated_at timestamptz,
  substantiated_case_count bigint, repeat_infringer_threshold integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $rights_operator$
BEGIN
  PERFORM public.require_platform_permission('rights_reports.manage');
  IF status_filter IS NOT NULL AND status_filter NOT IN
    ('received', 'investigating', 'decision_pending', 'escalated', 'closed') THEN
    RAISE EXCEPTION 'invalid rights report status filter' USING ERRCODE = '22023';
  END IF;
  IF search_term IS NOT NULL AND length(btrim(search_term)) > 120 THEN
    RAISE EXCEPTION 'rights report search is too long' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT report.id, report.workspace_id, workspace.name,
      workspace.broadcaster_twitch_user_id, report.claimant_name, report.claimant_contact,
      report.provider_id, report.media_id, report.content_url, report.allegation, report.evidence,
      report.status, report.assigned_reviewer_user_id, reviewer.twitch_user_id,
      report.decision, report.decision_reason, report.decided_by_user_id, report.decided_at,
      report.created_at, report.updated_at,
      (SELECT count(DISTINCT prior.provider_id || ':' || prior.media_id)
         FROM public.rights_holder_reports prior
        WHERE prior.workspace_id = report.workspace_id AND prior.decision = 'takedown'),
      3
    FROM public.rights_holder_reports report
    JOIN public.workspaces workspace ON workspace.id = report.workspace_id
    LEFT JOIN public.platform_users reviewer ON reviewer.id = report.assigned_reviewer_user_id
    WHERE (status_filter IS NULL OR report.status = status_filter)
      AND (search_term IS NULL OR
        report.provider_id ILIKE '%' || btrim(search_term) || '%'
        OR report.media_id ILIKE '%' || btrim(search_term) || '%'
        OR workspace.name ILIKE '%' || btrim(search_term) || '%'
        OR workspace.broadcaster_twitch_user_id = btrim(search_term)
        OR report.claimant_name ILIKE '%' || btrim(search_term) || '%')
    ORDER BY CASE report.status WHEN 'escalated' THEN 0 WHEN 'received' THEN 1
      WHEN 'investigating' THEN 2 WHEN 'decision_pending' THEN 3 ELSE 4 END,
      report.created_at DESC
    LIMIT 200;
END;
$rights_operator$;

CREATE FUNCTION get_platform_rights_report_events(target_report_id uuid)
RETURNS TABLE (
  id uuid, actor_user_id uuid, actor_twitch_user_id text,
  from_status text, to_status text, reason text, details jsonb, created_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $rights_operator$
BEGIN
  PERFORM public.require_platform_permission('rights_reports.manage');
  IF NOT EXISTS (SELECT 1 FROM public.rights_holder_reports WHERE id = target_report_id) THEN
    RAISE EXCEPTION 'rights report was not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
    SELECT event.id, event.actor_user_id, actor.twitch_user_id,
      event.from_status, event.to_status, event.reason, event.details, event.created_at
    FROM public.rights_report_events event
    LEFT JOIN public.platform_users actor ON actor.id = event.actor_user_id
    WHERE event.report_id = target_report_id
    ORDER BY event.created_at, event.id;
END;
$rights_operator$;

CREATE FUNCTION assign_platform_rights_report(target_report_id uuid, reviewer_user_id uuid, action_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $rights_operator$
DECLARE
  actor_id uuid := public.require_platform_permission('rights_reports.manage');
  report_workspace_id uuid;
  previous_reviewer uuid;
  current_status text;
BEGIN
  IF target_report_id IS NULL OR reviewer_user_id IS NULL OR
     action_reason IS NULL OR length(btrim(action_reason)) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'report, reviewer, and documented reason are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_administrators admin
    JOIN public.platform_users users ON users.id = admin.user_id
    WHERE admin.user_id = reviewer_user_id AND admin.revoked_at IS NULL
      AND users.status = 'active'
      AND (admin.role = 'owner' OR 'rights_reports.manage' = ANY(admin.permissions))
  ) THEN
    RAISE EXCEPTION 'reviewer must be an active rights-operations administrator' USING ERRCODE = '42501';
  END IF;
  SELECT workspace_id, assigned_reviewer_user_id, status
    INTO report_workspace_id, previous_reviewer, current_status
    FROM public.rights_holder_reports WHERE id = target_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'rights report was not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.rights_holder_reports SET assigned_reviewer_user_id = reviewer_user_id, updated_at = now()
   WHERE id = target_report_id;
  INSERT INTO public.rights_report_events
    (workspace_id, report_id, actor_user_id, from_status, to_status, reason, details)
  VALUES (report_workspace_id, target_report_id, actor_id, current_status, current_status,
    btrim(action_reason), jsonb_build_object('action', 'reviewer_assigned',
      'previous_reviewer_user_id', previous_reviewer, 'reviewer_user_id', reviewer_user_id));
  INSERT INTO public.platform_administration_audit (actor_user_id, action, reason, details)
  VALUES (actor_id, 'rights_report.reviewer_assigned', btrim(action_reason),
    jsonb_build_object('report_id', target_report_id, 'workspace_id', report_workspace_id,
      'previous_reviewer_user_id', previous_reviewer, 'reviewer_user_id', reviewer_user_id));
END;
$rights_operator$;

CREATE FUNCTION transition_platform_rights_report(target_report_id uuid, desired_status text, action_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $rights_operator$
DECLARE
  actor_id uuid := public.require_platform_permission('rights_reports.manage');
  report_workspace_id uuid;
  previous_status text;
  allowed boolean := false;
BEGIN
  IF target_report_id IS NULL OR desired_status IS NULL OR desired_status NOT IN ('investigating', 'decision_pending', 'escalated')
     OR action_reason IS NULL OR length(btrim(action_reason)) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'valid report transition and documented reason are required' USING ERRCODE = '22023';
  END IF;
  SELECT workspace_id, status INTO report_workspace_id, previous_status
    FROM public.rights_holder_reports WHERE id = target_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'rights report was not found' USING ERRCODE = 'P0002'; END IF;
  allowed := CASE previous_status
    WHEN 'received' THEN desired_status IN ('investigating', 'escalated')
    WHEN 'investigating' THEN desired_status IN ('decision_pending', 'escalated')
    WHEN 'decision_pending' THEN desired_status IN ('investigating', 'escalated')
    WHEN 'escalated' THEN desired_status IN ('investigating', 'decision_pending')
    ELSE false END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'rights report transition from % to % is not allowed', previous_status, desired_status
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.rights_holder_reports SET status = desired_status, updated_at = now() WHERE id = target_report_id;
  INSERT INTO public.rights_report_events
    (workspace_id, report_id, actor_user_id, from_status, to_status, reason)
  VALUES (report_workspace_id, target_report_id, actor_id, previous_status, desired_status, btrim(action_reason));
  INSERT INTO public.platform_administration_audit (actor_user_id, action, reason, details)
  VALUES (actor_id, 'rights_report.status_changed', btrim(action_reason),
    jsonb_build_object('report_id', target_report_id, 'workspace_id', report_workspace_id,
      'previous_status', previous_status, 'new_status', desired_status));
END;
$rights_operator$;

CREATE FUNCTION decide_platform_rights_report(
  target_report_id uuid, desired_decision text, action_reason text, keep_evidence boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $rights_operator$
DECLARE
  actor_id uuid := public.require_platform_permission('rights_reports.manage');
  report_row public.rights_holder_reports%ROWTYPE;
  content_key text;
BEGIN
  IF target_report_id IS NULL OR desired_decision IS NULL OR desired_decision NOT IN ('takedown', 'no_action', 'insufficient_evidence')
     OR action_reason IS NULL OR length(btrim(action_reason)) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'valid decision and documented reason are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO report_row FROM public.rights_holder_reports WHERE id = target_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'rights report was not found' USING ERRCODE = 'P0002'; END IF;
  IF report_row.status NOT IN ('decision_pending', 'escalated') THEN
    RAISE EXCEPTION 'report must be decision-pending or escalated before a decision' USING ERRCODE = '23514';
  END IF;
  IF desired_decision = 'takedown' THEN
    content_key := report_row.provider_id || ':' || report_row.media_id;
    INSERT INTO public.rights_content_blocks
      (workspace_id, content_id, blocked_by_user_id, reason, preserve_evidence)
    VALUES (report_row.workspace_id, content_key, actor_id, btrim(action_reason), keep_evidence)
    ON CONFLICT (workspace_id, content_id) DO UPDATE
      SET blocked_by_user_id = EXCLUDED.blocked_by_user_id,
          reason = EXCLUDED.reason, preserve_evidence = EXCLUDED.preserve_evidence, blocked_at = now();
  END IF;
  UPDATE public.rights_holder_reports
     SET decision = desired_decision, decision_reason = btrim(action_reason),
         decided_by_user_id = actor_id, decided_at = now(), status = 'closed', updated_at = now()
   WHERE id = target_report_id;
  INSERT INTO public.rights_report_events
    (workspace_id, report_id, actor_user_id, from_status, to_status, reason, details)
  VALUES (report_row.workspace_id, target_report_id, actor_id, report_row.status, 'closed',
    btrim(action_reason), jsonb_build_object('decision', desired_decision,
      'content_blocked', desired_decision = 'takedown', 'content_id', content_key,
      'preserve_evidence', keep_evidence));
  INSERT INTO public.platform_administration_audit (actor_user_id, action, reason, details)
  VALUES (actor_id, 'rights_report.decided', btrim(action_reason),
    jsonb_build_object('report_id', target_report_id, 'workspace_id', report_row.workspace_id,
      'provider_id', report_row.provider_id, 'media_id', report_row.media_id,
      'decision', desired_decision, 'content_id', content_key, 'preserve_evidence', keep_evidence));
END;
$rights_operator$;

CREATE FUNCTION disable_platform_rights_provider_path(target_workspace_id uuid, provider text, action_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $rights_operator$
DECLARE actor_id uuid := public.require_platform_permission('rights_reports.manage');
BEGIN
  IF target_workspace_id IS NULL OR provider IS NULL OR length(btrim(provider)) NOT BETWEEN 1 AND 80
     OR action_reason IS NULL OR length(btrim(action_reason)) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'workspace, provider, and documented reason are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = target_workspace_id) THEN
    RAISE EXCEPTION 'workspace was not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.workspace_provider_path_restrictions
    (workspace_id, provider_id, disabled_by_user_id, reason, disabled_at)
  VALUES (target_workspace_id, lower(btrim(provider)), actor_id, btrim(action_reason), now())
  ON CONFLICT (workspace_id, provider_id) DO UPDATE
    SET disabled_by_user_id = EXCLUDED.disabled_by_user_id, reason = EXCLUDED.reason, disabled_at = now();
  INSERT INTO public.platform_administration_audit (actor_user_id, action, reason, details)
  VALUES (actor_id, 'rights_provider_path.disabled', btrim(action_reason),
    jsonb_build_object('workspace_id', target_workspace_id, 'provider_id', lower(btrim(provider))));
END;
$rights_operator$;

CREATE FUNCTION get_platform_repeat_infringer_summary(target_workspace_id uuid)
RETURNS TABLE (workspace_id uuid, workspace_name text, substantiated_case_count bigint,
  threshold integer, threshold_reached boolean, workspace_status workspace_status)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $rights_operator$
BEGIN
  PERFORM public.require_platform_permission('rights_reports.manage');
  RETURN QUERY
    SELECT workspace.id, workspace.name,
      count(DISTINCT report.provider_id || ':' || report.media_id) FILTER (WHERE report.decision = 'takedown'),
      3,
      count(DISTINCT report.provider_id || ':' || report.media_id) FILTER (WHERE report.decision = 'takedown') >= 3,
      workspace.status
    FROM public.workspaces workspace
    LEFT JOIN public.rights_holder_reports report ON report.workspace_id = workspace.id
    WHERE workspace.id = target_workspace_id
    GROUP BY workspace.id, workspace.name, workspace.status;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace was not found' USING ERRCODE = 'P0002'; END IF;
END;
$rights_operator$;

CREATE FUNCTION restrict_platform_repeat_infringer_workspace(target_workspace_id uuid, action_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $rights_operator$
DECLARE
  actor_id uuid := public.require_platform_permission('rights_reports.manage');
  substantiated_count bigint;
  current_status workspace_status;
  previous_reason text := current_setting('app.platform_status_reason', true);
BEGIN
  IF target_workspace_id IS NULL OR action_reason IS NULL
     OR length(btrim(action_reason)) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'workspace and documented reason are required' USING ERRCODE = '22023';
  END IF;
  SELECT workspace.status,
    (SELECT count(DISTINCT report.provider_id || ':' || report.media_id)
       FROM public.rights_holder_reports report
      WHERE report.workspace_id = workspace.id AND report.decision = 'takedown')
    INTO current_status, substantiated_count
    FROM public.workspaces workspace WHERE workspace.id = target_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace was not found' USING ERRCODE = 'P0002'; END IF;
  IF substantiated_count < 3 THEN RAISE EXCEPTION 'repeat-infringer threshold has not been reached' USING ERRCODE = '23514'; END IF;
  IF current_status <> 'active' THEN RAISE EXCEPTION 'workspace is not active and cannot be newly restricted' USING ERRCODE = '23514'; END IF;
  PERFORM set_config('app.platform_status_reason', btrim(action_reason), true);
  UPDATE public.workspaces SET status = 'restricted', restriction_reason = btrim(action_reason), updated_at = now()
   WHERE id = target_workspace_id;
  PERFORM set_config('app.platform_status_reason', COALESCE(previous_reason, ''), true);
  INSERT INTO public.platform_administration_audit (actor_user_id, action, reason, details)
  VALUES (actor_id, 'rights_repeat_infringer.restricted', btrim(action_reason),
    jsonb_build_object('workspace_id', target_workspace_id, 'substantiated_case_count', substantiated_count, 'threshold', 3));
END;
$rights_operator$;

REVOKE ALL ON FUNCTION list_platform_rights_reports(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_platform_rights_report_events(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_platform_rights_report(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION transition_platform_rights_report(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION decide_platform_rights_report(uuid, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION disable_platform_rights_provider_path(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_platform_repeat_infringer_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION restrict_platform_repeat_infringer_workspace(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_platform_rights_reports(text, text) TO platform_runtime;
GRANT EXECUTE ON FUNCTION get_platform_rights_report_events(uuid) TO platform_runtime;
GRANT EXECUTE ON FUNCTION assign_platform_rights_report(uuid, uuid, text) TO platform_runtime;
GRANT EXECUTE ON FUNCTION transition_platform_rights_report(uuid, text, text) TO platform_runtime;
GRANT EXECUTE ON FUNCTION decide_platform_rights_report(uuid, text, text, boolean) TO platform_runtime;
GRANT EXECUTE ON FUNCTION disable_platform_rights_provider_path(uuid, text, text) TO platform_runtime;
GRANT EXECUTE ON FUNCTION get_platform_repeat_infringer_summary(uuid) TO platform_runtime;
GRANT EXECUTE ON FUNCTION restrict_platform_repeat_infringer_workspace(uuid, text) TO platform_runtime;

COMMIT;
