import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProviderExecutionJob, validateProviderExecutionJob } from '../dist/provider-execution-consumer.service.js';
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
test('treats stale or mismatched jobs as terminal no-ops',async()=>{
 assert.equal(await validateProviderExecutionJob({query:async()=>({rows:[]})},job),null);
});
