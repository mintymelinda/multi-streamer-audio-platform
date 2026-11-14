#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function value(input, fallback = 'unknown') {
  return typeof input === 'string' && input.trim() ? input.trim() : fallback;
}

export function createReleaseAuditRecord(env, recordedAt = new Date().toISOString()) {
  const deploy = value(env.DEPLOY_OUTCOME, 'skipped');
  const ingress = value(env.INGRESS_OUTCOME, 'skipped');
  const rollbackStep = value(env.ROLLBACK_OUTCOME, 'skipped');
  const risk = value(env.RELEASE_RISK);
  let rollbackStatus = 'not_required';
  if (rollbackStep === 'success') rollbackStatus = 'succeeded';
  else if (rollbackStep === 'failure') rollbackStatus = 'failed';
  else if (deploy === 'failure' && risk === 'routine') rollbackStatus = 'not_independently_reported';
  else if (deploy === 'failure' && risk === 'approval-required') rollbackStatus = 'manual_recovery_required';

  const jobStatus = value(env.JOB_STATUS, 'unknown');
  return {
    schemaVersion: 1,
    recordedAt,
    repository: value(env.GITHUB_REPOSITORY),
    workflow: value(env.GITHUB_WORKFLOW),
    runId: value(env.GITHUB_RUN_ID),
    runAttempt: value(env.GITHUB_RUN_ATTEMPT),
    actor: value(env.GITHUB_ACTOR),
    event: value(env.GITHUB_EVENT_NAME),
    releaseCommit: value(env.RELEASE_SHA),
    risk,
    image: value(env.RELEASE_IMAGE, 'not_published'),
    result: jobStatus === 'success' ? 'succeeded' : jobStatus,
    checks: {
      imageBuildAndPublish: value(env.BUILD_OUTCOME, 'skipped'),
      remoteDeploymentAndContainerReadiness: deploy,
      publicIngressAndOAuthConfiguration: ingress,
    },
    rollback: {
      status: rollbackStatus,
      detail: rollbackStatus === 'not_independently_reported'
        ? 'The remote deployment step failed; inspect its sanitized workflow log to confirm whether its in-step routine rollback completed.'
        : rollbackStatus === 'manual_recovery_required'
          ? 'High-risk releases are not automatically rolled back because database compatibility may have changed.'
          : 'Rollback status reflects the dedicated post-ingress rollback step when one was required.',
    },
  };
}

export async function writeReleaseAudit(env, outputPath = 'release-audit.json', summaryPath = process.env.GITHUB_STEP_SUMMARY, recordedAt) {
  const record = createReleaseAuditRecord(env, recordedAt);
  await writeFile(outputPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  if (summaryPath) {
    const summary = [
      '## Staging release audit',
      '',
      '- Result: ' + record.result,
      '- Commit: ' + record.releaseCommit,
      '- Risk: ' + record.risk,
      '- Image: ' + record.image,
      '- Container deployment/readiness: ' + record.checks.remoteDeploymentAndContainerReadiness,
      '- Public ingress: ' + record.checks.publicIngressAndOAuthConfiguration,
      '- Rollback: ' + record.rollback.status,
      '- Audit artifact: release-audit.json (90-day retention)',
      '',
      'This record contains release metadata and check outcomes only; it excludes deployment credentials, environment values, and private service URLs.',
      '',
    ].join('\n');
    await appendFile(summaryPath, summary, { mode: 0o600 });
  }
  return record;
}

async function main() {
  const record = await writeReleaseAudit(process.env);
  process.stdout.write(JSON.stringify({ status: 'written', result: record.result, auditFile: 'release-audit.json' }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'Unable to write staging release audit.') + '\n');
    process.exitCode = 1;
  });
}
