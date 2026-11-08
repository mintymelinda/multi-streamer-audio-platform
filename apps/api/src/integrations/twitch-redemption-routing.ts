import type { MediaRequestInputMode } from './twitch-reward-features.js';

export interface TwitchRedemptionRequestInput {
  title: string;
  mediaUrl?: string;
  requesterTwitchUserId?: string;
  requesterDisplayName?: string;
  sourceEventId: string;
  metadata: Record<string, unknown>;
}

export function buildTwitchRedemptionRequest(
  event: Record<string, unknown>,
  inputMode: MediaRequestInputMode,
  eventId: string,
  mappingId: string,
  rewardId: string,
): TwitchRedemptionRequestInput | null {
  const rawInput = typeof event.user_input === 'string' ? event.user_input.trim() : '';
  if (!rawInput || rawInput.length > 500) return null;

  const isHttpUrl = /^https?:\/\//i.test(rawInput);
  if (inputMode === 'url_only' && !isHttpUrl) return null;

  const userId = typeof event.user_id === 'string' ? event.user_id : undefined;
  const displayName =
    typeof event.user_name === 'string'
      ? event.user_name
      : typeof event.user_login === 'string'
        ? event.user_login
        : undefined;

  return {
    title: rawInput,
    ...(isHttpUrl && inputMode !== 'text_only' ? { mediaUrl: rawInput } : {}),
    ...(userId && /^[0-9]{1,32}$/.test(userId) ? { requesterTwitchUserId: userId } : {}),
    ...(displayName ? { requesterDisplayName: displayName.slice(0, 100) } : {}),
    sourceEventId: eventId,
    metadata: { source: 'twitch_eventsub', rewardId, mappingId },
  };
}
