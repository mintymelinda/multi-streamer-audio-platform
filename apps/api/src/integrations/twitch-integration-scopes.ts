export const REQUIRED_TWITCH_REWARD_SCOPES = ['channel:manage:redemptions'] as const;

export function hasRequiredTwitchRewardScopes(scopes: unknown): scopes is string[] {
  return (
    Array.isArray(scopes) &&
    REQUIRED_TWITCH_REWARD_SCOPES.every((required) => scopes.includes(required))
  );
}
