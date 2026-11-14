import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChangedFiles } from '../release/classify-change.mjs';

test('classifies documentation-only changes as not requiring deployment', () => {
  const result = classifyChangedFiles(['README.md', 'docs/operations/operator-handbook.md']);
  assert.equal(result.risk, 'no-deploy');
  assert.match(result.reason, /Documentation-only/);
});

test('allows automatic deployment only for dashboard and overlay presentation assets', () => {
  const result = classifyChangedFiles([
    'apps/dashboard/app/globals.css',
    'apps/overlay/public/placeholder.png',
    'docs/operations/phase8-verification.md',
  ]);
  assert.equal(result.risk, 'routine');
  assert.deepEqual(result.approvalRequiredFiles, undefined);
});

test('requires owner approval for application logic and security-sensitive paths', () => {
  for (const path of [
    'apps/api/src/auth/auth.service.ts',
    'apps/worker/src/main.ts',
    'packages/contracts/src/request.ts',
    'infra/postgres/migrations/202611140001.sql',
    '.github/workflows/ci.yml',
    'pnpm-lock.yaml',
    'scripts/deletion-ledger.mjs',
  ]) {
    const result = classifyChangedFiles([path]);
    assert.equal(result.risk, 'approval-required', path);
    assert.ok(result.approvalRequiredFiles.includes(path));
  }
});

test('defaults missing, empty, and unknown changed-file lists to approval-required', () => {
  assert.equal(classifyChangedFiles([]).risk, 'approval-required');
  assert.equal(classifyChangedFiles(null).risk, 'approval-required');
  assert.equal(classifyChangedFiles(['apps/dashboard/app/page.tsx']).risk, 'approval-required');
});

test('does not let a documentation path hide a high-risk source change', () => {
  const result = classifyChangedFiles([
    'docs/operations/release-policy.md',
    'apps/dashboard/app/page.tsx',
  ]);
  assert.equal(result.risk, 'approval-required');
  assert.deepEqual(result.approvalRequiredFiles, ['apps/dashboard/app/page.tsx']);
});
