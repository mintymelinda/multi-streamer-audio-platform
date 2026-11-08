export type WorkspaceRole = 'owner' | 'admin' | 'moderator' | 'viewer';
export type WorkspacePermission =
  | 'workspace:read'
  | 'workspace:manage'
  | 'team:manage'
  | 'team:assign_admin'
  | 'team:revoke';

const permissionsByRole: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  owner: new Set([
    'workspace:read',
    'workspace:manage',
    'team:manage',
    'team:assign_admin',
    'team:revoke',
  ]),
  admin: new Set(['workspace:read', 'workspace:manage', 'team:manage', 'team:revoke']),
  moderator: new Set(['workspace:read']),
  viewer: new Set(['workspace:read']),
};

export function hasWorkspacePermission(
  role: WorkspaceRole,
  permission: WorkspacePermission,
): boolean {
  return permissionsByRole[role].has(permission);
}
