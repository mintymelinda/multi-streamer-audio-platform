import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateComposeServices,
  parseComposePsOutput,
  parseHttpsOrigin,
  parseOptions,
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
    { Service: 'worker', State: 'running' },
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
