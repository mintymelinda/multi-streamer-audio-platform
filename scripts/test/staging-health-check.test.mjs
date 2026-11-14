import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateComposeServices,
  parseComposePsOutput,
  parseHttpsOrigin,
  parseOptions,
  runHealthCheck,
} from '../ops/staging-health-check.mjs';

const args = [
  '--env-file', 'infra/compose/.env.staging',
  '--api-url', 'https://api.staging.example.net',
  '--dashboard-url', 'https://dashboard.staging.example.net',
  '--overlay-url', 'https://overlay.staging.example.net',
  '--assets-url', 'https://assets.staging.example.net',
  '--i-confirm-non-production',
];

test('requires explicit non-production confirmation and all staging origins', () => {
  assert.throws(() => parseOptions(args.slice(0, -1)), /--i-confirm-non-production/);
  const options = parseOptions(args, '/workspace');
  assert.equal(options.api, 'https://api.staging.example.net');
  assert.equal(options.envFile, '/workspace/infra/compose/.env.staging');
});

test('rejects unsafe origins and malformed URLs', () => {
  assert.throws(() => parseHttpsOrigin('http://api.staging.example.net', 'API'), /HTTPS origin/);
  assert.throws(() => parseHttpsOrigin('https://user:secret@api.staging.example.net', 'API'), /HTTPS origin/);
  assert.throws(() => parseHttpsOrigin('https://api.staging.example.net/health', 'API'), /HTTPS origin/);
  assert.throws(() => parseHttpsOrigin('not a URL', 'API'), /absolute URL/);
});

test('parses Docker Compose JSON array and newline-delimited output', () => {
  assert.deepEqual(parseComposePsOutput('[{"Service":"api","State":"running","Health":"healthy"}]'), [
    { Service: 'api', State: 'running', Health: 'healthy' },
  ]);
  assert.deepEqual(parseComposePsOutput('{"Service":"api","State":"running"}\n{"Service":"worker","State":"running"}'), [
    { Service: 'api', State: 'running' },
    { Service: 'worker', State: 'running', Health: 'healthy' },
  ]);
  assert.deepEqual(parseComposePsOutput(''), []);
  assert.throws(() => parseComposePsOutput('not-json'), /invalid service status/);
});

test('requires all services to be running and configured healthchecks to be healthy', () => {
  const checks = evaluateComposeServices([
    { Service: 'api', State: 'running', Health: 'healthy' },
    { Service: 'worker', State: 'running' },
    { Service: 'redis', State: 'running', Health: 'unhealthy' },
  ], [
    { service: 'api', healthcheck: true },
    { service: 'worker' },
    { service: 'redis', healthcheck: true },
    { service: 'postgres', healthcheck: true },
  ]);
  assert.deepEqual(checks.map((check) => check.status), ['passed', 'passed', 'failed', 'failed']);
  assert.equal(checks[2].severity, 'critical');
  assert.match(checks[2].message, /unhealthy/);
  assert.match(checks[3].message, /missing/);
});

test('produces a passing report when container and public endpoint checks succeed', async () => {
  const options = parseOptions(args, '/workspace');
  const app = [
    { Service: 'postgres', State: 'running', Health: 'healthy' },
    { Service: 'redis', State: 'running', Health: 'healthy' },
    { Service: 'object-storage', State: 'running' },
    { Service: 'api', State: 'running', Health: 'healthy' },
    { Service: 'worker', State: 'running' },
    { Service: 'dashboard', State: 'running', Health: 'healthy' },
    { Service: 'overlay', State: 'running', Health: 'healthy' },
  ];
  const report = await runHealthCheck(options, {
    inspectCompose: (file) => file.endsWith('docker-compose.edge.yml')
      ? [{ Service: 'edge', State: 'running' }]
      : app,
    checkHttp: async (name) => ({ name, status: 'passed', severity: 'info', message: 'ok' }),
    checkSocketIo: async () => ({ name: 'socket.io-websocket', status: 'passed', severity: 'info', message: 'ok' }),
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.summary.failed, 0);
  assert.equal(report.alerts.length, 0);
});

test('emits sanitized actionable alerts for failed dependencies and endpoints', async () => {
  const options = parseOptions(args, '/workspace');
  const report = await runHealthCheck(options, {
    inspectCompose: () => [],
    checkHttp: async (name) => ({
      name,
      status: name === 'api-ready' ? 'failed' : 'passed',
      severity: name === 'api-ready' ? 'critical' : 'info',
      message: name === 'api-ready' ? 'HTTP endpoint returned 503.' : 'ok',
    }),
    checkSocketIo: async () => ({ name: 'socket.io-websocket', status: 'passed', severity: 'info', message: 'ok' }),
  });
  assert.equal(report.status, 'failed');
  assert.ok(report.alerts.some((alert) => alert.check === 'container:postgres'));
  assert.ok(report.alerts.some((alert) => alert.check === 'api-ready'));
  assert.ok(report.alerts.every((alert) => alert.action.toLowerCase().includes('do not delete volumes')));
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('requires worker readiness healthcheck instead of container state alone', () => {
  const checks = evaluateComposeServices([
    { Service: 'worker', State: 'running', Health: 'unhealthy' },
  ], [{ service: 'worker', healthcheck: true }]);
  assert.equal(checks[0].status, 'failed');
  assert.match(checks[0].message, /unhealthy/);
});
