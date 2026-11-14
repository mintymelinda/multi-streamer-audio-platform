import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error('PLAYWRIGHT_MODULE must point to the installed Playwright ESM entry point.');
}
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const dashboardUrl = 'http://127.0.0.1:3100';
const overlayUrl = 'http://127.0.0.1:3200';
const apiUrl = 'http://127.0.0.1:3300';
const postgresUrl = 'postgresql://platform_runtime:local-runtime-only@127.0.0.1:5432/platform';
const actorId = randomUUID();
const twitchUserId = String(Date.now()) + String(randomInt(1_000_000));
const sessionToken = randomUUID() + randomUUID();
const csrfToken = randomUUID() + randomUUID();
const sessionHash = createHash('sha256').update(sessionToken).digest('hex');
const csrfHash = createHash('sha256').update(csrfToken).digest('hex');
const children = [];
let browser;
let seeded = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(
      command + ' failed (' + result.status + '): ' + (result.stderr || result.stdout).trim(),
    );
  }
  return result.stdout.trim();
}

function postgresContainer() {
  const output = run('docker', [
    'ps',
    '--filter',
    'ancestor=postgres:18.6',
    '--format',
    '{{.ID}}',
  ]);
  const id = output.split('\n').find(Boolean);
  if (!id) throw new Error('PostgreSQL 18.6 CI service container was not found.');
  return id;
}

function sql(containerId, statement) {
  return run('docker', [
    'exec',
    '-e',
    'PGPASSWORD=ci-bootstrap-only',
    containerId,
    'psql',
    '-h',
    '127.0.0.1',
    '-U',
    'platform_bootstrap',
    '-d',
    'platform',
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
    '-c',
    statement,
  ]);
}

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

async function waitFor(url, child, expectedStatus = 200) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Server exited before becoming ready (code ' + child.exitCode + ').');
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status === expectedStatus) return;
    } catch {
      // The server is still starting.
    }
    await delay(250);
  }
  throw new Error('Server did not become ready: ' + url);
}

async function stopServers() {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null) return;
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(5_000).then(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }),
    ]);
  }));
}

function seedSession(containerId) {
  sql(containerId, [
    'BEGIN;',
    "INSERT INTO platform_users (id, twitch_user_id) VALUES ('" + actorId + "', '" + twitchUserId + "');",
    "INSERT INTO user_sessions (user_id, session_token_hash, csrf_token_hash, expires_at) VALUES ('"
      + actorId + "', '" + sessionHash + "', '" + csrfHash + "', now() + interval '10 minutes');",
    'COMMIT;',
  ].join('\n'));
  seeded = true;
}

function cleanSession(containerId) {
  sql(containerId, [
    'BEGIN;',
    "DELETE FROM workspaces WHERE owner_user_id = '" + actorId + "';",
    "DELETE FROM platform_users WHERE id = '" + actorId + "';",
    'COMMIT;',
  ].join('\n'));
}

const databaseContainer = postgresContainer();

