export type HealthStatus = 'ok' | 'degraded';

export interface HealthResponse {
  status: HealthStatus;
  timestamp: string;
}

export function getHealthResponse(now: Date = new Date()): HealthResponse {
  return { status: 'ok', timestamp: now.toISOString() };
}
