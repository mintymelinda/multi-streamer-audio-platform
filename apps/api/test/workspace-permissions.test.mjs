import assert from 'node:assert/strict';
import test from 'node:test';
import { hasWorkspacePermission } from '../src/workspaces/workspace-permissions.ts';

test('owner has all initial workspace and team permissions', () => {
  for (const permission of [
    'workspace:read', 'workspace:manage', 'team:manage', 'team:assign_admin', 'team:revoke',
  ]) {
    assert.equal(hasWorkspacePermission('owner', permission), true);
  }
});

test('admin can manage workspace and team but cannot assign another admin', () => {
  assert.equal(hasWorkspacePermission('admin', 'workspace:manage'), true);
  assert.equal(hasWorkspacePermission('admin', 'team:manage'), true);
  assert.equal(hasWorkspacePermission('admin', 'team:revoke'), true);
  assert.equal(hasWorkspacePermission('admin', 'team:assign_admin'), false);
});

test('moderator and viewer have read-only workspace access', () => {
  for (const role of ['moderator', 'viewer']) {
    assert.equal(hasWorkspacePermission(role, 'workspace:read'), true);
    assert.equal(hasWorkspacePermission(role, 'workspace:manage'), false);
    assert.equal(hasWorkspacePermission(role, 'team:manage'), false);
  }
});
