import 'reflect-metadata';
import { createInterface } from 'node:readline';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { ProviderExecutionHandoffModule } from '../../dist/providers/provider-execution-handoff.module.js';

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

async function main() {
  send({ type: 'booting', pid: process.pid });
  const app = await NestFactory.create(
    ProviderExecutionHandoffModule,
    new FastifyAdapter({ logger: false }),
    { logger: false, abortOnError: false },
  );
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('Provider execution API did not bind to a TCP port.');
  }
  send({
    type: 'ready',
    pid: process.pid,
    handoffUrl: 'http://127.0.0.1:' + address.port + '/internal/provider-executions/handoff',
  });

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
