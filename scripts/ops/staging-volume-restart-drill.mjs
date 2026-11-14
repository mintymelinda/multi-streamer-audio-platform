#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composeFile = resolve(repositoryRoot, 'infra/compose/docker-compose.staging.yml');
const edgeComposeFile = resolve(repositoryRoot, 'infra/compose/docker-compose.edge.yml');

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

export function buildProbeCleanupSql(probeId, dropTable) {
  if (!/^[a-z0-9-]{1,64}$/i.test(probeId)) {
    throw new Error('Probe identifier is invalid.');
  }
  const deleteProbe = "DELETE FROM public.staging_volume_probe WHERE probe_id='" + probeId + "'";
  return dropTable ? deleteProbe + "; DROP TABLE IF EXISTS public.staging_volume_probe" : deleteProbe;
}

function docker(args, allowFailure = false, extraEnv = {}) {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error('docker ' + args.join(' ') + ' failed: ' + (result.stderr || result.stdout).trim());
  }
  return result.stdout.trim();
}

function composePrefix(options, file = composeFile) {
  return ['compose', '--env-file', options.envFile, '-f', file];
}

function serviceContainer(options, service, prefix = composePrefix(options)) {
  const id = docker([...prefix, 'ps', '-aq', service]);
  if (!id) throw new Error('Compose service ' + service + ' is not running.');
  return id.split('\n')[0];
}

function volumeFor(options, service, destination, prefix = composePrefix(options)) {
  const id = serviceContainer(options, service, prefix);
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

function readEnvironmentFile(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(String.fromCharCode(10))) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function runMinioClient(options, command) {
  const environment = readEnvironmentFile(options.envFile);
  const network = environment.PLATFORM_NETWORK_NAME || 'platform-staging';
  if (!environment.MINIO_ROOT_USER || !environment.MINIO_ROOT_PASSWORD) {
    throw new Error('The staging environment file must define MinIO credentials.');
  }
  return docker([
    'run', '--rm', '--network', network, '--entrypoint', '/bin/sh',
    '--env', 'MINIO_ROOT_USER', '--env', 'MINIO_ROOT_PASSWORD',
    'minio/mc:RELEASE.2025-08-13T08-35-41Z', '-lc', command,
  ], false, {
    MINIO_ROOT_USER: environment.MINIO_ROOT_USER,
    MINIO_ROOT_PASSWORD: environment.MINIO_ROOT_PASSWORD,
  });
}

async function main(argv) {
  const options = parseOptions(argv);
  const prefix = composePrefix(options);
  const edgePrefix = composePrefix(options, edgeComposeFile);
  const token = randomUUID();
  const redisKey = 'staging:volume-drill:' + token;
  const objectKey = 'staging-volume-drill/' + token + '.txt';
  const initialReadiness = await waitForServices(options);
  const before = {
    postgres: volumeFor(options, 'postgres', '/var/lib/postgresql'),
    redis: volumeFor(options, 'redis', '/data'),
    objectStorage: volumeFor(options, 'object-storage', '/data'),
    caddyData: volumeFor(options, 'edge', '/data', edgePrefix),
    caddyConfig: volumeFor(options, 'edge', '/config', edgePrefix),
  };

  const probeTableExists = docker([...prefix, 'exec', '-T', 'postgres', 'psql', '-U', 'platform_bootstrap', '-d', 'platform', '-Atqc', "SELECT to_regclass('public.staging_volume_probe') IS NOT NULL"]);
  const createdProbeTable = probeTableExists !== 't';
  if (createdProbeTable) {
    docker([...prefix, 'exec', '-T', 'postgres', 'psql', '-U', 'platform_bootstrap', '-d', 'platform', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE TABLE public.staging_volume_probe (probe_id text PRIMARY KEY)']);
  }
  docker([...prefix, 'exec', '-T', 'postgres', 'psql', '-U', 'platform_bootstrap', '-d', 'platform', '-v', 'ON_ERROR_STOP=1', '-c', "INSERT INTO public.staging_volume_probe (probe_id) VALUES ('" + token + "') ON CONFLICT DO NOTHING"]);
  docker([...prefix, 'exec', '-T', 'redis', 'redis-cli', 'SET', redisKey, token, 'EX', '900']);

  const minioCommand = 'mc alias set local http://object-storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && printf %s ' + token + ' | mc pipe local/platform-assets/' + objectKey;
  runMinioClient(options, minioCommand);

  docker([...prefix, 'up', '-d', '--force-recreate', 'postgres', 'redis', 'object-storage']);
  docker([...edgePrefix, 'up', '-d', '--force-recreate', 'edge']);
  const readiness = await waitForServices(options);

  const after = {
    postgres: volumeFor(options, 'postgres', '/var/lib/postgresql'),
    redis: volumeFor(options, 'redis', '/data'),
    objectStorage: volumeFor(options, 'object-storage', '/data'),
    caddyData: volumeFor(options, 'edge', '/data', edgePrefix),
    caddyConfig: volumeFor(options, 'edge', '/config', edgePrefix),
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
  const minioCommandAfter = 'mc alias set local http://object-storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc cat local/platform-assets/' + objectKey;
  const objectValue = runMinioClient(options, minioCommandAfter);
  if (objectValue !== token) throw new Error('Object-storage probe data did not survive container recreation.');

  const cleanupSql = buildProbeCleanupSql(token, createdProbeTable);
  docker([...prefix, 'exec', '-T', 'postgres', 'psql', '-U', 'platform_bootstrap', '-d', 'platform', '-c', cleanupSql]);
  docker([...prefix, 'exec', '-T', 'redis', 'redis-cli', 'DEL', redisKey]);
  const minioCleanup = 'mc alias set local http://object-storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc rm local/platform-assets/' + objectKey;
  runMinioClient(options, minioCleanup);

  process.stdout.write(JSON.stringify({
    status: 'passed',
    scope: 'non-production persistent-volume recreation drill',
    volumes: after,
    initialReadiness,
    readiness,
    verified: ['postgresql-data', 'redis-aof-data', 'object-storage-data', 'caddy-certificate-and-config-volumes'],
    note: 'Containers were recreated without removing named volumes. No docker compose down --volumes command is used.',
  }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'Staging volume drill failed.') + '\n');
    process.exitCode = 1;
  });
}
