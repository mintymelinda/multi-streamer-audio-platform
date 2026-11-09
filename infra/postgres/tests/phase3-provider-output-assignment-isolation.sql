\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
DO $$
DECLARE ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); wa uuid := gen_random_uuid(); wb uuid := gen_random_uuid();
 ia uuid := gen_random_uuid(); ia2 uuid := gen_random_uuid(); ib uuid := gen_random_uuid();
BEGIN
 PERFORM set_config('app.user_id', ua::text, true);
 INSERT INTO platform_users (id,twitch_user_id) VALUES (ua,'920000001');
 PERFORM set_config('app.user_id', ub::text, true);
 INSERT INTO platform_users (id,twitch_user_id) VALUES (ub,'920000002');
 PERFORM set_config('app.user_id', ua::text, true);
 INSERT INTO workspaces (id,name,owner_user_id,broadcaster_twitch_user_id) VALUES (wa,'Output A',ua,'920000001');
 INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES (wa,ua,'owner');
 PERFORM set_config('app.user_id', ub::text, true);
 INSERT INTO workspaces (id,name,owner_user_id,broadcaster_twitch_user_id) VALUES (wb,'Output B',ub,'920000002');
 INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES (wb,ub,'owner');
 PERFORM set_config('app.user_id', ua::text, true); PERFORM set_config('app.workspace_id', wa::text, true);
 INSERT INTO provider_instances (id,workspace_id,provider_id,instance_key,contract_version)
 VALUES (ia,wa,'youtube','yt-primary',1),(ia2,wa,'spotify','spotify-primary',1);
 INSERT INTO provider_output_assignments (workspace_id,provider_instance_id,output_id,player_id,assigned_by)
 VALUES (wa,ia,'main-output','player-a',ua);
 BEGIN
  INSERT INTO provider_output_assignments (workspace_id,provider_instance_id,output_id,player_id,assigned_by)
  VALUES (wa,ia2,'main-output','player-a',ua);
  RAISE EXCEPTION 'competing output assignment unexpectedly succeeded';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 UPDATE provider_output_assignments SET active=false WHERE workspace_id=wa AND provider_instance_id=ia;
 INSERT INTO provider_output_assignments (workspace_id,provider_instance_id,output_id,player_id,assigned_by)
 VALUES (wa,ia2,'main-output','player-a',ua);
 PERFORM set_config('app.user_id', ub::text, true); PERFORM set_config('app.workspace_id', wb::text, true);
 INSERT INTO provider_instances (id,workspace_id,provider_id,instance_key,contract_version) VALUES (ib,wb,'youtube','yt-primary',1);
 INSERT INTO provider_output_assignments (workspace_id,provider_instance_id,output_id,player_id,assigned_by)
 VALUES (wb,ib,'main-output','player-b',ub);
 IF (SELECT count(*) FROM provider_output_assignments WHERE output_id='main-output') <> 1 THEN
  RAISE EXCEPTION 'cross-workspace output assignment isolation failed';
 END IF;
END;
$$;
ROLLBACK;
