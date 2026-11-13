import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplication } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private pubClient: Redis | undefined;
  private subClient: Redis | undefined;

  constructor(app: INestApplication) {
    super(app);
  }

  async connect(redisUrl: string): Promise<void> {
    if (!redisUrl.startsWith('redis://') && !redisUrl.startsWith('rediss://')) {
      throw new Error('REDIS_URL must use the redis:// or rediss:// protocol.');
    }
    if (this.pubClient || this.subClient) {
      throw new Error('The Redis Socket.IO adapter has already been initialized.');
    }

    const options = {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectTimeout: 10_000,
      retryStrategy: (attempt: number) => Math.min(attempt * 250, 5_000),
    };
    const pubClient = new Redis(redisUrl, options);
    const subClient = new Redis(redisUrl, options);
    pubClient.on('error', (error: Error) =>
      this.logger.error('Socket.IO Redis publisher error', error.stack),
    );
    subClient.on('error', (error: Error) =>
      this.logger.error('Socket.IO Redis subscriber error', error.stack),
    );

    try {
      await Promise.all([pubClient.connect(), subClient.connect()]);
      await Promise.all([pubClient.ping(), subClient.ping()]);
      this.pubClient = pubClient;
      this.subClient = subClient;
    } catch (error) {
      await Promise.allSettled([pubClient.quit(), subClient.quit()]);
      throw new Error('Unable to establish the Socket.IO Redis adapter connections.', {
        cause: error,
      });
    }
  }

  override createIOServer(
    port: number,
    options?: Parameters<IoAdapter['createIOServer']>[1],
  ): ReturnType<IoAdapter['createIOServer']> {
    const server = super.createIOServer(port, options);
    if (!this.pubClient || !this.subClient) {
      throw new Error('The Socket.IO Redis adapter must connect before the server is created.');
    }
    server.adapter(
      createAdapter(this.pubClient as never, this.subClient as never, {
        key: 'multi-streamer:socket.io',
        requestsTimeout: 5_000,
        publishOnSpecificResponseChannel: true,
      }),
    );
    return server;
  }

  override close(server: Parameters<IoAdapter['close']>[0]): void {
    super.close(server);
    for (const client of [this.pubClient, this.subClient]) {
      if (client) {
        void client.quit().catch(() => client.disconnect());
      }
    }
    this.pubClient = undefined;
    this.subClient = undefined;
  }
}
