import assert from 'node:assert/strict';
import test from 'node:test';
import { TwitchRewardsService } from '../dist/integrations/twitch-rewards.service.js';

const workspace = { id: '11111111-1111-4111-8111-111111111111' };
const actor = { id: '22222222-2222-4222-8222-222222222222' };

function mapping(id, rewardId, title, prompt, cost) {
  return {
    id,
    twitch_reward_id: rewardId,
    reward_title: title,
    reward_prompt: prompt,
    reward_cost: cost,
  };
}

test('reconciles linked rewards as synced, attention-required, or deleted without guessing on missing metadata', async () => {
  const rows = [
    mapping('mapping-1', 'reward-match', 'Media request', 'Enter a URL', 500),
    mapping('mapping-2', 'reward-changed', 'Old title', 'Enter a URL', 500),
    mapping('mapping-3', 'reward-deleted', 'Deleted reward', null, 250),
  ];
  const updates = [];
  const client = {
    async query(sql, values = []) {
      if (sql.includes('FOR UPDATE')) return { rows };
      if (sql.includes('UPDATE twitch_reward_mappings')) {
        updates.push({ sql, values });
        return { rows: [] };
      }
      throw new Error('Unexpected SQL in reward reconciliation test.');
    },
  };
  const database = {
    async transaction(_context, operation) {
      return operation(client);
    },
  };
  const helix = {
    async listCustomRewards() {
      return [
        {
          id: 'reward-match',
          title: 'Media request',
          prompt: 'Enter a URL',
          cost: 500,
        },
        {
          id: 'reward-changed',
          title: 'New title',
          prompt: 'Enter a URL',
          cost: 750,
        },
      ];
    },
  };
  const service = new TwitchRewardsService(database, {}, helix);
  const remote = await service.listRemoteRewards(workspace, actor);
  assert.equal(remote.length, 2);
  assert.equal(updates.length, 3);
  assert.deepEqual(updates.map((entry) => entry.values[2]), [
    'synced',
    'attention_required',
    'deleted_on_twitch',
  ]);
  assert.equal(updates[1].values[3], 'reward_metadata_changed');
  assert.equal(updates[2].values[3], 'reward_missing_on_twitch');
  assert.match(updates[2].sql, /enabled = false/);
});

test('linking an existing reward verifies it with Twitch and stores Twitch-owned metadata', async () => {
  const insertValues = [];
  let insertSql = '';
  const client = {
    async query(sql, values = []) {
      if (sql.includes('INSERT INTO twitch_reward_mappings')) {
        insertSql = sql;
        insertValues.push(values);
        return {
          rows: [
            {
              id: 'mapping-1',
              workspace_id: workspace.id,
              twitch_reward_id: 'reward-verified',
              reward_title: 'Canonical Twitch title',
              reward_prompt: 'Canonical prompt',
              reward_cost: 900,
              feature_key: 'media_request',
              feature_settings: { inputMode: 'url_only', priority: 10 },
              enabled: true,
              sync_state: 'synced',
              last_synced_at: new Date(),
              last_sync_error_code: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const database = {
    async transaction(_context, operation) {
      return operation(client);
    },
  };
  const outbox = { async append() {} };
  const helix = {
    async listCustomRewards() {
      return [
        {
          id: 'reward-verified',
          title: 'Canonical Twitch title',
          prompt: 'Canonical prompt',
          cost: 900,
        },
      ];
    },
  };
  const service = new TwitchRewardsService(database, outbox, helix);
  const result = await service.linkExistingReward(workspace, actor, {
    rewardId: 'reward-verified',
    featureKey: 'media_request',
    featureSettings: { inputMode: 'url_only', priority: 10 },
  });
  assert.equal(result.reward_title, 'Canonical Twitch title');
  assert.equal(insertValues[0][2], 'Canonical Twitch title');
  assert.equal(insertValues[0][3], 'Canonical prompt');
  assert.equal(insertValues[0][4], 900);
  assert.match(insertSql, /'synced'/);
});

test('refuses to link a reward that is not owned by the connected broadcaster', async () => {
  const database = {
    async transaction() {
      throw new Error('Database must not be written for an unverified reward.');
    },
  };
  const helix = { async listCustomRewards() { return []; } };
  const service = new TwitchRewardsService(database, {}, helix);
  await assert.rejects(
    service.linkExistingReward(workspace, actor, {
      rewardId: 'not-owned',
      featureKey: 'media_request',
      featureSettings: { inputMode: 'url_or_search', priority: 0 },
    }),
    (error) => error instanceof Error && 'getStatus' in error && error.getStatus() === 404,
  );
});
