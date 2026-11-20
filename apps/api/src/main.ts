import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { RedisIoAdapter } from './realtime/redis-io.adapter.js';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: { level: process.env.LOG_LEVEL ?? 'info' },
      requestIdHeader: 'x-request-id',
      genReqId: (request: IncomingMessage | Http2ServerRequest) => {
        const supplied = request.headers['x-request-id'];
        return typeof supplied === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(supplied)
          ? supplied
          : randomUUID();
      },
    }),
    { logger: new ConsoleLogger({ json: true }), rawBody: true },
  );

  const redisUrl = process.env.REDIS_URL;
  if (process.env.NODE_ENV === 'production' && !redisUrl) {
    throw new Error('REDIS_URL is required in production for cross-instance Socket.IO delivery.');
  }
  if (redisUrl) {
    const redisAdapter = new RedisIoAdapter(app);
    await redisAdapter.connect(redisUrl);
    app.useWebSocketAdapter(redisAdapter);
  } else {
    app.useWebSocketAdapter(new IoAdapter(app));
  }

  const overlayOrigins = (process.env.OVERLAY_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (overlayOrigins.length > 0) {
    app.enableCors({
      origin: overlayOrigins,
      methods: ['GET', 'OPTIONS'],
      allowedHeaders: ['Authorization'],
      credentials: false,
      maxAge: 600,
    });
  }

  const openApiConfig = new DocumentBuilder()
    .setTitle('Multi-Streamer Audio Platform API')
    .setDescription('Workspace-scoped request, moderation, Twitch integration, and recovery API.')
    .setVersion('1.0.0')
    .build();
  const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('openapi', app, openApiDocument, { jsonDocumentUrl: 'openapi-json' });

  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
