import 'reflect-metadata';
import { createInterface } from 'node:readline';
import { DatabaseService } from '../../dist/database/database.service.js';
import { WorkspaceRealtimeGateway } from '../../dist/realtime/workspace-realtime.gateway.js';

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

async function main() {
  send({ type: 'booting', pid: process.pid });
  const database = new DatabaseService();
  await database.onModuleInit();
  const userId = process.env.PHASE8_REALTIME_USER_ID;
  const workspaceId = process.env.PHASE8_REALTIME_WORKSPACE_ID;
  const sessionToken = process.env.PHASE8_REALTIME_SESSION_TOKEN;
  const nodeId = process.env.PHASE8_REALTIME_NODE_ID;
  if (!userId || !workspaceId || !sessionToken || !nodeId) {
    throw new Error('Phase 8 realtime process identity is incomplete.');
  }

  const rooms = new Set();
  const socket = {
    data: { userId, sessionToken },
    async join(room) {
      rooms.add(room);
    },
    async leave(room) {
      rooms.delete(room);
    },
    emit(event, payload) {
      send({ type: 'event', nodeId, event, payload });
    },
  };
  const auth = {
    async resolveSession(token) {
      return token === sessionToken ? { id: userId } : null;
    },
  };
  const gateway = new WorkspaceRealtimeGateway(database, auth);
  gateway.server = {
    local: {
      in(room) {
        return {
          async fetchSockets() {
            return rooms.has(room) ? [socket] : [];
          },
        };
      },
  };
  await gateway.onModuleInit();
  const subscription = await gateway.subscribe(socket, { workspaceId });
  send({ type: 'ready', nodeId, cursor: subscription.cursor });

  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ type: 'protocol-error', message: 'invalid-json' });
      continue;
    }
    if (message?.type === 'close') break;
  }

  await gateway.onModuleDestroy();
  await database.onModuleDestroy();
  send({ type: 'stopped', nodeId });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown-error';
  process.stderr.write((error instanceof Error ? error.stack : message) + '\n');
  send({ type: 'boot-error', message });
  process.exitCode = 1;
});
