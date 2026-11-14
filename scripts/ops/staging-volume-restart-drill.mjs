#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composeFile = resolve(repositoryRoot, 'infra/compose/docker-compose.staging.yml');

export function parseHttpsOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(label + ' must be an absolute URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(label + ' must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

export function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--i-confirm-non-production') {
      options.confirmNonProduction = true;
      continue;
    }
    if (!['--env-file', '--api-url', '--assets-url'].includes(argument)) {
      throw new Error('Unknown option: ' + argument);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + argument);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.confirmNonProduction) {
    throw new Error('Refusing to recreate stateful containers without --i-confirm-non-production.');
  }
  if (!options['env-file']) throw new Error('Missing required --env-file.');
  options.envFile = resolve(repositoryRoot, options['env-file']);
  if (!existsSync(options.envFile)) throw new Error('Compose environment file does not exist.');
  options.api = parseHttpsOrigin(options['api-url'], 'API URL');
  options.assets = parseHttpsOrigin(options['assets-url'], 'Assets URL');
  return options;
}

export function findNamedVolumeMount(mounts, destination) {
  const mount = mounts.find((entry) => entry.Destination === destination);
  if (!mount || mount.Type !== 'volume' || typeof mount.Name !== 'string' || !mount.Name) {
    throw new Error('Expected a named Docker volume mounted at ' + destination + '.');
  }
  return mount.Name;
}

function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error('docker ' + args.join(' ') + ' failed: ' + (result.stderr || result.stdout).trim());
  }
  return result.stdout.trim();
}

function composePrefix(options) {
  return ['compose', '--env-file', options.envFile, '-f', composeFile];
}

function serviceContainer(options, service) {
  const id = docker([...composePrefix(options), 'ps', '-q', service]);
  if (!id) throw new Error('Compose service ' + service + ' is not running.');
  return id.split('\n')[0];
}

function volumeFor(options, service, destination) {
  const id = serviceContainer(options, service);
  const mounts = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', id]));
  return findNamedVolumeMount(mounts, destination);
}

async function waitForServices(options) {
  const deadline = Date.now() + 120_000;
  let last = {};
  while (Date.now() < deadline) {
    const postgresId = serviceContainer(options, 'postgres');
    const redisId = serviceContainer(options, 'redis');
    const postgres = docker(['inspect', '--format', '{{.State.Health.Status}}', postgresId], true);
    const redis = docker([...composePrefix(options), 'exec', '-T', 'redis', 'redis-cli', 'ping'], true);
    let assetsStatus = 0;
    let apiStatus = 0;
    try {
      assetsStatus = (await fetch(new URL('/minio/health/ready', options.assets), {
        signal: AbortSignal.timeout(5_000),
      })).status;
    } catch {
      assetsStatus = 0;
    }
    try {
      apiStatus = (await fetch(new URL('/health/ready', options.api), {
        signal: AbortSignal.timeout(5_000),
      })).status;
    } catch {
      apiStatus = 0;
    }
    last = { postgres: postgres.trim(), redis: redis.trim(), assets: assetsStatus, api: apiStatus };
    if (last.postgres === 'healthy' && last.redis === 'PONG' && last.assets === 200 && last.api === 200) return last;
    await delay(2_000);
  }
  throw new Error('Staging services did not recover after container recreation: ' + JSON.stringify(last));
}

async function main(argv) {
  const options = parseOptions(argv);
  const prefix = composePrefix(options);
  const token = randomUUID();
  const redisKey = 'staging:volume-drill:' + token;
  const objectKey = 'staging-volume-drill/' + token + '.txt';
  const before = {
    postgres: volumeFor(options, 'postgres', '/var/lib/postgresql'),
    redis: volumeFor(options, 'redis', '/data'),
    objectStorage: volumeFor(options, 'object-storage', '/data'),
  };

  const probeSql = [
    'CREATE TABLE IF NOT EXISTS public.staging_volume_probe (probe_id text PRIMARY KEY)',
    "INSERT INTO public.staging_volume_probe (probe_id) VALUES ('" + token + "') ON CONFLICT DO NOTHING",
  ].join('; ');
  docker([...prefix, 'exec', '-T', 'postgres', 'psql', '-U', 'platform_bootstrap', '-d', 'platform', '-v', 'ON_ERROR_STOP=1', '-c', probeSql]);
  docker([...prefix, 'exec', '-T', 'redis', 'redis-cli', 'SET', redisKey, token, 'EX', '900']);

  const minioCommand = 'mc alias set local http://object-storage:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" && printf %s ' + token + ' | mc pipe local/platform-assets/' + objectKey;
  docker([...prefix, 'run', '--rm', '--no-deps', 'object-storage-init', minioCommand]);

  docker([...prefix, 'up', '-d', '--force-recreate', 'postgres', 'redis', 'object-storage']);
  const readiness = await waitForServices(options);

  const after = {
    postgres: volumeFor(options, 'postgres', '/var/lib/postgresql'),
    redis: volumeFor(options, 'redis', '/data'),
    objectStorage: volumeFor(options, 'object-storage', '/data'),
  };
  for (const service of Object.keys(before)) {
    if (before[service] !== after[service]) {
      throw new Error(service + ' was recreated with a different persistent volume.');
    }
  }

  const postgresValue = docker([...prefix, 'exec', '-T', 'postgres', 'psql', '-U', 'platform_bootstrap', '-d', 'platform', '-Atqc', "SELECT probe_id FROM public.staging_volume_probe WHERE probe_id='" + token + "'"]);
  if (postgresValue !== token) throw new Error('PostgreSQL probe data did not survive container recreation.');
  const redisValue = docker([...prefix, 'exec', '-T', 'redis', 'redis-cli', 'GET', redisKey]);
  if (redisValue !== token) throw new Error('Redis AOF probe data did not survive container recreation.');
  const minioCommandAfter = 'mc alias set local http://object-storage:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" && mc cat local/platform-assets/' + objectKey;
  const objectValue = docker([...prefix, 'run', '--rm', '--no-deps', 'object-storage-init', minioCommandAfter]);
  if (objectValue !== token) throw new Error('Object-storage probe data did not survive container recreation.');

  docker([...prefix, 'exec', '-T', 'postgres', 'psql', '-U', 'platform_bootstrap', '-d', 'platform', '-c', "DELETE FROM public.staging_volume_probe WHERE probe_id='" + token + "'; DROP TABLE IF EXISTS public.staging_volume_probe;"]);
  docker([...prefix, 'exec', '-T', 'redis', 'redis-cli', 'DEL', redisKey]);
  const minioCleanup = 'mc alias set local http://object-storage:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" && mc rm local/platform-assets/' + objectKey;
  docker([...prefix, 'run', '--rm', '--no-deps', 'object-storage-init', minioCleanup]);

  process.stdout.write(JSON.stringify({
    status: 'passed',
    scope: 'non-production persistent-volume recreation drill',
    volumes: after,
    readiness,
    verified: ['postgresql-data', 'redis-aof-data', 'object-storage-data'],
    note: 'Containers were recreated without removing named volumes. No docker compose down --volumes command is used.',
  }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'Staging volume drill failed.') + '\n');
    process.exitCode = 1;
  });
}
