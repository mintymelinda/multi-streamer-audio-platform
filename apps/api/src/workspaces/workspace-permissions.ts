export type WorkspaceRole = 'owner' | 'admin' | 'moderator' | 'viewer';
export type WorkspacePermission =
  | 'workspace:read'
  | 'workspace:manage'
  | 'team:manage'
  | 'team:assign_admin'
  | 'team:revoke'
  | 'request:submit'
  | 'request:moderate'
  | 'queue:manage';

const permissionsByRole: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  owner: new Set([
    'workspace:read',
    'workspace:manage',
    'team:manage',
    'team:assign_admin',
    'team:revoke',
    'request:submit',
    'request:moderate',
    'queue:manage',
  ]),
  admin: new Set([
    'workspace:read',
    'workspace:manage',
    'team:manage',
    'team:revoke',
    'request:submit',
    'request:moderate',
    'queue:manage',
  ]),
  moderator: new Set(['workspace:read', 'request:submit', 'request:moderate', 'queue:manage']),
  viewer: new Set(['workspace:read', 'request:submit']),
};

export function hasWorkspacePermission(
  role: WorkspaceRole,
  permission: WorkspacePermission,
): boolean {
  return permissionsByRole[role].has(permission);
}
