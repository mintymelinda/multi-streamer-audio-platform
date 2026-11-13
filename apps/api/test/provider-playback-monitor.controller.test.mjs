import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { ProviderPlaybackMonitorController } from '../dist/providers/provider-playback-monitor.controller.js';

const payload={
 playbackSessionId:'60000000-0000-4000-8000-000000000006',
 executionStateId:'10000000-0000-4000-8000-000000000001',
 workspaceId:'20000000-0000-4000-8000-000000000002',
 requestId:'30000000-0000-4000-8000-000000000003',
 providerInstanceId:'40000000-0000-4000-8000-000000000004',
 dispatchGeneration:3,
 actorUserId:'50000000-0000-4000-8000-000000000005',
};
const secret='monitor-test-secret';

function signedHeaders(body){
 const timestamp=String(Math.floor(Date.now()/1000));
 const signature=createHmac('sha256',secret).update(`${timestamp}.${JSON.stringify(body)}`).digest('hex');
 return {timestamp,signature};
}

function harness({sessionStatus='playing',observation,sessionExists=true}={}){
 const queries=[];
 const dispatches=[];
 const database={
  transaction:async(_context,callback)=>callback({
   query:async(sql,values)=>{
    queries.push({sql,values});
    if(sql.includes('FROM public.playback_sessions session')){
     return {rows:sessionExists?[{
      id:payload.playbackSessionId,status:sessionStatus,expected_duration_ms:'180000',
      observed_position_ms:null,observed_duration_ms:null,observed_status:null,observed_at:null,
      queue_advance_pending:sessionStatus==='completed',output_id:'output-a',player_id:'player-a',
     }]:[],rowCount:sessionExists?1:0};
    }
    if(sql.includes('SELECT session.id')) return {rows:[{id:payload.playbackSessionId}],rowCount:1};
    return {rows:[],rowCount:1};
   },
  }),
 };
 const coordinator={
  observePlaybackState:async(input)=>{queries.push({coordinatorInput:input});return observation??null;},
 };
 const queueManager={
  dispatchNext:async(input)=>{dispatches.push(input);return {status:'empty'};},
 };
 return {controller:new ProviderPlaybackMonitorController(database,coordinator,queueManager),queries,dispatches};
}
async function invoke(controller,body=payload){
 process.env.PROVIDER_EXECUTION_HANDOFF_SECRET=secret;
 const headers=signedHeaders(body);
 return controller.monitor(body,headers.timestamp,headers.signature);
}

test('completes the exact durable session and dispatch generation from provider end-of-track evidence',async()=>{
 const h=harness({observation:{status:'stopped',positionMs:180000,durationMs:180000,providerPlaybackId:'reused-index-2'}});
 const result=await invoke(h.controller);
 assert.deepEqual(result,{accepted:true,status:'completed'});
 assert.equal(h.queries.some(({sql})=>sql?.includes("SET status = 'completed'")),true);
 assert.deepEqual(h.dispatches,[{workspaceId:payload.workspaceId,actorId:payload.actorUserId}]);
 assert.equal(h.queries.some(({coordinatorInput})=>coordinatorInput?.idempotencyKey===
  `playback-monitor:${payload.playbackSessionId}:${payload.dispatchGeneration}`),true);
});

test('does not use a reusable Lyrion playlist index as the logical session identity',async()=>{
 const h=harness({observation:{status:'stopped',positionMs:180000,durationMs:180000,providerPlaybackId:'a-different-reused-index'}});
 assert.deepEqual(await invoke(h.controller),{accepted:true,status:'completed'});
});

test('rejects stale playback-session and dispatch-generation identities',async()=>{
 const h=harness({sessionExists:false,observation:{status:'stopped',positionMs:180000,durationMs:180000}});
 assert.deepEqual(await invoke(h.controller),{accepted:true,status:'stale'});
 assert.equal(h.queries.some(({coordinatorInput})=>Boolean(coordinatorInput)),false);
 assert.equal(h.dispatches.length,0);
});

test('marks an early stop uncertain without completing or advancing the queue',async()=>{
 const h=harness({observation:{status:'stopped',positionMs:60000,durationMs:180000}});
 assert.deepEqual(await invoke(h.controller),{accepted:true,status:'stopped_before_end'});
 assert.equal(h.queries.some(({sql})=>sql?.includes("status = $4")),true);
 assert.equal(h.queries.some(({sql})=>sql?.includes("SET status = 'completed'")),false);
 assert.equal(h.dispatches.length,0);
});

test('does not complete a paused session even when provider reports stopped at the end',async()=>{
 const h=harness({sessionStatus:'paused',observation:{status:'stopped',positionMs:180000,durationMs:180000}});
 assert.deepEqual(await invoke(h.controller),{accepted:true,status:'stopped_before_end'});
 assert.equal(h.dispatches.length,0);
});

test('does not complete when provider duration differs materially from expected session duration',async()=>{
 const h=harness({observation:{status:'stopped',positionMs:180000,durationMs:90000}});
 assert.deepEqual(await invoke(h.controller),{accepted:true,status:'stopped_before_end'});
 assert.equal(h.dispatches.length,0);
});

test('retries queue advancement for a completed session whose acknowledgement is missing',async()=>{
 const h=harness({sessionStatus:'completed'});
 assert.deepEqual(await invoke(h.controller),{accepted:true,status:'queue_advanced'});
 assert.deepEqual(h.dispatches,[{workspaceId:payload.workspaceId,actorId:payload.actorUserId}]);
 assert.equal(h.queries.some(({sql})=>sql?.includes('queue_advance_dispatched_at')),true);
});

test('does not complete or advance a paused provider observation',async()=>{
 const h=harness({observation:{status:'paused',positionMs:80000,durationMs:180000}});
 assert.deepEqual(await invoke(h.controller),{accepted:true,status:'paused'});
 assert.equal(h.dispatches.length,0);
});


test('uses a recent near-end observation from the same durable session when stop resets provider time',async()=>{
 const h=harness({observation:{status:'stopped',positionMs:0,durationMs:0}});
 const load=h.controller.loadSession;
 h.controller.loadSession=async(payloadValue)=>{
  const session=await load.call(h.controller,payloadValue);
  return session?{
   ...session,observed_position_ms:'179000',observed_duration_ms:'180000',
   observed_status:'playing',observed_at:new Date().toISOString(),
  }:null;
 };
 assert.deepEqual(await invoke(h.controller),{accepted:true,status:'completed'});
 assert.equal(h.queries.some(({sql,values})=>
  sql?.includes("SET status = 'completed'") &&
  values?.[0]===179000 && values?.[1]===180000),true);
});

test('does not infer completion from a stale previously observed near-end sample',async()=>{
 const h=harness({observation:{status:'stopped',positionMs:0,durationMs:0}});
 const load=h.controller.loadSession;
 h.controller.loadSession=async(payloadValue)=>{
  const session=await load.call(h.controller,payloadValue);
  return session?{
   ...session,observed_position_ms:'179000',observed_duration_ms:'180000',
   observed_status:'playing',observed_at:new Date(Date.now()-30_000).toISOString(),
  }:null;
 };
 assert.deepEqual(await invoke(h.controller),{accepted:true,status:'stopped_before_end'});
 assert.equal(h.dispatches.length,0);
});
