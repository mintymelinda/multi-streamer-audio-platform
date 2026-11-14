import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProbeCleanupSql,
  findNamedVolumeMount,
  parseHttpsOrigin,
  parseOptions,
} from '../ops/staging-volume-restart-drill.mjs';

test('requires explicit non-production confirmation and an environment file', () => {
  assert.throws(() => parseOptions(['--env-file', 'infra/compose/.env.staging']), /--i-confirm-non-production/);
  assert.throws(() => parseOptions(['--i-confirm-non-production', '--env-file', 'missing.env', '--api-url', 'https://api.example.net', '--assets-url', 'https://assets.example.net']), /does not exist/);
});

test('accepts only HTTPS origins for staging endpoints', () => {
  assert.equal(parseHttpsOrigin('https://api.staging.example.net', 'API'), 'https://api.staging.example.net');
  assert.throws(() => parseHttpsOrigin('http://api.staging.example.net', 'API'), /HTTPS origin/);
  assert.throws(() => parseHttpsOrigin('https://api.staging.example.net/health', 'API'), /HTTPS origin/);
});

test('requires named volumes at the expected container mount point', () => {
  const mounts = [
    { Type: 'volume', Name: 'staging_postgres_data', Destination: '/var/lib/postgresql' },
    { Type: 'bind', Name: '', Destination: '/tmp/config' },
  ];
  assert.equal(findNamedVolumeMount(mounts, '/var/lib/postgresql'), 'staging_postgres_data');
  assert.throws(() => findNamedVolumeMount(mounts, '/tmp/config'), /named Docker volume/);
});

test('drops the probe table only when this run created it', () => {
  const ownedTableCleanup = buildProbeCleanupSql('probe-123', true);
  const existingTableCleanup = buildProbeCleanupSql('probe-123', false);
  assert.match(ownedTableCleanup, /DROP TABLE IF EXISTS/);
  assert.doesNotMatch(existingTableCleanup, /DROP TABLE/);
  assert.match(existingTableCleanup, /DELETE FROM public\.staging_volume_probe/);
  assert.throws(() => buildProbeCleanupSql("probe'; DROP TABLE users; --", false), /identifier is invalid/);
});
