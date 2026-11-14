import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');

test('CI uses a read-only token and does not persist checkout credentials', () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /permissions:\n  contents: write/);
  assert.match(workflow, /persist-credentials: false/);
});

test('CI requires lint, type checking, migration validation, tests, and builds', () => {
  for (const command of [
    'pnpm lint',
    'pnpm typecheck',
    'pnpm db:migrations:check',
    'pnpm test',
    'pnpm build',
  ]) {
    assert.ok(workflow.includes('run: ' + command), 'Missing required CI command: ' + command);
  }
  assert.match(workflow, /Build immutable staging application image/);
  assert.match(workflow, /Run browser UI smoke tests/);
  assert.match(workflow, /Run authenticated browser and overlay runtime E2E/);
});

test('CI never repairs or pushes lockfile changes from an untrusted workflow run', () => {
  assert.doesNotMatch(workflow, /Repair and commit lockfile/);
  assert.doesNotMatch(workflow, /git push origin/);
});

test('CI does not add the repository-excluded formatting check as a quality gate', () => {
  assert.doesNotMatch(workflow, /pnpm format:check|biome format \.|Check Formatting/);
});
