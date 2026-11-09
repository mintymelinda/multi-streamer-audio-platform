import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { VerifiedWorkspaceId } from '@platform/contracts';
import type {
  AuthenticatedUser,
  HttpRequest,
  WorkspaceRequestContext,
} from '../identity/http.types.js';
import { SessionGuard } from '../identity/session.guard.js';
import { DatabaseService } from '../database/database.service.js';
import {
  RequireWorkspacePermission,
  WorkspacePermissionGuard,
} from '../workspaces/workspace-permission.guard.js';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard.js';
import { RequestsService } from '../requests/requests.service.js';
import { buildWorkspaceSnapshotCursor } from './workspace-realtime.js';

function actor(request: HttpRequest): AuthenticatedUser {
  if (!request.user) throw new NotFoundException('Sign-in is required.');
  return request.user;
}

function workspace(request: HttpRequest): WorkspaceRequestContext {
  if (!request.workspace) throw new NotFoundException('Workspace access is required.');
  return request.workspace;
}

@Controller('workspaces/:workspaceId/realtime')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
export class RealtimeSnapshotController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RequestsService) private readonly requests: RequestsService,
  ) {}

  @Get('snapshot')
  @RequireWorkspacePermission('workspace:read')
  async snapshot(@Req() request: HttpRequest) {
    const currentWorkspace = workspace(request);
    const currentActor = actor(request);
    const [requests, queue, latest] = await Promise.all([
      this.requests.list(currentWorkspace, currentActor.id),
      this.requests.queue(currentWorkspace, currentActor.id),
      this.database.transaction(
        { userId: currentActor.id, verifiedWorkspaceId: currentWorkspace.id },
        (client) =>
          client.query<{ id: string; occurred_at: Date }>(
            `SELECT id, occurred_at FROM outbox_events
              WHERE workspace_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
            [currentWorkspace.id],
          ),
      ),
    ]);
    const row = latest.rows[0];
    const cursor = buildWorkspaceSnapshotCursor({
      workspaceId: currentWorkspace.id,
      eventId: row?.id ?? '0',
      sequence: row ? new Date(row.occurred_at).getTime() : 0,
    });
    return {
      workspaceId: currentWorkspace.id as VerifiedWorkspaceId,
      requests,
      queue,
      cursor,
    };
  }
}
