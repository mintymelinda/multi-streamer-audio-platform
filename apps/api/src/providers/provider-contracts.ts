export const PROVIDER_CONTRACT_VERSION = 1;

export type ProviderMediaType = 'audio' | 'video' | 'live_stream';

export interface ProviderCapabilities {
  search: boolean;
  resolve: boolean;
  playback: boolean;
  pause: boolean;
  resume: boolean;
  seek: boolean;
  queue: boolean;
  maxDurationSeconds: number | null;
  mediaTypes: ProviderMediaType[];
}

export interface ProviderHealth {
  status: 'healthy' | 'degraded' | 'unavailable' | 'authorization_expired' | 'unconfigured';
  checkedAt?: string;
  latencyMs?: number | null;
  consecutiveFailures?: number;
}

export interface ProviderAdapterDescriptor {
  providerId: string;
  instanceId: string;
  contractVersion: number;
  capabilities: ProviderCapabilities;
  health: ProviderHealth;
}

export interface ProviderRequestRequirements {
  mediaType: ProviderMediaType;
  durationSeconds: number | null;
  requiredOperations: Array<'search' | 'resolve' | 'playback' | 'pause' | 'resume' | 'seek' | 'queue'>;
}

const OPERATIONS = ['search', 'resolve', 'playback', 'pause', 'resume', 'seek', 'queue'] as const;
const MEDIA_TYPES = ['audio', 'video', 'live_stream'] as const;
const SECRET_KEY = /(?:access.?token|refresh.?token|client.?secret|authorization|credential|ciphertext|private.?key|password|api.?key)/i;
const REDACTED = '[REDACTED]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateProviderAdapter(value: unknown, supportedContractVersion = PROVIDER_CONTRACT_VERSION): value is ProviderAdapterDescriptor {
  if (!isRecord(value)) throw new TypeError('Provider adapter descriptor must be an object.');
  if (!isNonEmptyString(value.providerId) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.providerId)) {
    throw new TypeError('Provider adapter providerId is invalid.');
  }
  if (!isNonEmptyString(value.instanceId)) throw new TypeError('Provider adapter instanceId is required.');
  if (!Number.isInteger(value.contractVersion) || value.contractVersion !== supportedContractVersion) {
    throw new TypeError('Provider adapter contract version is unsupported.');
  }
  if (!isRecord(value.capabilities)) throw new TypeError('Provider adapter capabilities are required.');
  for (const operation of OPERATIONS) {
    if (typeof value.capabilities[operation] !== 'boolean') throw new TypeError(`Provider capability ${operation} must be boolean.`);
  }
  const maxDuration = value.capabilities.maxDurationSeconds;
  if (maxDuration !== null && (typeof maxDuration !== 'number' || !Number.isFinite(maxDuration) || maxDuration <= 0)) {
    throw new TypeError('Provider maxDurationSeconds must be null or a positive finite number.');
  }
  const mediaTypes = value.capabilities.mediaTypes;
  if (!Array.isArray(mediaTypes) || mediaTypes.length === 0 || mediaTypes.some((item) => !MEDIA_TYPES.includes(item as ProviderMediaType))) {
    throw new TypeError('Provider mediaTypes must contain at least one supported media type.');
  }
  if (!isRecord(value.health) || !['healthy', 'degraded', 'unavailable', 'authorization_expired', 'unconfigured'].includes(String(value.health.status))) {
    throw new TypeError('Provider health status is invalid.');
  }
  return true;
}

export function supportsProviderRequest(capabilities: ProviderCapabilities, request: ProviderRequestRequirements): boolean {
  if (!capabilities.mediaTypes.includes(request.mediaType)) return false;
  if (request.durationSeconds !== null && capabilities.maxDurationSeconds !== null && request.durationSeconds > capabilities.maxDurationSeconds) return false;
  return request.requiredOperations.every((operation) => capabilities[operation] === true);
}

export function redactProviderSecrets<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const visit = (input: unknown): unknown => {
    if (typeof input === 'string') return input.replace(/\b(Bearer|OAuth)\s+[^\s,;]+/gi, '$1 [REDACTED]');
    if (input === null || typeof input !== 'object') return input;
    const existing = seen.get(input);
    if (existing) return existing;
    if (Array.isArray(input)) {
      const output: unknown[] = [];
      seen.set(input, output);
      for (const item of input) output.push(visit(item));
      return output;
    }
    const output: Record<string, unknown> = {};
    seen.set(input, output);
    for (const [key, item] of Object.entries(input)) output[key] = SECRET_KEY.test(key) ? REDACTED : visit(item);
    return output;
  };
  return visit(value) as T;
}
