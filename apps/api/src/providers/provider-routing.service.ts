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
    supportedSourceProviderIds?: string[];
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
  role: 'source' | 'output';
  eligible: boolean;
  reason: string;
}

export interface ProviderRoutingResult extends ProviderOutputAssignment {
  /** Provider that resolves the submitted media; it is not the playback output. */
  sourceProviderId: string | null;
  sourceProviderInstanceId: string | null;
  /** Provider that owns the explicitly assigned playback output. */
  providerId: string;
  reason: string;
  considered: ProviderRoutingConsideration[];
}

export interface ProviderRoutingDependencies {
  listProviderInstances(workspaceId: string, actorId?: string): Promise<RoutableProviderInstance[]>;
  getWorkspaceRules(workspaceId: string, actorId?: string): Promise<ProviderWorkspaceRoutingRules>;
  getOutputAssignment(
    workspaceId: string,
    providerInstanceId: string,
    actorId?: string,
  ): Promise<ProviderOutputAssignment | ProviderOutputAssignment[] | null>;
}

@Injectable()
export class ProviderRoutingService {
  constructor(private readonly dependencies: ProviderRoutingDependencies) {}

  async route(input: {
    workspaceId: string;
    actorId?: string;
    request: ProviderRoutingRequest;
  }): Promise<ProviderRoutingResult> {
    const workspaceId = input.workspaceId.trim();
    if (!workspaceId) throw new TypeError('workspaceId is required.');
    if (input.request.workspaceId !== workspaceId) {
      throw new TypeError('Request workspace does not match the routing workspace.');
    }
    if (!input.request.id.trim()) throw new TypeError('request.id is required.');

    const [instances, rules] = await Promise.all([
      this.dependencies.listProviderInstances(workspaceId, input.actorId),
      this.dependencies.getWorkspaceRules(workspaceId, input.actorId),
    ]);
    const allowed = new Set(rules.allowedProviderIds.map(normalizeProviderId));
    const blocked = new Set(rules.blockedProviderIds.map(normalizeProviderId));
    const preferred = new Map(
      rules.preferredProviderIds.map((providerId, index) => [
        normalizeProviderId(providerId),
        index,
      ]),
    );
    const considered: ProviderRoutingConsideration[] = [];
    const sourceProviderId = input.request.sourceProviderId
      ? normalizeProviderId(input.request.sourceProviderId)
      : null;
    if (!sourceProviderId) {
      throw new ProviderRoutingError(
        'The request has no declared media source provider.',
        'NO_ELIGIBLE_PROVIDER',
        considered,
      );
    }
    const requestedOperations = input.request.requiredOperations ?? ['resolve', 'playback'];
    const sourceOperations = requestedOperations.filter((operation) =>
      operation === 'search' || operation === 'resolve',
    );
    const outputOperations = requestedOperations.filter((operation) =>
      operation !== 'search' && operation !== 'resolve',
    );
    const sourceRequirements = sourceOperations.length > 0 ? sourceOperations : ['resolve'];
    const outputRequirements = outputOperations.length > 0 ? outputOperations : ['playback'];

    const baseReason = (instance: RoutableProviderInstance, providerId: string): string => {
      if (!instance.enabled) return 'provider instance is disabled';
      if (instance.health !== 'healthy') return `provider health is ${instance.health}`;
      if (blocked.has(providerId)) return 'provider is blocked by workspace policy';
      if (allowed.size > 0 && !allowed.has(providerId)) {
        return 'provider is not allowed by workspace policy';
      }
      return 'eligible';
    };

    const sourceCandidates = sourceProviderId
      ? instances
          .filter((instance) => normalizeProviderId(instance.providerId) === sourceProviderId)
          .map((instance) => {
            const providerId = normalizeProviderId(instance.providerId);
            let reason = baseReason(instance, providerId);
            if (
              reason === 'eligible' &&
              !supportsProviderRequest(instance.capabilities, {
                mediaType: input.request.mediaType,
                durationSeconds: input.request.durationSeconds,
                requiredOperations: sourceRequirements,
              })
            ) {
              reason = 'source provider capabilities do not satisfy media resolution';
            }
            const item: ProviderRoutingConsideration = {
              providerId,
              providerInstanceId: instance.instanceId,
              role: 'source',
              eligible: reason === 'eligible',
              reason,
            };
            considered.push(item);
            return { instance, item };
          })
          .filter(({ item }) => item.eligible)
          .sort((left, right) =>
            right.instance.priority - left.instance.priority ||
            compareStable(left.item.providerInstanceId, right.item.providerInstanceId),
          )
      : [];

    if (sourceProviderId && sourceCandidates.length === 0) {
      throw new ProviderRoutingError(
        'No enabled, healthy source provider can resolve the requested media.',
        'NO_ELIGIBLE_PROVIDER',
        considered,
      );
    }

    const eligible = instances
      .map((instance) => {
        const providerId = normalizeProviderId(instance.providerId);
        let reason = baseReason(instance, providerId);
        const requiredOperations = sourceProviderId ? outputRequirements : requestedOperations;
        if (
          reason === 'eligible' &&
          sourceProviderId &&
          instance.capabilities.supportedSourceProviderIds &&
          !instance.capabilities.supportedSourceProviderIds.includes(sourceProviderId)
        ) {
          reason = 'playback output does not support this media source provider';
        }
        if (
          reason === 'eligible' &&
          !supportsProviderRequest(instance.capabilities, {
            mediaType: input.request.mediaType,
            durationSeconds: input.request.durationSeconds,
            requiredOperations,
          })
        ) {
          reason = 'provider output capabilities do not satisfy the request';
        }
        const item: ProviderRoutingConsideration = {
          providerId,
          providerInstanceId: instance.instanceId,
          role: 'output',
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
          compareStable(left.item.providerId, right.item.providerId) ||
          compareStable(left.item.providerInstanceId, right.item.providerInstanceId)
        );
      });

    if (eligible.length === 0) {
      throw new ProviderRoutingError(
        'No enabled, healthy playback output satisfies the request and workspace routing policy.',
        'NO_ELIGIBLE_PROVIDER',
        considered,
      );
    }

    let missingOutput = false;
    for (const candidate of eligible) {
      const assignment = await this.dependencies.getOutputAssignment(
        workspaceId,
        candidate.instance.instanceId,
        input.actorId,
      );
      if (!assignment || (Array.isArray(assignment) && assignment.length === 0)) {
        missingOutput = true;
        candidate.item.eligible = false;
        candidate.item.reason = 'no explicit output assignment exists';
        continue;
      }
      if (Array.isArray(assignment) && assignment.length !== 1) {
        candidate.item.eligible = false;
        candidate.item.reason = 'multiple output assignments are ambiguous';
        continue;
      }
      const output = Array.isArray(assignment) ? assignment.at(0) : assignment;
      if (
        !output?.outputId?.trim() ||
        !output.playerId?.trim() ||
        output.providerInstanceId !== candidate.instance.instanceId
      ) {
        candidate.item.eligible = false;
        candidate.item.reason =
          'output assignment is incomplete or belongs to another provider instance';
        continue;
      }
      return {
        sourceProviderId,
        sourceProviderInstanceId: sourceCandidates[0]?.instance.instanceId ?? null,
        providerId: candidate.item.providerId,
        providerInstanceId: output.providerInstanceId,
        outputId: output.outputId,
        playerId: output.playerId,
        reason: buildRoutingReason(
          candidate.item.providerId,
          candidate.instance.priority,
          preferred,
        ),
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
  return `Selected ${providerId}: ${preference}; provider priority ${priority}; output capabilities and health requirements satisfied.`;
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
