import {
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { HttpRequest } from '../identity/http.types.js';
import { hasWorkspacePermission, type WorkspacePermission } from './workspace-permissions.js';

const PERMISSION_METADATA = 'workspace-permission';

export function RequireWorkspacePermission(permission: WorkspacePermission) {
  return SetMetadata(PERMISSION_METADATA, permission);
}

@Injectable()
export class WorkspacePermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<WorkspacePermission>(
      PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) return true;
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (!request.workspace || !hasWorkspacePermission(request.workspace.role, permission)) {
      throw new ForbiddenException('You do not have permission to perform this workspace action.');
    }
    return true;
  }
}
