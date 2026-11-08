import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { HttpRequest, WorkspaceRequestContext } from '../identity/http.types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class WorkspaceAccessGuard implements CanActivate {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const workspaceId = request.params?.workspaceId;
    const user = request.user;
    if (typeof workspaceId !== 'string' || !UUID_PATTERN.test(workspaceId) || !user) {
      throw new NotFoundException('Workspace not found.');
    }
    const userId = user.id;
    const result = await this.database.transaction({ userId, workspaceId }, (client) =>
      client.query<{
        role: WorkspaceRequestContext['role'];
        status: WorkspaceRequestContext['status'];
      }>(
        "SELECT m.role, w.status FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.status = 'active' LIMIT 1",
        [workspaceId, userId],
      ),
    );
    const membership = result.rows[0];
    if (!membership || membership.status === 'suspended') {
      throw new NotFoundException('Workspace not found.');
    }
    if (
      membership.status === 'restricted' &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    ) {
      throw new ForbiddenException('This workspace is currently restricted to read-only access.');
    }
    request.workspace = { id: workspaceId, role: membership.role, status: membership.status };
    return true;
  }
}
