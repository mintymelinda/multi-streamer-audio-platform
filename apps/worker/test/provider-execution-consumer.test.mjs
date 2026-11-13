import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderExecutionHandoffSignature, handoffValidatedProviderExecution, parseProviderExecutionJob, validateProviderExecutionJob, deferProviderExecutionJob, listActiveProviderPlayback, monitorProviderPlayback } from '../dist/provider-execution-consumer.service.js';
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

test('lists active provider playback through the restricted database function',async()=>{
 const row={execution_state_id:'10000000-0000-4000-8000-000000000001',workspace_id:'20000000-0000-4000-8000-000000000002',request_id:'30000000-0000-4000-8000-000000000003',provider_instance_id:'40000000-0000-4000-8000-000000000004',dispatch_generation:3,actor_user_id:'50000000-0000-4000-8000-000000000005'};
 let query;
 const rows=await listActiveProviderPlayback({query:async(sql)=>{query=sql;return {rows:[row]};}});
 assert.match(query,/platform_list_active_provider_playback/);
 assert.deepEqual(rows,[row]);
});
test('signs provider playback monitor requests and validates the response',async()=>{
 const input={execution_state_id:'10000000-0000-4000-8000-000000000001',workspace_id:'20000000-0000-4000-8000-000000000002',request_id:'30000000-0000-4000-8000-000000000003',provider_instance_id:'40000000-0000-4000-8000-000000000004',dispatch_generation:3,actor_user_id:'50000000-0000-4000-8000-000000000005'};
 let request;
 const result=await monitorProviderPlayback(input,{url:'https://api.example.test/internal/provider-executions/monitor',secret:'test-secret',now:()=>1762900000000,fetchImpl:async(url,options)=>{request={url,options,body:JSON.parse(options.body)};return {ok:true,json:async()=>({accepted:true,status:'completed'})};}});
 assert.deepEqual(result,{accepted:true,status:'completed'});
 assert.equal(request.url,'https://api.example.test/internal/provider-executions/monitor');
 assert.equal(request.options.headers['x-provider-execution-signature'],createProviderExecutionHandoffSignature('test-secret','1762900000',request.body));
 assert.deepEqual(request.body,{executionStateId:input.execution_state_id,workspaceId:input.workspace_id,requestId:input.request_id,providerInstanceId:input.provider_instance_id,dispatchGeneration:3,actorUserId:input.actor_user_id});
});
