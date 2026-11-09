import { Injectable } from '@nestjs/common';
import {
  supportsProviderRequest,
  type ProviderMediaType,
  type ProviderRequestRequirements,
} from './provider-contracts.js';

export type ProviderRoutingErrorCode = 'NO_ELIGIBLE_PROVIDER' | 'OUTPUT_NOT_ASSIGNED';

export class ProviderRoutingError extends Error {
  constructor(
    message: string,
    readonly code: ProviderRoutingErrorCode,
    readonly considered: ProviderRoutingConsideration[],
  ) {
    super(message);
    this.name = 'ProviderRoutingError';
  }
}

export interface RoutableProviderInstance {
  providerId: string;
  instanceId: string;
  enabled: boolean;
  health: 'healthy' | 'degraded' | 'unavailable' | 'authorization_expired' | 'unconfigured';
  priority: number;
  capabilities: {
    search: boolean;
    resolve: boolean;
    playback: boolean;
    pause: boolean;
    resume: boolean;
    seek: boolean;
    queue: boolean;
    maxDurationSeconds: number | null;
    mediaTypes: ProviderMediaType[];
  };
}

export interface ProviderRoutingRequest {
  id: string;
  workspaceId: string;
  mediaType: ProviderMediaType;
  durationSeconds: number | null;
  sourceProviderId: string | null;
  requiredOperations?: ProviderRequestRequirements['requiredOperations'];
}

export interface ProviderWorkspaceRoutingRules {
  allowedProviderIds: string[];
  blockedProviderIds: string[];
  preferredProviderIds: string[];
}

export interface ProviderOutputAssignment {
  outputId: string;
  providerInstanceId: string;
  playerId: string;
}

export interface ProviderRoutingConsideration {
  providerId: string;
  providerInstanceId: string;
  eligible: boolean;
  reason: string;
}

export interface ProviderRoutingResult extends ProviderOutputAssignment {
  providerId: string;
  reason: string;
  considered: ProviderRoutingConsideration[];
}

export interface ProviderRoutingDependencies {
  listProviderInstances(workspaceId: string): Promise<RoutableProviderInstance[]>;
  getWorkspaceRules(workspaceId: string): Promise<ProviderWorkspaceRoutingRules>;
  getOutputAssignment(
    workspaceId: string,
    providerInstanceId: string,
  ): Promise<ProviderOutputAssignment | ProviderOutputAssignment[] | null>;
}

@Injectable()
export class ProviderRoutingService {
  constructor(private readonly dependencies: ProviderRoutingDependencies) {}

  async route(input: {
    workspaceId: string;
    request: ProviderRoutingRequest;
  }): Promise<ProviderRoutingResult> {
    const workspaceId = input.workspaceId.trim();
    if (!workspaceId) throw new TypeError('workspaceId is required.');
    if (input.request.workspaceId !== workspaceId) {
      throw new TypeError('Request workspace does not match the routing workspace.');
    }
    if (!input.request.id.trim()) throw new TypeError('request.id is required.');

    const [instances, rules] = await Promise.all([
      this.dependencies.listProviderInstances(workspaceId),
      this.dependencies.getWorkspaceRules(workspaceId),
    ]);
    const allowed = new Set(rules.allowedProviderIds.map(normalizeProviderId));
    const blocked = new Set(rules.blockedProviderIds.map(normalizeProviderId));
    const preferred = new Map(
      rules.preferredProviderIds.map((providerId, index) => [normalizeProviderId(providerId), index]),
    );
    const considered: ProviderRoutingConsideration[] = [];
    const eligible = instances
      .map((instance) => {
        const providerId = normalizeProviderId(instance.providerId);
        let reason = 'eligible';
        if (!instance.enabled) reason = 'provider instance is disabled';
        else if (instance.health !== 'healthy') reason = `provider health is ${instance.health}`;
        else if (blocked.has(providerId)) reason = 'provider is blocked by workspace policy';
        else if (allowed.size > 0 && !allowed.has(providerId))
          reason = 'provider is not allowed by workspace policy';
        else if (
          !supportsProviderRequest(instance.capabilities, {
            mediaType: input.request.mediaType,
            durationSeconds: input.request.durationSeconds,
            requiredOperations: input.request.requiredOperations ?? ['resolve', 'playback'],
          })
        ) {
          reason = 'provider capabilities do not satisfy the request';
        }
        const item = {
          providerId,
          providerInstanceId: instance.instanceId,
          eligible: reason === 'eligible',
          reason,
        };
        considered.push(item);
        return { instance, item };
      })
      .filter(({ item }) => item.eligible)
      .sort((left, right) => {
        const leftPreference = preferred.get(left.item.providerId) ?? Number.MAX_SAFE_INTEGER;
        const rightPreference = preferred.get(right.item.providerId) ?? Number.MAX_SAFE_INTEGER;
        return (
          leftPreference - rightPreference ||
          right.instance.priority - left.instance.priority ||
          left.item.providerId.localeCompare(right.item.providerId) ||
          left.item.providerInstanceId.localeCompare(right.item.providerInstanceId)
        );
      });

    if (eligible.length === 0) {
      throw new ProviderRoutingError(
        'No enabled, healthy provider satisfies the request and workspace routing policy.',
        'NO_ELIGIBLE_PROVIDER',
        considered,
      );
    }

    let missingOutput = false;
    for (const candidate of eligible) {
      const assignment = await this.dependencies.getOutputAssignment(
        workspaceId,
        candidate.instance.instanceId,
      );
      if (!assignment || (Array.isArray(assignment) && assignment.length === 0)) {
        missingOutput = true;
        considered.push({
          providerId: candidate.item.providerId,
          providerInstanceId: candidate.item.providerInstanceId,
          eligible: false,
          reason: 'no explicit output assignment exists',
        });
        continue;
      }
      if (Array.isArray(assignment)) {
        if (assignment.length !== 1) {
          considered.push({
            providerId: candidate.item.providerId,
            providerInstanceId: candidate.item.providerInstanceId,
            eligible: false,
            reason: 'multiple output assignments are ambiguous',
          });
          continue;
        }
      }
      const output = Array.isArray(assignment) ? assignment[0] : assignment;
      if (
        !output.outputId?.trim() ||
        !output.playerId?.trim() ||
        output.providerInstanceId !== candidate.instance.instanceId
      ) {
        considered.push({
          providerId: candidate.item.providerId,
          providerInstanceId: candidate.item.providerInstanceId,
          eligible: false,
          reason: 'output assignment is incomplete or belongs to another provider instance',
        });
        continue;
      }
      return {
        providerId: candidate.item.providerId,
        providerInstanceId: output.providerInstanceId,
        outputId: output.outputId,
        playerId: output.playerId,
        reason: buildRoutingReason(candidate.item.providerId, candidate.instance.priority, preferred),
        considered,
      };
    }

    throw new ProviderRoutingError(
      missingOutput
        ? 'Eligible providers exist, but none has an explicit output assignment.'
        : 'Eligible providers have ambiguous or invalid output assignments.',
      'OUTPUT_NOT_ASSIGNED',
      considered,
    );
  }
}

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

function buildRoutingReason(
  providerId: string,
  priority: number,
  preferred: Map<string, number>,
): string {
  const preference = preferred.has(providerId)
    ? `workspace preference rank ${(preferred.get(providerId) ?? 0) + 1}`
    : 'no explicit workspace preference';
  return `Selected ${providerId}: ${preference}; provider priority ${priority}; request capabilities and health requirements satisfied.`;
}
