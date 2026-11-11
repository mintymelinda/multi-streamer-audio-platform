-- Phase 6 item 60: global rights-holder review and enforcement stays permission-gated and audited.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  admin_id uuid := gen_random_uuid();
  reviewer_id uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  ordinary_id uuid := gen_random_uuid();
  workspace_id uuid := gen_random_uuid();
  report_one uuid := gen_random_uuid();
  report_two uuid := gen_random_uuid();
  report_three uuid := gen_random_uuid();
BEGIN
  INSERT INTO platform_users (id, twitch_user_id)
  VALUES (admin_id, '990000071'), (reviewer_id, '990000072'),
         (owner_id, '990000073'), (ordinary_id, '990000074');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
  VALUES (workspace_id, 'Rights review test workspace', owner_id, '990000073');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
  VALUES (workspace_id, owner_id, 'owner');
  INSERT INTO platform_administrators (user_id, twitch_user_id, role, permissions)
  VALUES (admin_id, '990000071', 'admin', ARRAY['rights_reports.manage']),
         (reviewer_id, '990000072', 'admin', ARRAY['rights_reports.manage']);
  INSERT INTO rights_holder_reports
    (id, workspace_id, claimant_name, claimant_contact, provider_id, media_id, allegation)
  VALUES
    (report_one, workspace_id, 'Rights claimant', 'rights@example.invalid', 'spotify', 'track-1', 'Unauthorized use of protected recording.'),
    (report_two, workspace_id, 'Rights claimant', 'rights@example.invalid', 'youtube', 'video-2', 'Unauthorized use of protected recording.'),
    (report_three, workspace_id, 'Rights claimant', 'rights@example.invalid', 'lyrion', 'file-3', 'Unauthorized use of protected recording.');
  INSERT INTO rights_report_events (workspace_id, report_id, to_status, reason)
  VALUES (workspace_id, report_one, 'received', 'Rights-holder report received'),
         (workspace_id, report_two, 'received', 'Rights-holder report received'),
         (workspace_id, report_three, 'received', 'Rights-holder report received');
  PERFORM set_config('test.rights_admin_id', admin_id::text, true);
  PERFORM set_config('test.rights_reviewer_id', reviewer_id::text, true);
  PERFORM set_config('test.rights_ordinary_id', ordinary_id::text, true);
  PERFORM set_config('test.rights_workspace_id', workspace_id::text, true);
  PERFORM set_config('test.rights_report_one', report_one::text, true);
  PERFORM set_config('test.rights_report_two', report_two::text, true);
  PERFORM set_config('test.rights_report_three', report_three::text, true);
END;
$$;

SET LOCAL ROLE platform_runtime;

DO $$
DECLARE
  admin_id uuid := current_setting('test.rights_admin_id')::uuid;
  reviewer_id uuid := current_setting('test.rights_reviewer_id')::uuid;
  ordinary_id uuid := current_setting('test.rights_ordinary_id')::uuid;
  workspace_id uuid := current_setting('test.rights_workspace_id')::uuid;
  report_one uuid := current_setting('test.rights_report_one')::uuid;
  report_two uuid := current_setting('test.rights_report_two')::uuid;
  report_three uuid := current_setting('test.rights_report_three')::uuid;
  listed integer;
  blocked integer;
  threshold_hit boolean;
  workspace_state workspace_status;
BEGIN
  IF (SELECT count(*) FROM rights_holder_reports) <> 0 THEN
    RAISE EXCEPTION 'runtime role can enumerate rights reports without workspace context';
  END IF;

  PERFORM set_config('app.user_id', ordinary_id::text, true);
  BEGIN
    PERFORM * FROM list_platform_rights_reports(NULL, NULL);
    RAISE EXCEPTION 'ordinary account received rights report access';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM set_config('app.user_id', admin_id::text, true);
  SELECT count(*) INTO listed FROM list_platform_rights_reports(NULL, NULL) reports
   WHERE reports.workspace_id = workspace_id;
  IF listed <> 3 THEN RAISE EXCEPTION 'operator cannot list all workspace rights reports'; END IF;

  PERFORM assign_platform_rights_report(report_one, reviewer_id, 'Assign to qualified rights reviewer');
  PERFORM transition_platform_rights_report(report_one, 'investigating', 'Begin documented rights review');
  PERFORM transition_platform_rights_report(report_one, 'decision_pending', 'Evidence review is complete');
  PERFORM decide_platform_rights_report(report_one, 'takedown', 'Substantiated unauthorized content use', true);

  PERFORM transition_platform_rights_report(report_two, 'investigating', 'Begin second rights review');
  PERFORM transition_platform_rights_report(report_two, 'decision_pending', 'Second evidence review is complete');
  PERFORM decide_platform_rights_report(report_two, 'takedown', 'Second substantiated content use', true);

  PERFORM transition_platform_rights_report(report_three, 'investigating', 'Begin third rights review');
  PERFORM transition_platform_rights_report(report_three, 'decision_pending', 'Third evidence review is complete');
  PERFORM decide_platform_rights_report(report_three, 'takedown', 'Third substantiated content use', true);

  SELECT threshold_reached INTO threshold_hit
    FROM get_platform_repeat_infringer_summary(workspace_id);
  IF threshold_hit IS DISTINCT FROM true THEN RAISE EXCEPTION 'repeat-infringer threshold was not reached'; END IF;

  PERFORM restrict_platform_repeat_infringer_workspace(workspace_id, 'Three distinct substantiated rights violations');

  SELECT count(*) INTO listed FROM get_platform_rights_report_events(report_one);
  IF listed < 4 THEN RAISE EXCEPTION 'rights report event history is incomplete'; END IF;
END;
$$;

RESET ROLE;

DO $rights_test$
DECLARE
  workspace_id uuid := current_setting('test.rights_workspace_id')::uuid;
  blocked integer;
  workspace_state workspace_status;
  audit_count integer;
BEGIN
  SELECT count(*) INTO blocked FROM rights_content_blocks blocks
   WHERE blocks.workspace_id = current_setting('test.rights_workspace_id')::uuid AND blocks.content_id = 'spotify:track-1' AND blocks.preserve_evidence = true;
  IF blocked <> 1 THEN RAISE EXCEPTION 'takedown decision did not create evidence-preserving content block'; END IF;
  SELECT status INTO workspace_state FROM workspaces WHERE id = current_setting('test.rights_workspace_id')::uuid;
  IF workspace_state <> 'restricted' THEN RAISE EXCEPTION 'repeat infringer workspace was not restricted'; END IF;
  SELECT count(*) INTO audit_count FROM platform_administration_audit
   WHERE action IN ('rights_report.reviewer_assigned', 'rights_report.status_changed',
                    'rights_report.decided', 'rights_repeat_infringer.restricted');
  IF audit_count < 10 THEN RAISE EXCEPTION 'rights operator actions were not fully audited'; END IF;
END;
$rights_test$;

ROLLBACK;
