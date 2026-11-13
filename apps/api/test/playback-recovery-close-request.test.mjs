import assert from 'node:assert/strict';
import test from 'node:test';
import { closeRequest } from '../dist/playback/playback-recovery.module.js';

test('manual recovery closes active durable playback sessions atomically with request skip', async () => {
  const statements=[];
  const database={
    transaction:async(context,callback)=>{
      assert.deepEqual(context,{userId:'owner-a',verifiedWorkspaceId:'workspace-a'});
      return callback({
        query:async(sql,values)=>{
          statements.push({sql,values});
          if(sql.includes('SELECT status FROM media_requests')) {
            return {rows:[{status:'playing'}],rowCount:1};
          }
          return {rows:[],rowCount:1};
        },
      });
    },
  };
  await closeRequest(database,{
    id:'request-a',workspaceId:'workspace-a',mediaId:'media-a',status:'playing',
  },'owner-a','skipped','Stuck output manually recovered');

  const close=statements.find(({sql})=>sql.includes('UPDATE playback_sessions'));
  assert.ok(close);
  assert.match(close.sql,/status = 'interrupted'/);
  assert.match(close.sql,/status IN ('playing', 'paused', 'uncertain')/);
  assert.deepEqual(close.values,['workspace-a','request-a']);
  const history=statements.findIndex(({sql})=>sql.includes('INSERT INTO request_state_history'));
  const sessionClose=statements.indexOf(close);
  assert.ok(sessionClose>0 && history>sessionClose);
});
