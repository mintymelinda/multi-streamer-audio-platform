export type TwitchAuthorizationFailure = 'reauth_required' | 'temporarily_unavailable';

interface TwitchAuthorizationError {
  status?: number;
  code?: string;
  getStatus?: () => number;
  response?: { status?: number; error?: string };
}

const definitiveAuthorizationCodes = new Set([
  'invalid_grant',
  'invalid_token',
  'missing_scope',
  'unauthorized',
  'credential_unavailable',
  'credential_decryption_failed',
  'credential_invalid',
  'credential_expiry_invalid',
]);

export function classifyTwitchAuthorizationFailure(
  error: TwitchAuthorizationError | null | undefined,
): TwitchAuthorizationFailure {
  if (!error) return 'temporarily_unavailable';

  let status = error.status ?? error.response?.status;
  if (status === undefined && typeof error.getStatus === 'function') {
    try {
      status = error.getStatus();
    } catch {
      status = undefined;
    }
  }

  const code = error.code ?? error.response?.error;
  if (
    status === 401 ||
    status === 403 ||
    (typeof code === 'string' && definitiveAuthorizationCodes.has(code))
  ) {
    return 'reauth_required';
  }

  return 'temporarily_unavailable';
}

export function shouldPauseTwitchWorkspace(input: {
  currentStatus: string;
  failure: TwitchAuthorizationFailure;
}): boolean {
  return input.currentStatus === 'connected' && input.failure === 'reauth_required';
}

export function canResumeTwitchWorkspace(input: {
  authorizationValid?: boolean;
  broadcasterIdentityVerified?: boolean;
  requiredScopesGranted?: boolean;
  eventSubReconciled?: boolean;
  rewardMappingsReconciled?: boolean;
}): boolean {
  return (
    input.authorizationValid === true &&
    input.broadcasterIdentityVerified === true &&
    input.requiredScopesGranted === true &&
    input.eventSubReconciled === true &&
    input.rewardMappingsReconciled === true
  );
}
