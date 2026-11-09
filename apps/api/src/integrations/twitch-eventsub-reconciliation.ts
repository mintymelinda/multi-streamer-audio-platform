export interface LocalEventSubSubscription {
  subscriptionId: string;
  eventType: string;
  eventVersion: string;
}

export interface RemoteEventSubSubscription {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, unknown>;
}

export interface EventSubReconciliationResult {
  subscriptionId: string;
  status: 'enabled' | 'disabled' | 'revoked';
  reason: string | null;
}

export function reconcileEventSubSubscriptions(
  local: LocalEventSubSubscription[],
  remote: RemoteEventSubSubscription[],
  broadcasterUserId: string,
): EventSubReconciliationResult[] {
  const remoteById = new Map(remote.map((subscription) => [subscription.id, subscription]));
  return local.map((subscription) => {
    const current = remoteById.get(subscription.subscriptionId);
    if (!current) {
      return {
        subscriptionId: subscription.subscriptionId,
        status: 'revoked',
        reason: 'missing_on_twitch',
      };
    }
    const broadcasterMatches =
      current.condition.broadcaster_user_id === undefined ||
      current.condition.broadcaster_user_id === broadcasterUserId;
    if (
      current.type !== subscription.eventType ||
      current.version !== subscription.eventVersion ||
      !broadcasterMatches
    ) {
      return {
        subscriptionId: subscription.subscriptionId,
        status: 'disabled',
        reason: 'subscription_metadata_mismatch',
      };
    }
    if (current.status !== 'enabled') {
      return {
        subscriptionId: subscription.subscriptionId,
        status: 'disabled',
        reason: 'not_enabled_on_twitch',
      };
    }
    return {
      subscriptionId: subscription.subscriptionId,
      status: 'enabled',
      reason: null,
    };
  });
}
