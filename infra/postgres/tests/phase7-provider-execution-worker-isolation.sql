-- Verify separate worker identity and persisted user/Twitch actor paths.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE owner_id uuid:=gen_random_uuid(); submitter_id uuid:=gen_random_uuid(); workspace_id uuid:=gen_random_uuid();
 provider_id uuid:=gen_random_uuid(); user_request_id uuid:=gen_random_uuid(); twitch_request_id uuid:=gen_random_uuid();
 user_execution_id uuid:=gen_random_uuid(); twitch_execution_id uuid:=gen_random_uuid(); delivery_id uuid:=gen_random_uuid();
BEGIN
 INSERT INTO platform_users (id,twitch_user_id) VALUES (owner_id,'970000001'),(submitter_id,'970000002');
 INSERT INTO workspaces (id,name,owner_user_id,broadcaster_twitch_user_id) VALUES (workspace_id,'Provider worker authorization',owner_id,'970000001');
 INSERT INTO workspace_memberships (workspace_id,user_id,role,status) VALUES
  (workspace_id,owner_id,'owner','active'),(workspace_id,submitter_id,'viewer','active');
 INSERT INTO provider_instances (id,workspace_id,provider_id,instance_key,contract_version,capabilities,connection_health)
 VALUES (provider_id,workspace_id,'youtube','worker-validation',1,'{"resolve":true,"playback":true}'::jsonb,'healthy');
 INSERT INTO provider_output_assignments (workspace_id,provider_instance_id,output_id,player_id,assigned_by)
 VALUES (workspace_id,provider_id,'output-1','player-1',owner_id);
 INSERT INTO media_requests (id,workspace_id,source,submitted_by_user_id,media_id,title,status,source_event_id) VALUES
  (user_request_id,workspace_id,'dashboard',submitter_id,'media-user','User request','queued',NULL),
  (twitch_request_id,workspace_id,'twitch_reward',NULL,'media-twitch','Twitch request','queued','twitch-redemption-1');
 INSERT INTO logical_queue_entries (workspace_id,request_id,priority,sequence) VALUES
  (workspace_id,user_request_id,0,1),(workspace_id,twitch_request_id,0,2);
 INSERT INTO provider_execution_states (id,workspace_id,request_id,provider_instance_id,state,dispatch_generation) VALUES
  (user_execution_id,workspace_id,user_request_id,provider_id,'queued',3),
  (twitch_execution_id,workspace_id,twitch_request_id,provider_id,'queued',4);
 INSERT INTO twitch_eventsub_subscriptions (subscription_id,workspace_id,event_type,event_version,status,secret_envelope,service_actor_user_id)
 VALUES ('provider-worker-subscription',workspace_id,'channel.channel_points_custom_reward_redemption.add','1','enabled','{"formatVersion":1}'::jsonb,owner_id);
 INSERT INTO twitch_eventsub_deliveries (id,workspace_id,subscription_id,message_id,message_type,payload,status,service_actor_user_id,processed_at)
 VALUES (delivery_id,workspace_id,'provider-worker-subscription','provider-worker-message','notification','{}'::jsonb,'processed',owner_id,now());
 INSERT INTO twitch_eventsub_intake (workspace_id,delivery_id,subscription_id,message_id,message_type,event_type,event_version,event_id,service_actor_user_id,routing_status,routed_request_id)
 VALUES (workspace_id,delivery_id,'provider-worker-subscription','provider-worker-message','notification',
  'channel.channel_points_custom_reward_redemption.add','1','twitch-redemption-1',owner_id,'processed',twitch_request_id);
 PERFORM set_config('test.owner_id',owner_id::text,true); PERFORM set_config('test.submitter_id',submitter_id::text,true);
 PERFORM set_config('test.workspace_id',workspace_id::text,true); PERFORM set_config('test.provider_id',provider_id::text,true);
 PERFORM set_config('test.user_request_id',user_request_id::text,true); PERFORM set_config('test.twitch_request_id',twitch_request_id::text,true);
 PERFORM set_config('test.user_execution_id',user_execution_id::text,true); PERFORM set_config('test.twitch_execution_id',twitch_execution_id::text,true);
END $$;
SET LOCAL SESSION AUTHORIZATION platform_provider_worker;
DO $$
DECLARE workspace_id uuid:=current_setting('test.workspace_id')::uuid; provider_id uuid:=current_setting('test.provider_id')::uuid;
 user_request_id uuid:=current_setting('test.user_request_id')::uuid; twitch_request_id uuid:=current_setting('test.twitch_request_id')::uuid;
 user_execution_id uuid:=current_setting('test.user_execution_id')::uuid; twitch_execution_id uuid:=current_setting('test.twitch_execution_id')::uuid;
 owner_id uuid:=current_setting('test.owner_id')::uuid; submitter_id uuid:=current_setting('test.submitter_id')::uuid;
BEGIN
 IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=session_user) THEN RAISE EXCEPTION 'provider worker login must not bypass RLS'; END IF;
 IF has_table_privilege(session_user,'media_requests','SELECT') OR has_table_privilege(session_user,'provider_credentials','SELECT')
   OR has_table_privilege(session_user,'provider_execution_states','UPDATE') THEN RAISE EXCEPTION 'worker has direct tenant-table access'; END IF;
 IF NOT EXISTS (SELECT 1 FROM platform_validate_provider_execution_job(user_execution_id,workspace_id,user_request_id,provider_id,3) v
   WHERE v.actor_user_id=submitter_id AND v.request_source='dashboard') THEN RAISE EXCEPTION 'user request actor path failed'; END IF;
 IF NOT EXISTS (SELECT 1 FROM platform_validate_provider_execution_job(twitch_execution_id,workspace_id,twitch_request_id,provider_id,4) v
   WHERE v.actor_user_id=owner_id AND v.request_source='twitch_reward') THEN RAISE EXCEPTION 'Twitch service actor path failed'; END IF;
 IF EXISTS (SELECT 1 FROM platform_validate_provider_execution_job(user_execution_id,workspace_id,user_request_id,provider_id,2))
 THEN RAISE EXCEPTION 'stale dispatch generation was accepted'; END IF;
 IF EXISTS (SELECT 1 FROM platform_validate_provider_execution_job(user_execution_id,gen_random_uuid(),user_request_id,provider_id,3))
 THEN RAISE EXCEPTION 'mismatched workspace was accepted'; END IF;
END $$;
ROLLBACK;
