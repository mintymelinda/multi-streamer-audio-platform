import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: { level: process.env.LOG_LEVEL ?? 'info' },
      requestIdHeader: 'x-request-id',
      genReqId: (request) => {
        const supplied = request.headers['x-request-id'];
        return typeof supplied === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(supplied)
          ? supplied
          : randomUUID();
      },
    }),
    { logger: new ConsoleLogger({ json: true }) },
  );

  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
