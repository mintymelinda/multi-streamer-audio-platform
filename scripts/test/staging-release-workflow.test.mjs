import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/staging-deploy.yml'), 'utf8');
const compose = readFileSync(resolve(repositoryRoot, 'infra/compose/docker-compose.staging.yml'), 'utf8');
const remoteOverride = readFileSync(resolve(repositoryRoot, 'infra/compose/docker-compose.staging.remote.yml'), 'utf8');

test('automatic staging deployment only follows successful main-branch CI pushes', () => {
  assert.match(workflow, /workflow_run:\n\s+workflows: \["CI"\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(workflow, /workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(workflow, /latest_main_sha/);
  assert.match(workflow, /status=completed/);
  assert.match(workflow, /STAGING_DEPLOY_ENABLED == 'true'/);
});

test('high-risk deployment requires the platform owner, main branch, and explicit approval input', () => {
  assert.match(workflow, /approve_high_risk:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.actor == 'mintymelinda'/);
  assert.match(workflow, /inputs\.approve_high_risk/);
  assert.match(workflow, /staging-approval/);
});

test('release workflow uses immutable image tags and pinned SSH host verification', () => {
  assert.match(workflow, /platform:\$RELEASE_SHA/);
  assert.match(workflow, /STAGING_SSH_KNOWN_HOSTS/);
  assert.match(workflow, /StrictHostKeyChecking=yes|known_hosts/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
  assert.match(workflow, /staging-deployment-smoke\.mjs/);
});

test('routine rollback is limited to routine changes; high-risk recovery is manual', () => {
  assert.match(workflow, /Roll back a failed routine deployment/);
  assert.match(workflow, /failure\(\) && needs\.classify\.outputs\.risk == 'routine'/);
  assert.match(workflow, /Preserve failed high-risk deployment for operator recovery/);
  assert.match(workflow, /No automatic image rollback was attempted/);
  assert.match(workflow, /Previous application image was restored but did not become healthy/);
  assert.match(workflow, /Previous application image restored and API, worker, dashboard, and overlay are healthy/);
  assert.match(workflow, /Verify public ingress after routine rollback/);
  assert.match(workflow, /rollback_healthy/);
});

test('staging Compose supports a caller-supplied immutable image and remote mode disables builds', () => {
  assert.equal((compose.match(/image: \$\{PLATFORM_IMAGE:-platform-staging-app:local\}/g) || []).length, 4);
  assert.match(remoteOverride, /build: null/);
  assert.match(remoteOverride, /Do not attempt a build on the staging host/);
});

test('deployment workflow does not target production or run for pull-request events', () => {
  assert.doesNotMatch(workflow, /environment:\s*production/);
  assert.doesNotMatch(workflow, /pull_request:/);
});

test('every staging deployment attempt writes and retains sanitized audit evidence, including failures', () => {
  assert.match(workflow, /Write sanitized release audit record/);
  assert.match(workflow, /id: audit/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /Upload release audit and ingress evidence/);
  assert.match(workflow, /retention-days: 90/);
  assert.match(workflow, /staging-ingress-checks\.json/);
  assert.match(workflow, /steps\.deploy\.outcome/);
  assert.match(workflow, /steps\.ingress\.outcome/);
  assert.match(workflow, /steps\.rollback\.outcome/);
  assert.match(workflow, /steps\.rollback_ingress\.outcome/);
  assert.match(workflow, /staging-rollback-ingress-checks\.json/);
  assert.match(workflow, /id: rollback/);
});

test('post-deployment ingress evidence is captured for API, dashboard, overlay, storage, WebSocket, and Twitch callbacks', () => {
  assert.match(workflow, /staging-deployment-smoke\.mjs/);
  assert.match(workflow, /tee staging-ingress-checks\.json/);
  assert.match(workflow, /health\/ready/);
  assert.match(workflow, /twitch-integration-callback-url/);
});
