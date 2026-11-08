export const TWITCH_REWARD_FEATURE_KEYS = ['media_request'] as const;

export type TwitchRewardFeatureKey = (typeof TWITCH_REWARD_FEATURE_KEYS)[number];
export type MediaRequestInputMode = 'url_or_search' | 'url_only' | 'text_only';

export interface MediaRequestFeatureSettings {
  inputMode: MediaRequestInputMode;
  priority: number;
}

export type TwitchRewardFeatureSettings = MediaRequestFeatureSettings;

export function isTwitchRewardFeatureKey(value: unknown): value is TwitchRewardFeatureKey {
  return (
    typeof value === 'string' &&
    TWITCH_REWARD_FEATURE_KEYS.includes(value as TwitchRewardFeatureKey)
  );
}

export function normalizeTwitchRewardFeatureSettings(
  featureKey: TwitchRewardFeatureKey,
  value: unknown,
): TwitchRewardFeatureSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Feature settings must be an object.');
  }

  const settings = value as Record<string, unknown>;
  if (featureKey !== 'media_request') {
    throw new Error('The selected Twitch reward feature is not supported.');
  }

  const allowedKeys = new Set(['inputMode', 'priority']);
  if (Object.keys(settings).some((key) => !allowedKeys.has(key))) {
    throw new Error('Media request feature settings contain an unsupported field.');
  }

  const inputMode = settings.inputMode ?? 'url_or_search';
  const priority = settings.priority ?? 0;
  if (inputMode !== 'url_or_search' && inputMode !== 'url_only' && inputMode !== 'text_only') {
    throw new Error('inputMode must be url_or_search, url_only, or text_only.');
  }
  if (
    typeof priority !== 'number' ||
    !Number.isInteger(priority) ||
    priority < 0 ||
    priority > 100
  ) {
    throw new Error('priority must be an integer between 0 and 100.');
  }

  return { inputMode, priority };
}
