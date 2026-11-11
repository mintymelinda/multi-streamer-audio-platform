import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { DatabaseService } from '../database/database.service.js';
import { OverlayRuntimeService } from './overlay-runtime.service.js';

interface OverlaySocket extends Socket {
  data: { sceneId?: string; token?: string; workspaceId?: string };
}

@WebSocketGateway({
  namespace: '/overlay',
  cors: {
    origin: (process.env.OVERLAY_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  },
})
@Injectable()
export class OverlayRealtimeGateway
  implements OnGatewayConnection<OverlaySocket>, OnGatewayDisconnect<OverlaySocket>, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OverlayRealtimeGateway.name);
  @WebSocketServer()
  private server!: Server;
  private stopOutbox: (() => Promise<void>) | undefined;
  private stopAccessChanges: (() => Promise<void>) | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OverlayRuntimeService) private readonly runtime: OverlayRuntimeService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.stopOutbox = await this.database.listen('platform_outbox_event', (payload) => {
      void this.broadcastInvalidation(payload).catch((error: unknown) => {
        this.logger.error('Unable to invalidate overlay snapshots', error instanceof Error ? error.stack : undefined);
      });
    });
    this.stopAccessChanges = await this.database.listen('overlay_scene_access_changed', (sceneId) => {
      if (sceneId && /^[0-9a-f-]{36}$/i.test(sceneId)) {
        this.server.in(`scene:${sceneId}`).disconnectSockets(true);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopOutbox?.();
    await this.stopAccessChanges?.();
  }

  async handleConnection(client: OverlaySocket): Promise<void> {
    const auth = client.handshake.auth as { sceneId?: unknown; token?: unknown } | undefined;
    if (typeof auth?.sceneId !== 'string' || typeof auth.token !== 'string') {
      client.disconnect(true);
      return;
    }
    const identity = await this.runtime.authenticate(auth.sceneId, auth.token).catch(() => null);
    if (!identity) {
      client.disconnect(true);
      return;
    }
    client.data.sceneId = identity.sceneId;
    client.data.workspaceId = identity.workspaceId;
    client.data.token = auth.token;
    await client.join(`scene:${identity.sceneId}`);
  }

  handleDisconnect(_client: OverlaySocket): void {}

  private async broadcastInvalidation(raw: string | undefined): Promise<void> {
    if (!raw || raw.length > 8_192) return;
    let event: { workspaceId?: unknown; type?: unknown };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return;
    }
    if (typeof event.workspaceId !== 'string') return;
    const sceneIds = await this.runtime.activeSceneIds(event.workspaceId);
    for (const sceneId of sceneIds) {
      const sockets = await this.server.in(`scene:${sceneId}`).fetchSockets();
      for (const socket of sockets) {
        const data = socket.data as OverlaySocket['data'];
        if (!data.token || !data.sceneId) {
          await socket.disconnect(true);
          continue;
        }
        const current = await this.runtime.authenticate(data.sceneId, data.token).catch(() => null);
        if (!current || current.workspaceId !== event.workspaceId) {
          await socket.disconnect(true);
          continue;
        }
        socket.emit('overlay:invalidate', { sceneId, eventType: typeof event.type === 'string' ? event.type : null });
      }
    }
  }
}
