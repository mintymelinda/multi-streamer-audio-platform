import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getChangedFiles,
  getLintableFiles,
  lintChangedFiles,
} from '../ci/lint-changed.mjs';

test('filters to existing Biome-supported source and configuration files', () => {
  const result = getLintableFiles([
    'apps/api/src/main.ts',
    'scripts/test/example.test.mjs',
    'docs/operations/guide.md',
    '.github/workflows/ci.yml',
    'pnpm-lock.yaml',
    'apps/api/src/deleted.ts',
  ], (file) => file !== 'apps/api/src/deleted.ts');

  assert.deepEqual(result, [
    'apps/api/src/main.ts',
    'scripts/test/example.test.mjs',
  ]);
});

test('uses the pull request merge-base range when linting a PR', () => {
  let received;
  const files = getChangedFiles({
    eventName: 'pull_request',
    baseSha: 'base-sha',
    headSha: 'head-sha',
  }, (_command, args) => {
    received = args;
    return 'apps/api/src/main.ts\0docs/guide.md\0';
  });

  assert.deepEqual(received, ['diff', '--name-only', '-z', 'base-sha...head-sha']);
  assert.deepEqual(files, ['apps/api/src/main.ts', 'docs/guide.md']);
});

test('uses the before/head range for pushes and handles a new-branch push safely', () => {
  const calls = [];
  const runGit = (_command, args) => {
    calls.push(args);
    return 'scripts/ci/lint-changed.mjs\0';
  };

  getChangedFiles({ eventName: 'push', baseSha: 'before-sha', headSha: 'head-sha' }, runGit);
  getChangedFiles({ eventName: 'push', baseSha: '000000000000', headSha: 'head-sha' }, runGit);

  assert.deepEqual(calls, [
    ['diff', '--name-only', '-z', 'before-sha', 'head-sha'],
    ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'head-sha'],
  ]);
});

test('does not run Biome when the change set has no supported files', () => {
  let invoked = false;
  const status = lintChangedFiles([], () => {
    invoked = true;
    return { status: 0 };
  });

  assert.equal(status, 0);
  assert.equal(invoked, false);
});

test('passes only the changed files to Biome and propagates its status', () => {
  let received;
  const status = lintChangedFiles(['apps/api/src/main.ts', 'scripts/test/example.test.mjs'], (_command, args) => {
    received = args;
    return { status: 1 };
  });

  assert.deepEqual(received, [
    'exec',
    'biome',
    'lint',
    'apps/api/src/main.ts',
    'scripts/test/example.test.mjs',
  ]);
  assert.equal(status, 1);
});

test('rejects unsupported CI event types and missing commit SHAs', () => {
  assert.throws(() => getChangedFiles({ eventName: 'workflow_dispatch', headSha: 'head' }), /supports pull_request and push/);
  assert.throws(() => getChangedFiles({ eventName: 'push' }), /head commit SHA/);
  assert.throws(() => getChangedFiles({ eventName: 'pull_request', headSha: 'head' }), /base commit SHA/);
});
