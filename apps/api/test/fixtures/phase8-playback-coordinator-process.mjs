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
  await import('reflect-metadata');
  send({ type: 'booting', stage: 'nestjs-core', pid: process.pid });
  const { NestFactory } = await import('@nestjs/core');
  send({ type: 'booting', stage: 'api-modules', pid: process.pid });
  const { PlaybackCoordinatorModule } = await import('../../dist/playback/playback-coordinator.module.js');
  const { PlaybackCoordinatorService } = await import('../../dist/playback/playback-coordinator.service.js');
  send({ type: 'booting', stage: 'nest-context', pid: process.pid });

  const app = await NestFactory.createApplicationContext(PlaybackCoordinatorModule, {
    logger: false,
    abortOnError: false,
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
  const message = error instanceof Error ? error.message : 'unknown-error';
  const stack = error instanceof Error ? error.stack : undefined;
  process.stderr.write((stack ?? message) + '\n');
  send({ type: 'boot-error', message, stack });
  process.exitCode = 1;
});
