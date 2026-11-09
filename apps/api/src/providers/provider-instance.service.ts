import { Injectable } from '@nestjs/common';
import { PROVIDER_CONTRACT_VERSION } from './provider-contracts.js';

export type ProviderConnectionHealth =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'authorization_expired';

export interface ProviderInstanceIdentity {
  id: string;
  workspaceId: string;
  providerId: string;
  instanceKey: string;
}

export interface ProviderInstanceRepository {
  findByIdentity(input: {
    workspaceId: string;
    providerId: string;
    instanceKey: string;
    userId?: string;
  }): Promise<ProviderInstanceIdentity | null>;
  create(input: {
    workspaceId: string;
    providerId: string;
    instanceKey: string;
    userId: string;
    contractVersion: number;
  }): Promise<ProviderInstanceIdentity>;
}

export interface ProviderInstanceServiceOptions {
  repository?: ProviderInstanceRepository;
  findByIdentity?: ProviderInstanceRepository['findByIdentity'];
  currentContractVersion?: number;
}

@Injectable()
export class ProviderInstanceService {
  private readonly currentContractVersion: number;
  private readonly repository?: ProviderInstanceRepository;

  constructor(options: ProviderInstanceServiceOptions = {}) {
    this.currentContractVersion = options.currentContractVersion ?? PROVIDER_CONTRACT_VERSION;
    this.repository =
      options.repository ??
      (options.findByIdentity
        ? {
            findByIdentity: options.findByIdentity,
            create: async () => {
              throw new Error('Provider instance creation is not configured.');
            },
          }
        : undefined);
  }

  async resolveIdentity(input: {
    workspaceId: string;
    providerId: string;
    instanceKey: string;
    userId?: string;
  }): Promise<ProviderInstanceIdentity> {
    const workspaceId = input.workspaceId.trim();
    const providerId = input.providerId.trim().toLowerCase();
    const instanceKey = input.instanceKey.trim();
    if (!workspaceId) throw new TypeError('workspaceId is required.');
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerId))
      throw new TypeError('providerId is invalid.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(instanceKey))
      throw new TypeError('instanceKey is invalid.');
    if (!this.repository) throw new Error('Provider instance repository is not configured.');
    const identity = await this.repository.findByIdentity({
      workspaceId,
      providerId,
      instanceKey,
      userId: input.userId,
    });
    if (identity) {
      if (
        identity.workspaceId !== workspaceId ||
        identity.providerId !== providerId ||
        identity.instanceKey !== instanceKey ||
        !identity.id
      ) {
        throw new Error('Provider instance repository returned an inconsistent identity.');
      }
      return identity;
    }
    if (!input.userId)
      throw new Error('An authenticated user is required to create a provider instance.');
    return this.repository.create({
      workspaceId,
      providerId,
      instanceKey,
      userId: input.userId,
      contractVersion: this.currentContractVersion,
    });
  }

  async validateContractVersion(version: number): Promise<boolean> {
    if (!Number.isInteger(version) || version !== this.currentContractVersion) {
      throw new Error(`Unsupported provider contract version: ${String(version)}.`);
    }
    return true;
  }
}

export interface ProviderHealthProbe {
  reachable: boolean;
  latencyMs: number | null;
}

@Injectable()
export class ProviderHealthService {
  classify(input: {
    latencyMs: number | null;
    authorizationValid: boolean;
    consecutiveFailures: number;
  }): ProviderConnectionHealth {
    if (!input.authorizationValid) return 'authorization_expired';
    if (input.latencyMs === null || input.consecutiveFailures >= 3) return 'unavailable';
    if (input.latencyMs > 1_000 || input.consecutiveFailures > 0) return 'degraded';
    return 'healthy';
  }

  async applyProbeResult(input: {
    currentState: ProviderConnectionHealth;
    probe: ProviderHealthProbe;
  }): Promise<{ status: ProviderConnectionHealth; requiresReconnect: boolean }> {
    if (input.currentState === 'authorization_expired')
      return { status: 'authorization_expired', requiresReconnect: true };
    const status = this.classify({
      latencyMs: input.probe.reachable ? input.probe.latencyMs : null,
      authorizationValid: true,
      consecutiveFailures: input.probe.reachable ? 0 : 3,
    });
    return { status, requiresReconnect: false };
  }
}
