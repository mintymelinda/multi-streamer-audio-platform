import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderExecutionHandoffSignature, handoffValidatedProviderExecution, parseProviderExecutionJob, validateProviderExecutionJob, deferProviderExecutionJob, listActivePlaybackSessions, monitorPlaybackSession } from '../dist/provider-execution-consumer.service.js';
const job={executionStateId:'10000000-0000-4000-8000-000000000001',workspaceId:'20000000-0000-4000-8000-000000000002',requestId:'30000000-0000-4000-8000-000000000003',providerInstanceId:'40000000-0000-4000-8000-000000000004',dispatchGeneration:7};
test('parses complete UUID-bound jobs with a positive generation',()=>{
 assert.deepEqual(parseProviderExecutionJob(job),job);
 assert.throws(()=>parseProviderExecutionJob({...job,workspaceId:'not-a-uuid'}),/invalid_provider_execution_workspace_id/);
 assert.throws(()=>parseProviderExecutionJob({...job,dispatchGeneration:0}),/invalid_provider_execution_generation/);
});
test('validates all job identity fields and generation through PostgreSQL',async()=>{
 const calls=[]; const expected={execution_state_id:job.executionStateId,workspace_id:job.workspaceId};
 const pool={query:async(sql,values)=>{calls.push({sql,values});return {rows:[expected]};}};
 assert.deepEqual(await validateProviderExecutionJob(pool,job),expected);
 assert.match(calls[0].sql,/platform_validate_provider_execution_job/);
 assert.deepEqual(calls[0].values,[job.executionStateId,job.workspaceId,job.requestId,job.providerInstanceId,job.dispatchGeneration]);
});
test('defers a blocked queued job through the restricted database function',async()=>{
 const calls=[]; const pool={query:async(sql,values)=>{calls.push({sql,values});return {rows:[{deferred:true}]};}};
 assert.equal(await deferProviderExecutionJob(pool,job),true);
 assert.match(calls[0].sql,/platform_defer_provider_execution_job/);
 assert.deepEqual(calls[0].values,[job.executionStateId,job.workspaceId,job.requestId,job.providerInstanceId,job.dispatchGeneration]);
});
test('treats stale or mismatched jobs as terminal no-ops',async()=>{
 assert.equal(await validateProviderExecutionJob({query:async()=>({rows:[]})},job),null);
});

test('signs and submits only validated execution identity to the API handoff', async () => {
 const validated = {
  execution_state_id:job.executionStateId, workspace_id:job.workspaceId,
  request_id:job.requestId, provider_instance_id:job.providerInstanceId,
  dispatch_generation:job.dispatchGeneration, actor_user_id:'50000000-0000-4000-8000-000000000005',
 };
 let request;
 const result = await handoffValidatedProviderExecution(validated, {
  url:'https://api.example.test/internal/provider-executions/handoff',
  secret:'test-provider-execution-handoff-secret-at-least-32-bytes',
  now:()=>1794500001000,
  fetchImpl:async (url, options) => {
   request={url,options};
   return {ok:true,json:async()=>({accepted:true,operationId:'operation-1',status:'completed'})};
  },
 });
 assert.equal(result.operationId,'operation-1');
 assert.equal(request.url,'https://api.example.test/internal/provider-executions/handoff');
 const body=JSON.parse(request.options.body);
 assert.equal(body.actorUserId,validated.actor_user_id);
 assert.equal(body.workspaceId,job.workspaceId);
 assert.equal(request.options.headers['x-provider-execution-signature'],
  createProviderExecutionHandoffSignature(
   'test-provider-execution-handoff-secret-at-least-32-bytes',
   '1794500001', body));
 assert.equal('mediaUrl' in body,false);
});

test('does not acknowledge a failed API handoff', async () => {
 await assert.rejects(
  handoffValidatedProviderExecution({
   execution_state_id:job.executionStateId, workspace_id:job.workspaceId,
   request_id:job.requestId, provider_instance_id:job.providerInstanceId,
   dispatch_generation:job.dispatchGeneration, actor_user_id:'50000000-0000-4000-8000-000000000005',
  }, {
   url:'https://api.example.test/internal/provider-executions/handoff',
   secret:'test-provider-execution-handoff-secret-at-least-32-bytes',
   fetchImpl:async()=>({ok:false,status:503}),
  }),
  /provider_execution_handoff_http_503/,
 );
});


test('lists only durable playback sessions through the provider-worker function',async()=>{
 const row={
  playback_session_id:'60000000-0000-4000-8000-000000000006',
  execution_state_id:job.executionStateId,workspace_id:job.workspaceId,request_id:job.requestId,
  provider_instance_id:job.providerInstanceId,dispatch_generation:job.dispatchGeneration,
  actor_user_id:'50000000-0000-4000-8000-000000000005',
 };
 const calls=[];
 const rows=await listActivePlaybackSessions({query:async(sql)=>{calls.push(sql);return {rows:[row]};}});
 assert.deepEqual(rows,[row]);
 assert.match(calls[0],/platform_list_active_playback_sessions/);
});

test('signs a monitor payload with the durable session id and dispatch generation',async()=>{
 const input={
  playback_session_id:'60000000-0000-4000-8000-000000000006',
  execution_state_id:job.executionStateId,workspace_id:job.workspaceId,request_id:job.requestId,
  provider_instance_id:job.providerInstanceId,dispatch_generation:job.dispatchGeneration,
  actor_user_id:'50000000-0000-4000-8000-000000000005',
 };
 let request;
 const result=await monitorPlaybackSession(input,{
  url:'https://api.example.test/internal/provider-executions/monitor',
  secret:'test-provider-execution-handoff-secret-at-least-32-bytes',
  now:()=>1794500001000,
  fetchImpl:async(url,options)=>{
   request={url,options};
   return {ok:true,json:async()=>({accepted:true,status:'completed'})};
  },
 });
 assert.deepEqual(result,{accepted:true,status:'completed'});
 const body=JSON.parse(request.options.body);
 assert.equal(body.playbackSessionId,input.playback_session_id);
 assert.equal(body.dispatchGeneration,input.dispatch_generation);
 assert.equal('providerPlaybackId' in body,false);
 assert.equal(request.options.headers['x-provider-execution-signature'],
  createProviderExecutionHandoffSignature(
   'test-provider-execution-handoff-secret-at-least-32-bytes','1794500001',body));
});
