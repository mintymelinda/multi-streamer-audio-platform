#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const composeFile = join(repositoryRoot, 'infra/compose/docker-compose.yml');
const environmentFile = join(repositoryRoot, 'infra/compose/.env.example');
const projectName = 'platform-smoke-' + randomUUID().replaceAll('-', '').slice(0, 10);
const composePrefix = [
  'compose',
  '--project-name',
  projectName,
  '--env-file',
  environmentFile,
  '-f',
  composeFile,
];

function command(binary, args, allowFailure = false) {
  const result = spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(binary + ' ' + args.join(' ') + ' failed: ' + result.stderr.trim());
  }
  return result.stdout.trim();
}

function inspectService(service) {
  const id = command('docker', [...composePrefix, 'ps', '--all', '-q', service], true);
  if (!id) return null;
  const details = command('docker', [
    'inspect',
    '--format',
    '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.ExitCode}}',
    id.split('\n')[0],
  ]);
  const [state, health, exitCode] = details.split('|');
  return { state, health, exitCode: Number(exitCode) };
}

async function waitForInfrastructure() {
  const deadline = Date.now() + 120_000;
  let last = {};
  while (Date.now() < deadline) {
    last = {
      postgres: inspectService('postgres'),
      redis: inspectService('redis'),
      objectStorage: inspectService('object-storage'),
      objectStorageInit: inspectService('object-storage-init'),
    };
    const ready =
      last.postgres?.state === 'running' &&
      last.postgres.health === 'healthy' &&
      last.redis?.state === 'running' &&
      last.redis.health === 'healthy' &&
      last.objectStorage?.state === 'running' &&
      last.objectStorageInit?.state === 'exited' &&
      last.objectStorageInit.exitCode === 0;
    if (ready) return last;
    if (
      (last.objectStorageInit?.state === 'exited' && last.objectStorageInit.exitCode !== 0) ||
      (last.postgres?.state === 'exited') ||
      (last.redis?.state === 'exited') ||
      (last.objectStorage?.state === 'exited')
    ) {
      throw new Error('A Compose infrastructure service exited before becoming ready: ' + JSON.stringify(last));
    }
    await delay(2000);
  }
  throw new Error('Timed out waiting for isolated Compose infrastructure health checks: ' + JSON.stringify(last));
}

async function main() {
  let failure;
  try {
    command('docker', [...composePrefix, 'up', '-d', 'postgres', 'redis', 'object-storage', 'object-storage-init']);
    const services = await waitForInfrastructure();
    const postgres = command('docker', [...composePrefix, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'platform_bootstrap', '-d', 'platform']);
    const redis = command('docker', [...composePrefix, 'exec', '-T', 'redis', 'redis-cli', 'ping']);
    if (!redis.includes('PONG')) throw new Error('Redis did not return PONG.');
    process.stdout.write(JSON.stringify({
      status: 'passed',
      scope: 'isolated Compose infrastructure only',
      projectName,
      services,
      probes: { postgres: postgres.split('\n').at(-1), redis },
      note: 'The current Compose file does not define an API service; this check does not claim full application deployment validation.',
    }, null, 2) + '\n');
  } catch (error) {
    failure = error;
  } finally {
    command('docker', [...composePrefix, 'down', '--volumes', '--remove-orphans'], true);
  }
  if (failure) throw failure;
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : 'Compose infrastructure smoke test failed.') + '\n');
  process.exitCode = 1;
});
