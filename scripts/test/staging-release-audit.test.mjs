import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createReleaseAuditRecord,
  writeReleaseAudit,
} from '../ops/write-staging-release-audit.mjs';

const base = {
  GITHUB_REPOSITORY: 'mintymelinda/multi-streamer-audio-platform',
  GITHUB_WORKFLOW: 'Controlled staging deployment',
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_ACTOR: 'mintymelinda',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  RELEASE_SHA: 'a'.repeat(40),
  RELEASE_RISK: 'approval-required',
  RELEASE_IMAGE: 'ghcr.io/mintymelinda/multi-streamer-audio-platform/platform:' + 'a'.repeat(40),
  JOB_STATUS: 'success',
  BUILD_OUTCOME: 'success',
  DEPLOY_OUTCOME: 'success',
  INGRESS_OUTCOME: 'success',
  ROLLBACK_OUTCOME: 'skipped',
};

test('creates a deterministic sanitized successful release audit record', () => {
  const record = createReleaseAuditRecord(base, '2026-11-14T12:00:00.000Z');
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.result, 'succeeded');
  assert.equal(record.releaseCommit, base.RELEASE_SHA);
  assert.equal(record.checks.remoteDeploymentAndContainerReadiness, 'success');
  assert.equal(record.checks.publicIngressAndOAuthConfiguration, 'success');
  assert.equal(record.rollback.status, 'not_required');
  assert.equal(record.checks.rollbackPublicIngressAndOAuthConfiguration, 'skipped');
  assert.equal(JSON.stringify(record).includes('PRIVATE_KEY'), false);
  assert.equal(JSON.stringify(record).includes('STAGING_SSH_HOST'), false);
});

test('records an explicit failed rollback after a post-ingress failure', () => {
  const record = createReleaseAuditRecord({
    ...base,
    JOB_STATUS: 'failure',
    INGRESS_OUTCOME: 'failure',
    ROLLBACK_OUTCOME: 'failure',
  });
  assert.equal(record.result, 'failure');
  assert.equal(record.rollback.status, 'failed');
});

test('reports rollback as complete only when public ingress also passes', () => {
  const verified = createReleaseAuditRecord({
    ...base, JOB_STATUS: 'failure', INGRESS_OUTCOME: 'failure',
    ROLLBACK_OUTCOME: 'success', ROLLBACK_INGRESS_OUTCOME: 'success',
  });
  assert.equal(verified.rollback.status, 'succeeded_and_ingress_verified');
  const failedIngress = createReleaseAuditRecord({
    ...base, JOB_STATUS: 'failure', INGRESS_OUTCOME: 'failure',
    ROLLBACK_OUTCOME: 'success', ROLLBACK_INGRESS_OUTCOME: 'failure',
  });
  assert.equal(failedIngress.rollback.status, 'restored_but_ingress_failed');
});
test('does not claim an unobservable in-step rollback succeeded', () => {
  const record = createReleaseAuditRecord({
    ...base,
    RELEASE_RISK: 'routine',
    JOB_STATUS: 'failure',
    DEPLOY_OUTCOME: 'failure',
  });
  assert.equal(record.rollback.status, 'not_independently_reported');
  assert.match(record.rollback.detail, /inspect its sanitized workflow log/);
});

test('requires operator recovery for failed high-risk deployments', () => {
  const record = createReleaseAuditRecord({
    ...base,
    JOB_STATUS: 'failure',
    DEPLOY_OUTCOME: 'failure',
  });
  assert.equal(record.rollback.status, 'manual_recovery_required');
});

test('writes a machine-readable record and human-readable summary without secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'staging-release-audit-'));
  try {
    const output = join(directory, 'release-audit.json');
    const summary = join(directory, 'summary.md');
    await writeReleaseAudit(base, output, summary, '2026-11-14T12:00:00.000Z');
    const record = JSON.parse(await readFile(output, 'utf8'));
    const markdown = await readFile(summary, 'utf8');
    assert.equal(record.runId, '12345');
    assert.match(markdown, /Staging release audit/);
    assert.match(markdown, /90-day retention/);
    assert.doesNotMatch(markdown, /STAGING_SSH_PRIVATE_KEY/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
