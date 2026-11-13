import 'reflect-metadata';
import { createInterface } from 'node:readline';

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

process.on('uncaughtException', (error) => {
  const message = error instanceof Error ? error.message : 'unknown-error';
  process.stderr.write((error instanceof Error ? error.stack : message) + '\n');
  send({ type: 'uncaught-exception', message });
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : 'unknown-error';
  process.stderr.write((reason instanceof Error ? reason.stack : message) + '\n');
  send({ type: 'unhandled-rejection', message });
  process.exitCode = 1;
});

process.on('exit', (code) => {
  send({ type: 'process-exit', code });
});

async function main() {
  send({ type: 'booting', stage: 'reflect-metadata', pid: process.pid });
  send({ type: 'booting', stage: 'nestjs-core', pid: process.pid });
  const { NestFactory } = await import('@nestjs/core');
  const { Module } = await import('@nestjs/common');
  const { FastifyAdapter } = await import('@nestjs/platform-fastify');
  send({ type: 'booting', stage: 'api-modules', pid: process.pid });
  const { PlaybackCoordinatorModule } = await import('../../dist/playback/playback-coordinator.module.js');
  const { PlaybackCoordinatorService } = await import('../../dist/playback/playback-coordinator.service.js');
  const { DatabaseModule } = await import('../../dist/database/database.module.js');
  const { DatabaseService } = await import('../../dist/database/database.service.js');
  const { WorkspaceRealtimeGateway } = await import('../../dist/realtime/workspace-realtime.gateway.js');
  const { RedisIoAdapter } = await import('../../dist/realtime/redis-io.adapter.js');

  const userId = process.env.PHASE8_REALTIME_USER_ID;
  const workspaceId = process.env.PHASE8_REALTIME_WORKSPACE_ID;
  const sessionToken = process.env.PHASE8_REALTIME_SESSION_TOKEN;
  if (!userId || !workspaceId || !sessionToken || !process.env.REDIS_URL) {
    throw new Error('Phase 8 API process identity or Redis configuration is incomplete.');
  }

  class Phase8RealtimeModule {}
  Module({
    imports: [PlaybackCoordinatorModule, DatabaseModule],
    providers: [
      {
        provide: WorkspaceRealtimeGateway,
        inject: [DatabaseService],
        useFactory(database) {
          const auth = {
            async resolveSession(token) {
              return token === sessionToken ? { id: userId } : null;
            },
          };
          const gateway = new WorkspaceRealtimeGateway(database, auth);
          gateway.handleConnection = async (socket) => {
            socket.data.userId = userId;
            socket.data.sessionToken = sessionToken;
            socket.on('phase8:subscribe', async (body) => {
              try {
                const result = await gateway.subscribe(socket, body);
                socket.emit('phase8:ready', result);
              } catch (error) {
                socket.emit('phase8:error', {
                  message: error instanceof Error ? error.message : 'subscription-failed',
                });
              }
            });
          };
          return gateway;
        },
      },
    ],
  })(Phase8RealtimeModule);

  send({ type: 'booting', stage: 'nest-context', pid: process.pid });
  const app = await NestFactory.create(Phase8RealtimeModule, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  const coordinator = app.get(PlaybackCoordinatorService);
  const adapter = new RedisIoAdapter(app);
  await adapter.connect(process.env.REDIS_URL);
  app.useWebSocketAdapter(adapter);
  await app.listen(0, '127.0.0.1');

  const gateway = app.get(WorkspaceRealtimeGateway);
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('Socket.IO server did not bind to a TCP port.');
  }
  send({ type: 'ready', pid: process.pid, port: address.port });

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
    if (message?.type === 'broadcast' && typeof message.eventId === 'string') {
      gateway.server.to(`workspace:${workspaceId}`).emit('phase8:redis-probe', {
        id: message.eventId,
      });
      send({ type: 'broadcasted', eventId: message.eventId });
      continue;
    }
    if (message?.type !== 'execute' || typeof message.commandId !== 'string') {
      send({ type: 'protocol-error', message: 'invalid-command' });
      continue;
    }

    try {
      const result = await coordinator.execute(message.input);
      send({
        type: 'result',
        commandId: message.commandId,
        result: {
          id: result.id,
          status: result.status,
          result: result.result,
          errorCode: result.errorCode,
          providerPlaybackId: result.providerPlaybackId,
          fencingToken: result.fencingToken,
        },
      });
    } catch (error) {
      send({
        type: 'command-error',
        commandId: message.commandId,
        message: error instanceof Error ? error.message : 'unknown-error',
        code: error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined,
      });
    }
  }

  await app.close();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown-error';
  const stack = error instanceof Error ? error.stack : undefined;
  process.stderr.write((stack ?? message) + '\n');
  send({ type: 'boot-error', message, stack });
  process.exitCode = 1;
});
