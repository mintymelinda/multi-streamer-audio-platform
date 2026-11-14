#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const REQUIRED = ['api-url', 'dashboard-url', 'overlay-url', 'assets-url', 'twitch-integration-callback-url'];

export function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--i-confirm-non-production') {
      options.confirmNonProduction = true;
      continue;
    }
    if (!argument?.startsWith('--')) throw new Error('Unexpected positional argument.');
    const key = argument.slice(2);
    if (!REQUIRED.includes(key)) throw new Error('Unknown option: --' + key);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --' + key);
    options[key] = value;
    index += 1;
  }
  for (const key of REQUIRED) {
    if (!options[key]) throw new Error('Missing required option --' + key);
  }
  if (!options.confirmNonProduction) {
    throw new Error('Refusing to probe an environment without --i-confirm-non-production.');
  }
  options.api = parseHttpsOrigin(options['api-url'], 'API');
  options.dashboard = parseHttpsOrigin(options['dashboard-url'], 'dashboard');
  options.overlay = parseHttpsOrigin(options['overlay-url'], 'overlay');
  options.assets = parseHttpsOrigin(options['assets-url'], 'assets');
  options.integrationCallback = options['twitch-integration-callback-url'];
  const expectedIntegration = new URL('/auth/twitch/integration/callback', options.api).toString();
  if (options.integrationCallback !== expectedIntegration) {
    throw new Error('The configured Twitch integration callback must exactly match ' + expectedIntegration);
  }
  return options;
}

export function parseHttpsOrigin(value, label = 'URL') {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(label + ' URL must be absolute.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(label + ' URL must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  return parsed.origin;
}

export function validateTwitchLoginRedirect(location, expectedCallback) {
  let target;
  try {
    target = new URL(location);
  } catch {
    throw new Error('Twitch sign-in did not return a valid authorization URL.');
  }
  if (target.origin !== 'https://id.twitch.tv' || target.pathname !== '/oauth2/authorize') {
    throw new Error('Twitch sign-in redirected to an unexpected authorization endpoint.');
  }
  if (target.searchParams.get('redirect_uri') !== expectedCallback) {
    throw new Error('Twitch sign-in redirect_uri does not match the public API callback URL.');
  }
  if (!target.searchParams.get('state')) {
    throw new Error('Twitch sign-in authorization URL is missing its state parameter.');
  }
  return true;
}

async function checkHttp(name, url, expectedStatus = 200) {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== expectedStatus) {
    throw new Error(name + ' returned HTTP ' + response.status + '; expected ' + expectedStatus + '.');
  }
  return { name, status: response.status };
}

async function checkWebSocket(apiOrigin) {
  const url = new URL('/socket.io/?EIO=4&transport=websocket', apiOrigin);
  const socket = new WebSocket(url);
  try {
    const packet = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Socket.IO WebSocket handshake timed out.')), 10_000);
      socket.addEventListener('message', (event) => {
        const value = String(event.data);
        if (value.startsWith('0{')) {
          clearTimeout(timeout);
          resolve(value);
        }
      });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Socket.IO WebSocket connection failed.'));
      });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        reject(new Error('Socket.IO closed before its Engine.IO open packet arrived.'));
      });
    });
    socket.close();
    return { name: 'socket.io-websocket-upgrade', status: 'connected', openPacketReceived: packet.startsWith('0{') };
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function main(argv) {
  const options = parseOptions(argv);
  const loginCallback = new URL('/auth/twitch/callback', options.api).toString();
  const checks = [];
  checks.push(await checkHttp('api-live', new URL('/health/live', options.api)));
  checks.push(await checkHttp('api-ready', new URL('/health/ready', options.api)));
  checks.push(await checkHttp('dashboard', options.dashboard + '/'));
  checks.push(await checkHttp('overlay', options.overlay + '/'));
  checks.push(await checkHttp('object-storage-ready', new URL('/minio/health/ready', options.assets)));
  const login = await fetch(new URL('/auth/twitch/start', options.api), {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (login.status !== 302) {
    throw new Error('Twitch sign-in start returned HTTP ' + login.status + '; expected 302.');
  }
  const location = login.headers.get('location');
  if (!location) throw new Error('Twitch sign-in start did not include a Location header.');
  validateTwitchLoginRedirect(location, loginCallback);
  checks.push({ name: 'twitch-login-callback', status: 'matched', callback: loginCallback });
  checks.push({ name: 'twitch-integration-callback', status: 'matched', callback: options.integrationCallback });
  checks.push(await checkWebSocket(options.api));
  process.stdout.write(JSON.stringify({
    status: 'passed',
    scope: 'non-production staging ingress smoke test',
    origins: {
      api: options.api,
      dashboard: options.dashboard,
      overlay: options.overlay,
      assets: options.assets,
    },
    checks,
    note: 'This verifies public ingress and callback configuration. It does not authorize a Twitch account or test a real provider callback exchange.',
  }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'Staging deployment smoke test failed.') + '\n');
    process.exitCode = 1;
  });
}
