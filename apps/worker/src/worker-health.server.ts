import { createServer, type Server } from 'node:http';

export interface WorkerHealthProbes {
  postgres: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

export interface WorkerReadinessReport {
  status: 'ok' | 'not_ready';
  timestamp: string;
  uptimeSeconds: number;
  dependencies: {
    postgres: 'ready' | 'unavailable';
    redis: 'ready' | 'unavailable';
  };
}

export async function getWorkerReadiness(
  probes: WorkerHealthProbes,
  now: () => number = Date.now,
  startedAt = now(),
): Promise<WorkerReadinessReport> {
  const [postgres, redis] = await Promise.allSettled([
    probes.postgres(),
    probes.redis(),
  ]);
  const dependencies = {
    postgres: postgres.status === 'fulfilled' ? 'ready' as const : 'unavailable' as const,
    redis: redis.status === 'fulfilled' ? 'ready' as const : 'unavailable' as const,
  };
  const ready = dependencies.postgres === 'ready' && dependencies.redis === 'ready';
  return {
    status: ready ? 'ok' : 'not_ready',
    timestamp: new Date(now()).toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1_000)),
    dependencies,
  };
}

export function createWorkerHealthServer(
  probes: WorkerHealthProbes,
  options: { now?: () => number; startedAt?: number } = {},
): Server {
  const startedAt = options.startedAt ?? (options.now ?? Date.now)();
  return createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
      response.end(JSON.stringify({ status: 'method_not_allowed' }));
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date((options.now ?? Date.now)()).toISOString(),
        uptimeSeconds: Math.max(0, Math.floor(((options.now ?? Date.now)() - startedAt) / 1_000)),
      }));
      return;
    }
    if (pathname !== '/health/ready') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'not_found' }));
      return;
    }
    void getWorkerReadiness(probes, options.now, startedAt).then((report) => {
      response.writeHead(report.status === 'ok' ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(report));
    }).catch(() => {
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'not_ready' }));
    });
  });
}

export function listenWorkerHealthServer(server: Server, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('worker_health_port_invalid');
  }
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export function closeWorkerHealthServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
