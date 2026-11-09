import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

export interface RecoverablePlaybackRequest {
  id: string;
  workspaceId: string;
  mediaId: string | null;
  status: string;
  providerInstanceId?: string | null;
}

export interface PlaybackRecoveryDependencies {
  authorize(input: {
    workspaceId: string;
    actorId: string;
    action: string;
  }): Promise<{ allowed: boolean }>;
  getRequest(input: {
    workspaceId: string;
    requestId: string;
    actorId: string;
  }): Promise<RecoverablePlaybackRequest | null>;
  retry(request: RecoverablePlaybackRequest, actorId: string): Promise<unknown>;
  reroute(
    request: RecoverablePlaybackRequest,
    providerInstanceId: string,
    actorId: string,
  ): Promise<unknown>;
  skip(request: RecoverablePlaybackRequest, actorId: string, reason: string): Promise<unknown>;
  dismiss(request: RecoverablePlaybackRequest, actorId: string, reason: string): Promise<unknown>;
  appendAudit(event: Record<string, unknown>): Promise<unknown>;
}

@Injectable()
export class PlaybackRecoveryService {
  constructor(private readonly dependencies: PlaybackRecoveryDependencies) {}

  async retry(input: RecoveryActionInput) {
    const { request, reason } = await this.authorizedRequest(input, 'retry');
    if (!['failed', 'queued', 'resolving', 'ready'].includes(request.status)) {
      throw new Error('Only failed or active requests can be retried.');
    }
    await this.dependencies.retry(request, input.actorId);
    await this.audit(input, 'retry', reason, request);
    return {
      requestId: request.id,
      mediaId: request.mediaId,
      providerInstanceId: request.providerInstanceId ?? null,
    };
  }

  async reroute(input: RecoveryActionInput & { providerInstanceId: string }) {
    const { request, reason } = await this.authorizedRequest(input, 'reroute');
    const providerInstanceId = required(input.providerInstanceId, 'providerInstanceId');
    if (!['failed', 'queued', 'resolving', 'ready'].includes(request.status)) {
      throw new Error('Only failed or active requests can be rerouted.');
    }
    await this.dependencies.reroute(request, providerInstanceId, input.actorId);
    await this.audit(input, 'reroute', reason, request, providerInstanceId);
    return { requestId: request.id, mediaId: request.mediaId, providerInstanceId };
  }

  async skip(input: RecoveryActionInput) {
    const { request, reason } = await this.authorizedRequest(input, 'skip');
    await this.dependencies.skip(request, input.actorId, reason);
    await this.audit(input, 'skip', reason, request);
    return { requestId: request.id, mediaId: request.mediaId, status: 'skipped' };
  }

  async dismiss(input: RecoveryActionInput) {
    const { request, reason } = await this.authorizedRequest(input, 'dismiss');
    await this.dependencies.dismiss(request, input.actorId, reason);
    await this.audit(input, 'dismiss', reason, request);
    return { requestId: request.id, mediaId: request.mediaId, status: 'dismissed' };
  }

  private async authorizedRequest(input: RecoveryActionInput, action: string) {
    const workspaceId = required(input.workspaceId, 'workspaceId');
    const requestId = required(input.requestId, 'requestId');
    const actorId = required(input.actorId, 'actorId');
    const reason = requiredReason(input.reason);
    const authorization = await this.dependencies.authorize({ workspaceId, actorId, action });
    if (!authorization.allowed)
      throw new ForbiddenException('You cannot recover this workspace request.');
    const request = await this.dependencies.getRequest({ workspaceId, requestId, actorId });
    if (!request || request.workspaceId !== workspaceId) {
      throw new NotFoundException('Playback request not found.');
    }
    return { request, reason };
  }

  private async audit(
    input: RecoveryActionInput,
    action: string,
    reason: string,
    request: RecoverablePlaybackRequest,
    providerInstanceId?: string,
  ) {
    await this.dependencies.appendAudit({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      requestId: request.id,
      action: `playback.recovery.${action}`,
      reason,
      ...(providerInstanceId ? { providerInstanceId } : {}),
      mediaId: request.mediaId,
    });
  }
}

export interface RecoveryActionInput {
  workspaceId: string;
  requestId: string;
  actorId: string;
  reason: string;
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required.`);
  return value.trim();
}

function requiredReason(value: string): string {
  const reason = required(value, 'reason');
  if (reason.length < 10 || reason.length > 500) {
    throw new TypeError('A recovery reason between 10 and 500 characters is required.');
  }
  return reason;
}
