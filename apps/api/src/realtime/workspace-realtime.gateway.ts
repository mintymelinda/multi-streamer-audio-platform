import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { DatabaseService } from '../database/database.service.js';
import type { VerifiedWorkspaceId } from '@platform/contracts';
import { AuthService } from '../identity/auth.service.js';
import { parseCookies, sessionCookieName } from '../identity/security.js';
import {
  authorizeWorkspaceSubscription,
  buildWorkspaceSnapshotCursor,
  isSafeWorkspaceEvent,
} from './workspace-realtime.js';

interface WorkspaceSocket extends Socket {
  data: {
    userId?: string;
    sessionToken?: string;
  };
}

@WebSocketGateway({ namespace: '/workspace' })
@Injectable()
export class WorkspaceRealtimeGateway
  implements
    OnGatewayConnection<WorkspaceSocket>,
    OnGatewayDisconnect<WorkspaceSocket>,
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(WorkspaceRealtimeGateway.name);
  @WebSocketServer()
  private server!: Server;
  private stopListening: (() => Promise<void>) | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.stopListening = await this.database.listen('platform_outbox_event', (payload) => {
      void this.broadcastOutboxEvent(payload).catch((error: unknown) => {
        this.logger.error(
          'Unable to broadcast workspace outbox event',
          error instanceof Error ? error.stack : undefined,
        );
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopListening?.();
  }

  async handleConnection(client: WorkspaceSocket): Promise<void> {
    const token = parseCookies(client.handshake.headers.cookie).get(sessionCookieName());
    if (!token) {
      client.disconnect(true);
      return;
    }
    const identity = await this.auth.resolveSession(token).catch(() => null);
    if (!identity) {
      client.disconnect(true);
      return;
    }
    client.data.userId = identity.id;
    client.data.sessionToken = token;
  }

  handleDisconnect(_client: WorkspaceSocket): void {}

  @SubscribeMessage('workspace:subscribe')
  async subscribe(@ConnectedSocket() client: WorkspaceSocket, @MessageBody() body: unknown) {
    const workspaceId =
      typeof body === 'object' && body !== null && 'workspaceId' in body
        ? (body as { workspaceId?: unknown }).workspaceId
        : undefined;
    if (
      typeof workspaceId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        workspaceId,
      )
    ) {
      throw new ForbiddenException('A valid workspace ID is required.');
    }
    const token = client.data.sessionToken;
    const identity = token ? await this.auth.resolveSession(token) : null;
    if (!identity || identity.id !== client.data.userId) {
      throw new UnauthorizedException('The websocket session is no longer valid.');
    }
    const authorization = await authorizeWorkspaceSubscription({
      session: { userId: identity.id, authenticated: true },
      requestedWorkspaceId: workspaceId,
      authorizeMembership: async ({ userId, workspaceId: requestedId }) => {
        const result = await this.database.transaction({ userId }, (db) =>
          db.query<{
            user_id: string;
            workspace_id: string;
            role: 'owner' | 'admin' | 'moderator' | 'viewer';
            active: boolean;
          }>(
            `SELECT m.user_id, m.workspace_id, m.role,
                    (m.status = 'active' AND w.status = 'active') AS active
               FROM workspace_memberships m
               JOIN workspaces w ON w.id = m.workspace_id
              WHERE m.user_id = $1 AND m.workspace_id = $2 LIMIT 1`,
            [userId, requestedId],
          ),
        );
        const membership = result.rows[0];
        return membership
          ? {
              userId: membership.user_id,
              workspaceId: membership.workspace_id,
              role: membership.role,
              active: membership.active,
            }
          : null;
      },
    });
    const room = `workspace:${authorization.workspaceId}`;
    await client.join(room);

    const latest = await this.database.transaction(
      {
        userId: identity.id,
        verifiedWorkspaceId: authorization.workspaceId as VerifiedWorkspaceId,
      },
      (db) =>
        db.query<{ id: string; occurred_at: Date }>(
          `SELECT id, occurred_at FROM outbox_events
            WHERE workspace_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
          [authorization.workspaceId],
        ),
    );
    const row = latest.rows[0];
    const cursor = buildWorkspaceSnapshotCursor({
      workspaceId: authorization.workspaceId,
      eventId: row?.id ?? '0',
      sequence: row ? new Date(row.occurred_at).getTime() : 0,
    });
    return { ok: true, workspaceId: authorization.workspaceId, role: authorization.role, cursor };
  }

  private async broadcastOutboxEvent(raw: string | undefined): Promise<void> {
    if (!raw || raw.length > 8_192) return;
    let event: {
      id?: unknown;
      workspaceId?: unknown;
      type?: unknown;
      payload?: unknown;
      refreshRequired?: unknown;
    };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return;
    }
    if (
      typeof event.workspaceId !== 'string' ||
      typeof event.id !== 'string' ||
      typeof event.type !== 'string' ||
      !isSafeWorkspaceEvent(
        {
          id: event.id,
          workspaceId: event.workspaceId,
          type: event.type,
          payload: event.payload,
        },
        event.workspaceId,
      )
    ) {
      return;
    }
    const room = `workspace:${event.workspaceId}`;
    const sockets = await this.server.in(room).fetchSockets();
    for (const socket of sockets) {
      const data = socket.data as { userId?: string; sessionToken?: string };
      if (!data.userId || !data.sessionToken) {
        await socket.leave(room);
        continue;
      }
      const identity = await this.auth.resolveSession(data.sessionToken).catch(() => null);
      if (!identity || identity.id !== data.userId) {
        await socket.leave(room);
        continue;
      }
      const membership = await this.database.transaction({ userId: identity.id }, (db) =>
        db.query(
          `SELECT 1 FROM workspace_memberships m
             JOIN workspaces w ON w.id = m.workspace_id
            WHERE m.workspace_id = $1 AND m.user_id = $2
              AND m.status = 'active' AND w.status = 'active' LIMIT 1`,
          [event.workspaceId, identity.id],
        ),
      );
      if (membership.rows.length === 0) {
        await socket.leave(room);
        continue;
      }
      socket.emit('workspace:event', {
        id: event.id,
        type: event.type,
        payload: event.payload,
        refreshRequired: event.refreshRequired === true,
      });
    }
  }
}
