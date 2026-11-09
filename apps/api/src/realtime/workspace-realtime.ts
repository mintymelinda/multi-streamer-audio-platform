import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

interface AuthenticatedSession {
  userId?: string;
  authenticated?: boolean;
}

interface WorkspaceMembership {
  userId: string;
  workspaceId: string;
  role: 'owner' | 'admin' | 'moderator' | 'viewer';
  active: boolean;
}

export async function authorizeWorkspaceSubscription(input: {
  session: AuthenticatedSession;
  requestedWorkspaceId: string;
  authorizeMembership: (context: {
    userId: string;
    workspaceId: string;
  }) => Promise<WorkspaceMembership | null>;
}): Promise<{
  userId: string;
  workspaceId: string;
  role: WorkspaceMembership['role'];
}> {
  const userId = input.session.userId;
  if (input.session.authenticated !== true || typeof userId !== 'string' || !userId) {
    throw new UnauthorizedException('An authenticated session is required.');
  }
  if (!input.requestedWorkspaceId || input.requestedWorkspaceId.length > 128) {
    throw new ForbiddenException('Workspace access is not authorized.');
  }

  const membership = await input.authorizeMembership({
    userId,
    workspaceId: input.requestedWorkspaceId,
  });
  if (
    !membership ||
    membership.active !== true ||
    membership.userId !== userId ||
    membership.workspaceId !== input.requestedWorkspaceId
  ) {
    throw new ForbiddenException('Workspace access is not authorized.');
  }

  return {
    userId: membership.userId,
    workspaceId: membership.workspaceId,
    role: membership.role,
  };
}

export function buildWorkspaceSnapshotCursor(input: {
  workspaceId: string;
  eventId: string;
  sequence: number;
}): {
  workspaceId: string;
  eventId: string;
  sequence: number;
} {
  if (
    !input.workspaceId ||
    input.workspaceId.length > 128 ||
    !input.eventId ||
    input.eventId.length > 128 ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0
  ) {
    throw new RangeError('Workspace snapshot cursor is invalid.');
  }
  return {
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    sequence: input.sequence,
  };
}

const sensitivePayloadKeys = new Set([
  'accessToken',
  'refreshToken',
  'credential',
  'credentials',
  'credentialCiphertext',
  'rawWebhookBody',
]);

function containsSensitivePayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitivePayload);
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (sensitivePayloadKeys.has(key) || containsSensitivePayload(child)) return true;
  }
  return false;
}

export function isSafeWorkspaceEvent(
  event: {
    id?: unknown;
    workspaceId?: unknown;
    type?: unknown;
    payload?: unknown;
  },
  authorizedWorkspaceId: string,
): boolean {
  return (
    typeof event.id === 'string' &&
    event.id.length > 0 &&
    event.workspaceId === authorizedWorkspaceId &&
    typeof event.type === 'string' &&
    event.type.length > 0 &&
    !containsSensitivePayload(event.payload)
  );
}