try {
  seedSession(databaseContainer);
  const apiEnvironment = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: postgresUrl,
    API_PORT: '3300',
  };
  delete apiEnvironment.DATABASE_URL_FILE;
  const apiProcess = start('pnpm', ['--filter', '@platform/api', 'start'], apiEnvironment);
  await waitFor(apiUrl + '/health/ready', apiProcess);

  const dashboardEnvironment = {
    ...process.env,
    NODE_ENV: 'production',
    API_INTERNAL_URL: apiUrl,
    PORT: '3100',
    HOSTNAME: '127.0.0.1',
  };
  const dashboardProcess = start('pnpm', [
    '--filter',
    '@platform/dashboard',
    'start',
    '--',
    '--hostname',
    '127.0.0.1',
    '--port',
    '3100',
  ], dashboardEnvironment);
  await waitFor(dashboardUrl, dashboardProcess);

  const overlayEnvironment = {
    ...process.env,
    NODE_ENV: 'production',
    API_INTERNAL_URL: apiUrl,
    PORT: '3200',
    HOSTNAME: '127.0.0.1',
  };
  const overlayProcess = start('pnpm', [
    '--filter',
    '@platform/overlay',
    'start',
    '--',
    '--hostname',
    '127.0.0.1',
    '--port',
    '3200',
  ], overlayEnvironment);
  await waitFor(overlayUrl, overlayProcess);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(dashboardUrl, { waitUntil: 'networkidle' });
  assert.match(await page.locator('h1').innerText(), /Your channel\./);
  assert.equal(
    await page.getByRole('link', { name: 'Continue with Twitch' }).getAttribute('href'),
    '/api/auth/twitch/start?returnTo=%2F',
  );

  await context.addCookies([
    {
      name: 'platform_session',
      value: sessionToken,
      url: dashboardUrl,
      httpOnly: true,
      sameSite: 'Lax',
    },
    {
      name: 'platform_csrf',
      value: csrfToken,
      url: dashboardUrl,
      sameSite: 'Strict',
    },
  ]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Create your workspace' }).waitFor();

  const identity = await page.evaluate(async () => {
    const response = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(identity.status, 200);
  assert.equal(identity.body.user.id, actorId);
  assert.equal(identity.body.user.twitchUserId, twitchUserId);

  await page.getByPlaceholder('Workspace name').fill('Browser E2E Workspace');
  const workspaceResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/workspaces') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const workspaceResponse = await workspaceResponsePromise;
  assert.equal(workspaceResponse.status(), 201);
  const workspace = await workspaceResponse.json();
  assert.equal(typeof workspace.id, 'string');
  await page.getByRole('heading', { name: 'Browser E2E Workspace' }).waitFor();

  const starter = await page.evaluate(async ({ workspaceId, token }) => {
    const response = await fetch(`/api/workspaces/${workspaceId}/scenes/starter`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': token },
    });
    return { status: response.status, body: await response.json() };
  }, { workspaceId: workspace.id, token: csrfToken });
  assert.equal(starter.status, 201);
  assert.equal(typeof starter.body.scene.id, 'string');
  assert.match(starter.body.accessToken, /^[A-Za-z0-9_-]{43}$/);

  const overlayPage = await context.newPage();
  const overlaySnapshot = overlayPage.waitForResponse((response) =>
    response.url().includes(`/api/overlay/scenes/${starter.body.scene.id}/snapshot`),
  );
  await overlayPage.goto(
    `${overlayUrl}${starter.body.overlayPath}#${starter.body.accessToken}`,
    { waitUntil: 'networkidle' },
  );
  const snapshotResponse = await overlaySnapshot;
  assert.equal(snapshotResponse.status(), 200, 'The overlay must load its published scene from the real API.');
  await overlayPage.getByText('Now Playing', { exact: true }).first().waitFor();
  assert.equal(new URL(overlayPage.url()).hash, '', 'The overlay must scrub the bearer token from browser history.');

  const connection = await context.newCDPSession(overlayPage);
  await connection.send('Network.enable');
  await connection.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await delay(500);

  const cookieHeader = `platform_session=${sessionToken}; platform_csrf=${csrfToken}`;
  const recoveredState = {
    version: 1,
    canvas: { mode: 'responsive', width: 1920, height: 1080, snap: true, snapSize: 2 },
    transition: { type: 'none', durationMs: 0 },
    reducedMotion: true,
    elements: [{
      id: 'e2e-reconnect-now-playing',
      type: 'now-playing',
      name: 'Now Playing',
      text: 'Recovered After Reconnect',
      x: 5,
      y: 5,
      width: 58,
      height: 18,
      locked: false,
      animation: { enter: 'none', exit: 'none', durationMs: 0, delayMs: 0, trigger: 'always' },
    }],
  };
  const draftResponse = await fetch(
    `${apiUrl}/workspaces/${workspace.id}/scenes/${starter.body.scene.id}/draft`,
    {
      method: 'PUT',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ state: recoveredState, expectedRevision: 0 }),
    },
  );
  assert.equal(draftResponse.status, 200, 'The API must accept a scene draft while the overlay browser is offline.');
  const publishResponse = await fetch(
    `${apiUrl}/workspaces/${workspace.id}/scenes/${starter.body.scene.id}/publish`,
    {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ expectedRevision: 1 }),
    },
  );
  assert.equal(publishResponse.status, 201, 'The API must publish the new scene while the overlay browser is offline.');
  await connection.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await overlayPage.getByText('Recovered After Reconnect', { exact: true }).waitFor({ timeout: 20_000 });
  await connection.detach();

  const revoke = await page.evaluate(async ({ workspaceId, sceneId, token }) => {
    const response = await fetch(`/api/workspaces/${workspaceId}/scenes/${sceneId}/access-token`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'x-csrf-token': token },
    });
    return response.status;
  }, { workspaceId: workspace.id, sceneId: starter.body.scene.id, token: csrfToken });
  assert.equal(revoke, 200);
  await overlayPage.getByText('This overlay URL is invalid or has been revoked.', { exact: true }).waitFor({
    timeout: 20_000,
  });

  const rejectedLogout = await page.evaluate(async () => {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': 'incorrect-csrf-token' },
    });
    return response.status;
  });
  assert.equal(rejectedLogout, 403, 'The API must reject a logout request with an invalid CSRF token.');

  const logout = await page.evaluate(async (token) => {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': token },
    });
    return response.status;
  }, csrfToken);
  assert.equal(logout, 204);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Your channel.' }).waitFor();

  process.stdout.write(
    'Authenticated browser E2E passed: real API session resolution, workspace creation, published overlay snapshot, bearer-token revocation, CSRF enforcement, and logout.\n',
  );
} finally {
  if (browser) await browser.close();
  await stopServers();
  if (seeded) cleanSession(databaseContainer);
}
