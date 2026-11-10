import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { TeamService } from '../dist/workspaces/team.service.js';

function makeService() {
  const statements = [];
  const database = {
    transaction: async (_context, operation) => operation({
      query: async (sql, values = []) => {
        statements.push({ sql, values });
        if (sql.includes('SELECT 1 FROM workspace_memberships')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO workspace_invitations')) return {
          rows: [{ id: values[0], workspace_id: values[1], assigned_role: values[3], status: 'pending' }],
          rowCount: 1,
        };
        return { rows: [], rowCount: 1 };
      },
    }),
  };
  const directory = { resolveUsername: async (username) => username === 'streamfriend' ? '987654' : '123456' };
  return { service: new TeamService(database, directory), statements };
}

const actor = { id: 'owner-id', twitchUserId: '123456' };
const workspaceId = 'workspace-id';

test('creates a Twitch-identity-bound Moderator invitation by default and audits it', async () => {
  const { service, statements } = makeService();
  const invitation = await service.createInvitation(actor, workspaceId, 'StreamFriend', undefined, 'owner');
  assert.equal(invitation.assigned_role, 'moderator');
  const insert = statements.find((entry) => entry.sql.includes('INSERT INTO workspace_invitations'));
  assert.equal(insert.values[2], '987654');
  assert.equal(insert.values[3], 'moderator');
  assert.ok(statements.some((entry) => entry.sql.includes('INSERT INTO audit_events')));
});

test('prevents an Admin from inviting another Admin', async () => {
  const { service } = makeService();
  await assert.rejects(
    service.createInvitation(actor, workspaceId, 'streamfriend', 'admin', 'admin'),
    ForbiddenException,
  );
});

test('rejects self-invitations before writing invitation data', async () => {
  const { service, statements } = makeService();
  await assert.rejects(
    service.createInvitation(actor, workspaceId, 'self', 'moderator', 'owner'),
  );
  assert.equal(statements.some((entry) => entry.sql.includes('INSERT INTO workspace_invitations')), false);
});
