import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createInterface } from 'node:readline';

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

async function main() {
  send({ type: 'booting', pid: process.pid });
  const { ProviderExecutionConsumerService } = await import(
    '../../dist/provider-execution-consumer.service.js'
  );
  class ProviderExecutionTestModule {}
  Module({ providers: [ProviderExecutionConsumerService] })(ProviderExecutionTestModule);

  const app = await NestFactory.createApplicationContext(ProviderExecutionTestModule, {
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
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown-error';
  process.stderr.write((error instanceof Error ? error.stack : message) + '\n');
  send({ type: 'boot-error', message });
  process.exitCode = 1;
});
