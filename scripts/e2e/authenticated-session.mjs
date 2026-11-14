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
const foreignActorId = randomUUID();
const foreignWorkspaceId = randomUUID();
const foreignTwitchUserId = String(Date.now() + 1) + String(randomInt(1_000_000));
const twitchUserId = String(Date.now()) + String(randomInt(1_000_000));
const sessionToken = randomUUID() + randomUUID();
const csrfToken = randomUUID() + randomUUID();
const sessionHash = createHash('sha256').update(sessionToken).digest('hex');
const csrfHash = createHash('sha256').update(csrfToken).digest('hex');
const foreignSessionToken = randomUUID() + randomUUID();
const foreignCsrfToken = randomUUID() + randomUUID();
const foreignSessionHash = createHash('sha256').update(foreignSessionToken).digest('hex');
const foreignCsrfHash = createHash('sha256').update(foreignCsrfToken).digest('hex');
const invitationId = randomUUID();
const invitationTokenHash = createHash('sha256').update(randomUUID()).digest('hex');
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
    "INSERT INTO platform_users (id, twitch_user_id) VALUES ('" + foreignActorId + "', '" + foreignTwitchUserId + "');",
    "INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES ('" + foreignWorkspaceId + "', 'Isolation Canary Workspace', '" + foreignActorId + "', '" + foreignTwitchUserId + "');",
    "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ('" + foreignWorkspaceId + "', '" + foreignActorId + "', 'owner');",
    "INSERT INTO user_sessions (user_id, session_token_hash, csrf_token_hash, expires_at) VALUES ('"
      + actorId + "', '" + sessionHash + "', '" + csrfHash + "', now() + interval '10 minutes');",
    "INSERT INTO user_sessions (user_id, session_token_hash, csrf_token_hash, expires_at) VALUES ('"
      + foreignActorId + "', '" + foreignSessionHash + "', '" + foreignCsrfHash + "', now() + interval '10 minutes');",
    'COMMIT;',
  ].join('\n'));
  seeded = true;
}

function seedInvitation(containerId, workspaceId) {
  sql(containerId, [
    "INSERT INTO workspace_invitations (id, workspace_id, invited_twitch_user_id, assigned_role, token_hash, invited_by_user_id, expires_at) VALUES ('"
      + invitationId + "', '" + workspaceId + "', '" + foreignTwitchUserId + "', 'moderator', '"
      + invitationTokenHash + "', '" + actorId + "', now() + interval '7 days');",
  ].join('\n'));
}

