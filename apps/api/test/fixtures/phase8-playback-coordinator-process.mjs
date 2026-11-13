import 'reflect-metadata';
import { createInterface } from 'node:readline';
import { NestFactory } from '@nestjs/core';
import { PlaybackCoordinatorModule } from '../../dist/playback/playback-coordinator.module.js';
import { PlaybackCoordinatorService } from '../../dist/playback/playback-coordinator.service.js';

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

async function main() {
  const app = await NestFactory.createApplicationContext(PlaybackCoordinatorModule, {
    logger: false,
  });
  const coordinator = app.get(PlaybackCoordinatorService);
  send({ type: 'ready', pid: process.pid });

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
  send({
    type: 'boot-error',
    message: error instanceof Error ? error.message : 'unknown-error',
  });
  process.exitCode = 1;
});
