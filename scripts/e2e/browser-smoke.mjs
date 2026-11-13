import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error('PLAYWRIGHT_MODULE must point to the installed Playwright ESM entry point.');
}
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const dashboardUrl = 'http://127.0.0.1:3100';
const overlayUrl = 'http://127.0.0.1:3200';
const children = [];

function startApp(packageName, port) {
  const child = spawn(
    'pnpm',
    [
      '--filter',
      packageName,
      'start',
      '--',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1' },
      stdio: 'ignore',
    },
  );
  children.push(child);
  return child;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js server exited before becoming ready (code ${child.exitCode}).`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status < 500) return;
    } catch {
      // The Next.js process is still starting.
    }
    await delay(250);
  }
  throw new Error(`Next.js server did not become ready: ${url}`);
}

async function stopApps() {
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

const dashboardProcess = startApp('@platform/dashboard', 3100);
const overlayProcess = startApp('@platform/overlay', 3200);
let browser;

try {
  await Promise.all([
    waitForServer(dashboardUrl, dashboardProcess),
    waitForServer(overlayUrl, overlayProcess),
  ]);
  browser = await chromium.launch({ headless: true });

  const dashboard = await browser.newPage();
  await dashboard.route('**/api/auth/me', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'Sign-in is required.' }),
  }));
  await dashboard.goto(dashboardUrl, { waitUntil: 'networkidle' });
  assert.match(await dashboard.locator('h1').innerText(), /Your channel\./);
  assert.equal(
    await dashboard.getByRole('link', { name: 'Continue with Twitch' }).getAttribute('href'),
    '/api/auth/twitch/start?returnTo=%2F',
  );

  const sceneId = '6b5c1a9e-5b5f-4c10-8c91-8d6d41f8f80a';
  const token = 'A'.repeat(43);
  let authorizationHeader = '';
  let namespaceConnected = false;
  const overlay = await browser.newPage();

  await overlay.route(`**/api/overlay/scenes/${sceneId}/snapshot`, async (route) => {
    authorizationHeader = route.request().headers().authorization ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'cache-control': 'no-store, private',
        'referrer-policy': 'no-referrer',
      },
      body: JSON.stringify({
        sceneId,
        name: 'Browser E2E Scene',
        publishedState: {
          canvas: { mode: 'responsive' },
          elements: [
            {
              id: 'e2e-now-playing',
              type: 'now-playing',
              text: 'Browser E2E Track',
              x: 0,
              y: 0,
              width: 100,
              height: 100,
            },
          ],
        },
      }),
    });
  });
  await overlay.routeWebSocket('**/api/socket.io/**', (socket) => {
    socket.onMessage((message) => {
      const packet = String(message);
      if (packet.startsWith('40/overlay,')) {
        namespaceConnected = true;
        socket.send('40/overlay,{"sid":"browser-e2e"}');
      } else if (packet === '2') {
        socket.send('3');
      }
    });
    socket.send('0{"sid":"browser-e2e","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
  });

  await overlay.goto(`${overlayUrl}/scene/${sceneId}#${token}`, { waitUntil: 'networkidle' });
  await overlay.locator('.overlay-track-title').getByText('Browser E2E Track').waitFor();
  assert.equal(new URL(overlay.url()).hash, '', 'The bearer token fragment must be scrubbed from browser history.');
  assert.equal(authorizationHeader, `Bearer ${token}`, 'The scene token must be sent only as a bearer header.');
  assert.equal(namespaceConnected, true, 'The overlay must complete its Socket.IO namespace handshake.');
  assert.equal(await overlay.locator('main.overlay-scene').getAttribute('aria-label'), 'Browser E2E Scene');

  const invalidOverlay = await browser.newPage();
  await invalidOverlay.goto(`${overlayUrl}/scene/${sceneId}`, { waitUntil: 'networkidle' });
  assert.match(
    await invalidOverlay.locator('main').innerText(),
    /invalid or has been revoked/i,
  );

  process.stdout.write('Browser UI smoke tests passed: dashboard sign-in boundary, published overlay token handling, Socket.IO handshake, and invalid-token rejection.\n');
} finally {
  if (browser) await browser.close();
  await stopApps();
}
