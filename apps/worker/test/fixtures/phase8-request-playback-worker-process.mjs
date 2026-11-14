import 'reflect-metadata';
import { createInterface } from 'node:readline';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

async function main() {
  send({ type: 'booting', pid: process.pid });
  const [{ OutboxDispatcherService }, { ProviderExecutionConsumerService }] = await Promise.all([
    import('../../dist/outbox-dispatcher.service.js'),
    import('../../dist/provider-execution-consumer.service.js'),
  ]);
  class RequestPlaybackWorkerModule {}
  Module({
    providers: [OutboxDispatcherService, ProviderExecutionConsumerService],
  })(RequestPlaybackWorkerModule);

  const app = await NestFactory.createApplicationContext(RequestPlaybackWorkerModule, {
    logger: false,
    abortOnError: false,
  });
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
  }

  await app.close();
  send({ type: 'stopped', pid: process.pid });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown-error';
  process.stderr.write((error instanceof Error ? error.stack : message) + '\n');
  send({ type: 'boot-error', message });
  process.exitCode = 1;
});