function cleanSession(containerId) {
  sql(containerId, [
    'BEGIN;',
    "DELETE FROM workspaces WHERE id IN ('" + actorId + "', '" + foreignWorkspaceId + "') OR owner_user_id IN ('" + actorId + "', '" + foreignActorId + "');",
    "DELETE FROM platform_users WHERE id IN ('" + actorId + "', '" + foreignActorId + "');",
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

  browser = await chromium.launch({ channel: 'chrome', headless: true });
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

  seedInvitation(databaseContainer, workspace.id);
  const inviteeContext = await browser.newContext();
  await inviteeContext.addCookies([
    {
      name: 'platform_session',
      value: foreignSessionToken,
      url: dashboardUrl,
      httpOnly: true,
      sameSite: 'Lax',
    },
    {
      name: 'platform_csrf',
      value: foreignCsrfToken,
      url: dashboardUrl,
      sameSite: 'Strict',
    },
  ]);
  const inviteePage = await inviteeContext.newPage();
  await inviteePage.goto(`${dashboardUrl}/invitations`, { waitUntil: 'networkidle' });
  await inviteePage.getByRole('heading', { name: 'Invitation inbox' }).waitFor();
  await inviteePage.getByRole('heading', { name: 'Browser E2E Workspace' }).waitFor();

  const pendingAccess = await inviteePage.evaluate(async (workspaceId) => {
    const response = await fetch(`/api/workspaces/${workspaceId}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    return response.status;
  }, workspace.id);
  assert.equal(pendingAccess, 404, 'A pending invitation must not grant workspace access.');

  const wrongIdentityAcceptance = await page.evaluate(async ({ invitationId, token }) => {
    const response = await fetch(`/api/me/invitations/${invitationId}/accept`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': token },
    });
    return response.status;
  }, { invitationId, token: csrfToken });
  assert.equal(wrongIdentityAcceptance, 404, 'An invitation cannot be accepted by a different signed-in Twitch identity.');

  await inviteePage.getByRole('button', { name: 'Accept' }).click();
  await inviteePage.waitForURL(dashboardUrl + '/');
  const acceptedMemberships = await inviteePage.evaluate(async () => {
    const response = await fetch('/api/workspaces', { credentials: 'include', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(acceptedMemberships.status, 200);
  assert.ok(acceptedMemberships.body.some((item) =>
    item.id === workspace.id && item.role === 'moderator',
  ), 'The invitation must grant only its assigned Moderator role.');

  const requestSettingsResponse = await fetch(
    `${apiUrl}/workspaces/${workspace.id}/requests/settings`,
    {
      method: 'PATCH',
      headers: {
        cookie: `platform_session=${sessionToken}; platform_csrf=${csrfToken}`,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        moderationMode: 'manual',
        queueLimit: 50,
        perUserLimit: 5,
        perSourceLimit: 50,
        holdTerms: [],
        rejectTerms: [],
      }),
    },
  );
  assert.equal(requestSettingsResponse.status, 200, 'The workspace owner must be able to configure manual moderation.');

  async function submitModerationRequest(title) {
    const response = await fetch(`${apiUrl}/workspaces/${workspace.id}/requests`, {
      method: 'POST',
      headers: {
        cookie: `platform_session=${sessionToken}; platform_csrf=${csrfToken}`,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ title, requesterDisplayName: 'Browser E2E' }),
    });
    assert.equal(response.status, 201, 'The owner must be able to submit a request.');
    return response.json();
  }

  const rejectedRequest = await submitModerationRequest('E2E moderator rejects this');
  const approvedRequest = await submitModerationRequest('E2E moderator approves this');
  assert.equal(rejectedRequest.status, 'pending');
  assert.equal(approvedRequest.status, 'pending');

  const moderatorSettingsAttempt = await inviteePage.evaluate(async ({ workspaceId, token }) => {
    const response = await fetch(`/api/workspaces/${workspaceId}/requests/settings`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({
        moderationMode: 'automatic',
        queueLimit: 50,
        perUserLimit: 5,
        perSourceLimit: 50,
        holdTerms: [],
        rejectTerms: [],
      }),
    });
    return response.status;
  }, { workspaceId: workspace.id, token: foreignCsrfToken });
  assert.equal(moderatorSettingsAttempt, 403, 'A Moderator must not change workspace-level request settings.');

  const moderationResults = await inviteePage.evaluate(async ({ workspaceId, rejectId, approveId, token }) => {
    async function moderate(requestId, action) {
      const response = await fetch(`/api/workspaces/${workspaceId}/requests/${requestId}/moderation`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ action, reason: 'Verified by browser E2E' }),
      });
      return { status: response.status, body: await response.json() };
    }
    const rejected = await moderate(rejectId, 'reject');
    const approved = await moderate(approveId, 'approve');
    const queue = await fetch(`/api/workspaces/${workspaceId}/queue`, {
      credentials: 'include',
      cache: 'no-store',
    });
    return {
      rejected,
      approved,
      queueStatus: queue.status,
      queue: await queue.json(),
    };
  }, {
    workspaceId: workspace.id,
    rejectId: rejectedRequest.id,
    approveId: approvedRequest.id,
    token: foreignCsrfToken,
  });
  assert.equal(moderationResults.rejected.status, 200);
  assert.equal(moderationResults.rejected.body.status, 'rejected');
  assert.equal(moderationResults.approved.status, 200);
  assert.equal(moderationResults.approved.body.status, 'queued');
  assert.equal(moderationResults.queueStatus, 200);
  assert.ok(
    moderationResults.queue.some((entry) => entry.id === approvedRequest.id),
    'The Moderator must be able to see the approved request in the playable queue.',
  );
  assert.ok(
    !moderationResults.queue.some((entry) => entry.id === rejectedRequest.id),
    'Rejected requests must not appear in the playable queue.',
  );

  const reorderRequest = await submitModerationRequest('E2E moderator reorders this request');
  assert.equal(reorderRequest.status, 'pending');
  const reorderApproval = await inviteePage.evaluate(async ({ workspaceId, requestId, token }) => {
    const response = await fetch(`/api/workspaces/${workspaceId}/requests/${requestId}/moderation`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ action: 'approve', reason: 'Approved for queue ordering test' }),
    });
    return { status: response.status, body: await response.json() };
  }, { workspaceId: workspace.id, requestId: reorderRequest.id, token: foreignCsrfToken });
  assert.equal(reorderApproval.status, 200);
  assert.equal(reorderApproval.body.status, 'queued');

  const reorderedQueue = await inviteePage.evaluate(async ({ workspaceId, token }) => {
    const beforeResponse = await fetch(`/api/workspaces/${workspaceId}/queue`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const before = await beforeResponse.json();
    const requestIds = before.map((entry) => entry.id).reverse();
    const reorderResponse = await fetch(`/api/workspaces/${workspaceId}/queue/order`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ requestIds }),
    });
    const afterResponse = await fetch(`/api/workspaces/${workspaceId}/queue`, {
      credentials: 'include',
      cache: 'no-store',
    });
    return {
      before,
      reorderStatus: reorderResponse.status,
      reorderBody: await reorderResponse.json(),
      after: await afterResponse.json(),
    };
  }, { workspaceId: workspace.id, token: foreignCsrfToken });
  assert.equal(reorderedQueue.before.length, 2, 'Both approved requests must be visible to the Moderator.');
  assert.equal(reorderedQueue.reorderStatus, 200);
  assert.deepEqual(
    reorderedQueue.reorderBody.requestIds,
    reorderedQueue.before.map((entry) => entry.id).reverse(),
  );
  assert.deepEqual(
    reorderedQueue.after.map((entry) => entry.id),
    reorderedQueue.before.map((entry) => entry.id).reverse(),
    'The Moderator must be able to persist a new logical queue order.',
  );

  const revokedMembership = await page.evaluate(async ({ workspaceId, memberId, token }) => {
    const response = await fetch(`/api/workspaces/${workspaceId}/members/${memberId}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'x-csrf-token': token },
    });
    return response.status;
  }, { workspaceId: workspace.id, memberId: foreignActorId, token: csrfToken });
  assert.equal(revokedMembership, 200);
  const afterRevocation = await inviteePage.evaluate(async (workspaceId) => {
    const response = await fetch(`/api/workspaces/${workspaceId}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    return response.status;
  }, workspace.id);
  assert.equal(afterRevocation, 404, 'Membership revocation must immediately remove workspace access.');

  const workspaceBoundary = await page.evaluate(async (foreignId) => {
    const listed = await fetch('/api/workspaces', { credentials: 'include', cache: 'no-store' });
    const listedBody = await listed.json();
    const foreignRead = await fetch(`/api/workspaces/${foreignId}/scenes`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const foreignMutation = await fetch(`/api/workspaces/${foreignId}/scenes/starter`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': document.cookie.split('; ').find((value) => value.startsWith('platform_csrf='))?.split('=')[1] ?? '' },
    });
    return {
      listedStatus: listed.status,
      listed: listedBody,
      foreignReadStatus: foreignRead.status,
      foreignReadBody: await foreignRead.text(),
      foreignMutationStatus: foreignMutation.status,
    };
  }, foreignWorkspaceId);
  assert.equal(workspaceBoundary.listedStatus, 200);
  assert.ok(workspaceBoundary.listed.some((entry) => entry.id === workspace.id));
  assert.ok(!JSON.stringify(workspaceBoundary.listed).includes(foreignWorkspaceId));
  assert.ok(!JSON.stringify(workspaceBoundary.listed).includes('Isolation Canary Workspace'));
  assert.equal(workspaceBoundary.foreignReadStatus, 404);
  assert.ok(!workspaceBoundary.foreignReadBody.includes('Isolation Canary Workspace'));
  assert.equal(workspaceBoundary.foreignMutationStatus, 404);
  await inviteeContext.close();

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
  const snapshotHeaders = snapshotResponse.headers();
  assert.match(snapshotHeaders['cache-control'] ?? '', /no-store/);
  assert.match(snapshotHeaders['cache-control'] ?? '', /private/);
  assert.equal(snapshotHeaders['referrer-policy'], 'no-referrer');
  assert.match(snapshotHeaders.vary ?? '', /authorization/i);

  const unknownTokenPage = await context.newPage();
  const unknownTokenResponse = unknownTokenPage.waitForResponse((response) =>
    response.url().includes(`/api/overlay/scenes/${starter.body.scene.id}/snapshot`),
  );
  await unknownTokenPage.goto(
    `${overlayUrl}${starter.body.overlayPath}#${'b'.repeat(43)}`,
    { waitUntil: 'networkidle' },
  );
  const rejectedSnapshot = await unknownTokenResponse;
  assert.equal(rejectedSnapshot.status(), 404, 'A well-formed but unknown bearer token must not disclose a scene.');
  assert.match(rejectedSnapshot.headers()['cache-control'] ?? '', /no-store/);
  assert.equal(rejectedSnapshot.headers()['referrer-policy'], 'no-referrer');
  await unknownTokenPage.getByText('This overlay URL is invalid or has been revoked.', { exact: true }).waitFor();

  const malformedTokenPage = await context.newPage();
  await malformedTokenPage.goto(
    `${overlayUrl}${starter.body.overlayPath}#not-a-valid-token`,
    { waitUntil: 'networkidle' },
  );
  await malformedTokenPage.getByText('This overlay URL is invalid or has been revoked.', { exact: true }).waitFor();
  assert.equal(
    await malformedTokenPage.evaluate(() => performance.getEntriesByType('resource')
      .some((entry) => entry.name.includes('/api/overlay/scenes/'))),
    false,
    'Malformed fragment tokens must be rejected before making an API request.',
  );

  const draftOnlyState = {
    version: 1,
    canvas: { mode: 'responsive', width: 1920, height: 1080, snap: true, snapSize: 2 },
    transition: { type: 'none', durationMs: 0 },
    reducedMotion: true,
    elements: [{
      id: 'e2e-draft-only-now-playing',
      type: 'now-playing',
      name: 'Now Playing',
      text: 'Draft Must Stay Private',
      x: 5,
      y: 5,
      width: 58,
      height: 18,
      locked: false,
      animation: { enter: 'none', exit: 'none', durationMs: 0, delayMs: 0, trigger: 'always' },
    }],
  };
  const cookieHeader = `platform_session=${sessionToken}; platform_csrf=${csrfToken}`;
  const draftOnlyResponse = await fetch(
    `${apiUrl}/workspaces/${workspace.id}/scenes/${starter.body.scene.id}/draft`,
    {
      method: 'PUT',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ state: draftOnlyState, expectedRevision: 0 }),
    },
  );
  assert.equal(draftOnlyResponse.status, 200);
  await delay(500);
  assert.equal(await overlayPage.getByText('Draft Must Stay Private', { exact: true }).count(), 0);
  assert.equal(await overlayPage.getByText('Now Playing', { exact: true }).count(), 1);

  const publishDraftResponse = await fetch(
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
  assert.equal(publishDraftResponse.status, 201);
  await overlayPage.getByText('Draft Must Stay Private', { exact: true }).waitFor({ timeout: 10_000 });

  const connection = await context.newCDPSession(overlayPage);
  await connection.send('Network.enable');
  await connection.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await delay(500);

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
      body: JSON.stringify({ state: recoveredState, expectedRevision: 2 }),
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
      body: JSON.stringify({ expectedRevision: 3 }),
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
  await unknownTokenPage.close();
  await malformedTokenPage.close();

  const rejectedLogout = await page.evaluate(async () => {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': 'incorrect-csrf-token' },
      signal: AbortSignal.timeout(5_000),
    });
    return response.status;
  });
  assert.equal(rejectedLogout, 403, 'The API must reject a logout request with an invalid CSRF token.');

  const logout = await page.evaluate(async (token) => {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': token },
      signal: AbortSignal.timeout(5_000),
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
