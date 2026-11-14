#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stagingCompose = resolve(repositoryRoot, 'infra/compose/docker-compose.staging.yml');
const edgeCompose = resolve(repositoryRoot, 'infra/compose/docker-compose.edge.yml');
const REQUIRED = ['env-file', 'api-url', 'dashboard-url', 'overlay-url', 'assets-url'];

export function parseHttpsOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(label + ' must be an absolute URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(label + ' must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  return parsed.origin;
}

export function parseOptions(argv, cwd = process.cwd()) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--i-confirm-non-production') {
      options.confirmNonProduction = true;
      continue;
    }
    if (!argument?.startsWith('--')) throw new Error('Unexpected positional argument.');
    const key = argument.slice(2);
    if (!REQUIRED.includes(key)) throw new Error('Unknown option: --' + key);
    if (options[key]) throw new Error('Duplicate option: --' + key);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --' + key);
    options[key] = value;
    index += 1;
  }
  for (const key of REQUIRED) {
    if (!options[key]) throw new Error('Missing required option --' + key);
  }
  if (!options.confirmNonProduction) {
    throw new Error('Refusing to inspect an environment without --i-confirm-non-production.');
  }
  options.envFile = resolve(cwd, options['env-file']);
  options.api = parseHttpsOrigin(options['api-url'], 'API URL');
  options.dashboard = parseHttpsOrigin(options['dashboard-url'], 'Dashboard URL');
  options.overlay = parseHttpsOrigin(options['overlay-url'], 'Overlay URL');
  options.assets = parseHttpsOrigin(options['assets-url'], 'Assets URL');
  return options;
}

export function parseComposePsOutput(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    // Docker Compose also supports newline-delimited JSON objects.
  }
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error('Docker Compose returned an invalid service status document.');
    }
  });
}

export function evaluateComposeServices(entries, expected) {
  const checks = [];
  for (const requirement of expected) {
    const service = entries.find((entry) => entry.Service === requirement.service);
    if (!service) {
      checks.push({
        name: 'container:' + requirement.service,
        status: 'failed',
        severity: 'critical',
        message: 'Required Compose service is missing.',
      });
      continue;
    }
    const state = String(service.State ?? '').toLowerCase();
    const health = String(service.Health ?? '').toLowerCase();
    const running = state === 'running';
    const healthy = !requirement.healthcheck || health === 'healthy';
    const passed = running && healthy;
    let message = 'Container is running.';
    if (!running) message = 'Container state is ' + (state || 'unknown') + '.';
    else if (!healthy) message = 'Container health is ' + (health || 'missing') + '.';
    checks.push({
      name: 'container:' + requirement.service,
      status: passed ? 'passed' : 'failed',
      severity: passed ? 'info' : 'critical',
      message,
    });
  }
  return checks;
}

async function checkHttp(name, url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return {
      name,
      status: response.status === 200 ? 'passed' : 'failed',
      severity: response.status === 200 ? 'info' : 'critical',
      message: response.status === 200 ? 'HTTP endpoint returned 200.' : 'HTTP endpoint returned ' + response.status + '.',
    };
  } catch {
    return { name, status: 'failed', severity: 'critical', message: 'HTTP endpoint could not be reached within 10 seconds.' };
  }
}

async function checkSocketIoWebSocket(apiOrigin) {
  let socket;
  try {
    socket = new WebSocket(new URL('/socket.io/?EIO=4&transport=websocket', apiOrigin));
    await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error('timeout')), 10_000);
      const finish = (callback, value) => {
        clearTimeout(timeout);
        callback(value);
      };
      socket.addEventListener('message', (event) => {
        if (String(event.data).startsWith('0{')) finish(resolvePromise);
      });
      socket.addEventListener('error', () => finish(rejectPromise, new Error('connection')));
      socket.addEventListener('close', () => finish(rejectPromise, new Error('closed')));
    });
    return { name: 'socket.io-websocket', status: 'passed', severity: 'info', message: 'Engine.IO WebSocket handshake succeeded.' };
  } catch {
    return { name: 'socket.io-websocket', status: 'failed', severity: 'critical', message: 'Engine.IO WebSocket handshake failed.' };
  } finally {
    socket?.close();
  }
}

function inspectCompose(options, composeFile) {
  const args = ['compose', '--env-file', options.envFile, '-f', composeFile, 'ps', '-a', '--format', 'json'];
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Docker Compose status command failed.');
  }
  return parseComposePsOutput(result.stdout);
}

export async function runHealthCheck(options, dependencies = {}) {
  const inspect = dependencies.inspectCompose ?? ((file) => inspectCompose(options, file));
  const checks = [];
  try {
    const appServices = inspect(stagingCompose);
    checks.push(...evaluateComposeServices(appServices, [
      { service: 'postgres', healthcheck: true },
      { service: 'redis', healthcheck: true },
      { service: 'object-storage' },
      { service: 'api', healthcheck: true },
      { service: 'worker' },
      { service: 'dashboard', healthcheck: true },
      { service: 'overlay', healthcheck: true },
    ]));
  } catch {
    checks.push({ name: 'compose:application', status: 'failed', severity: 'critical', message: 'Application Compose status could not be inspected.' });
  }
  try {
    checks.push(...evaluateComposeServices(inspect(edgeCompose), [{ service: 'edge' }]));
  } catch {
    checks.push({ name: 'compose:edge', status: 'failed', severity: 'critical', message: 'Edge Compose status could not be inspected.' });
  }

  const request = dependencies.checkHttp ?? checkHttp;
  checks.push(await request('api-live', new URL('/health/live', options.api)));
  checks.push(await request('api-ready', new URL('/health/ready', options.api)));
  checks.push(await request('dashboard-http', new URL('/', options.dashboard)));
  checks.push(await request('overlay-http', new URL('/', options.overlay)));
  checks.push(await request('object-storage-ready', new URL('/minio/health/ready', options.assets)));
  checks.push(await (dependencies.checkSocketIo ?? checkSocketIoWebSocket)(options.api));

  const failures = checks.filter((check) => check.status !== 'passed');
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    scope: 'non-production staging health probe',
    generatedAt: new Date().toISOString(),
    summary: { checks: checks.length, passed: checks.length - failures.length, failed: failures.length },
    checks,
    alerts: failures.map((check) => ({
      severity: check.severity,
      check: check.name,
      message: check.message,
      action: 'Inspect the named service and its sanitized logs; do not delete volumes or flush Redis as a first response.',
    })),
  };
}

async function main(argv) {
  const options = parseOptions(argv);
  const report = await runHealthCheck(options);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'Staging health probe failed.') + '\n');
    process.exitCode = 1;
  });
}
