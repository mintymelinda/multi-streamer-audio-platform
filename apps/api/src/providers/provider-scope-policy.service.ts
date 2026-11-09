import { Injectable } from '@nestjs/common';

export type ProviderFeatureScopes = Record<string, string[]>;

export interface ProviderScopePolicyOptions {
  requiredScopes?: Record<string, ProviderFeatureScopes>;
}

@Injectable()
export class ProviderScopePolicyService {
  private readonly requiredScopes: Record<string, ProviderFeatureScopes>;

  constructor(options: ProviderScopePolicyOptions = {}) {
    this.requiredScopes = options.requiredScopes ?? {};
  }

  getRequestedScopes(input: { providerId: string; features: string[] }): string[] {
    const featureMap = this.requiredScopes[input.providerId.trim().toLowerCase()] ?? {};
    const scopes = new Set<string>();
    for (const feature of input.features) {
      for (const scope of featureMap[feature] ?? []) {
        if (typeof scope === 'string' && scope.trim()) scopes.add(scope.trim());
      }
    }
    return [...scopes];
  }

  validateGrantedScopes(input: {
    providerId: string;
    requestedScopes: string[];
    grantedScopes: string[];
  }): { valid: boolean; unexpectedScopes: string[]; missingScopes: string[] } {
    const requested = new Set(input.requestedScopes);
    const featureMap = this.requiredScopes[input.providerId.trim().toLowerCase()];
    const allowed = featureMap ? new Set(Object.values(featureMap).flat()) : requested;
    const granted = new Set(input.grantedScopes);
    const unexpectedScopes = [...granted]
      .filter((scope) => !requested.has(scope) || !allowed.has(scope))
      .sort();
    const missingScopes = [...requested].filter((scope) => !granted.has(scope)).sort();
    return {
      valid: unexpectedScopes.length === 0 && missingScopes.length === 0,
      unexpectedScopes,
      missingScopes,
    };
  }

  onAuthorizationExpired(input: { providerInstanceId: string }) {
    if (!input.providerInstanceId.trim()) {
      throw new TypeError('providerInstanceId is required.');
    }
    return {
      providerInstanceId: input.providerInstanceId,
      connectionHealth: 'authorization_expired' as const,
      executionAllowed: false,
      reconnectRequired: true,
    };
  }
}
