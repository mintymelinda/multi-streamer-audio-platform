import { Injectable } from '@nestjs/common';

export type ProviderExecutionStatus =
  | 'queued'
  | 'resolving'
  | 'ready'
  | 'playing'
  | 'retry_wait'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ProviderExecutionRequest {
  id: string;
  workspaceId: string;
  status: string;
}

export interface ProviderExecutionJob {
  id: string;
  queueName: string;
  workspaceId: string;
  requestId: string;
  providerInstanceId: string;
  authoritativeRequest: ProviderExecutionRequest;
  actorId?: string;
}

export interface ProviderExecutionStateInput {
  workspaceId: string;
  requestId: string;
  providerInstanceId: string;
  state: ProviderExecutionStatus;
  attempt: number;
  nextAttemptAt?: string | null;
  errorCode?: string | null;
  actorId?: string;
}

export interface ProviderExecutionQueueDependencies {
  getRequestFromPostgres(
    requestId: string,
    workspaceId: string,
    actorId?: string,
  ): Promise<ProviderExecutionRequest | null>;
  enqueueProviderExecution(job: ProviderExecutionJob): Promise<unknown>;
  updateProviderExecutionState?(state: ProviderExecutionStateInput): Promise<unknown>;
  assertExecutionEligible?(input: { workspaceId: string; requestId: string; providerInstanceId: string; actorId: string }): Promise<void>;
}

const terminalRequestStatuses = new Set([
  'completed',
  'dismissed',
  'rejected',
  'cancelled',
  'failed',
  'skipped',
]);

const executionStatuses = new Set<ProviderExecutionStatus>([
  'queued',
  'resolving',
  'ready',
  'playing',
  'retry_wait',
  'completed',
  'failed',
  'cancelled',
]);

@Injectable()
export class ProviderExecutionQueueService {
  constructor(private readonly dependencies: ProviderExecutionQueueDependencies) {}

  async enqueue(input: {
    workspaceId: string;
    requestId: string;
    providerInstanceId: string;
    actorId?: string;
  }): Promise<ProviderExecutionJob> {
    const workspaceId = required(input.workspaceId, 'workspaceId');
    const requestId = required(input.requestId, 'requestId');
    const providerInstanceId = required(input.providerInstanceId, 'providerInstanceId');
    const request = await this.requireActiveRequest(workspaceId, requestId, input.actorId);
    if (input.actorId) {
      await this.dependencies.assertExecutionEligible?.({ workspaceId, requestId, providerInstanceId, actorId: input.actorId });
    }

    const job: ProviderExecutionJob = {
      id: executionJobId(workspaceId, requestId, providerInstanceId),
      queueName: providerQueueName(providerInstanceId),
      workspaceId,
      requestId,
      providerInstanceId,
      authoritativeRequest: request,
      ...(input.actorId ? { actorId: input.actorId } : {}),
    };

    await this.dependencies.enqueueProviderExecution(job);
    return job;
  }

  async recordExecutionState(input: ProviderExecutionStateInput): Promise<void> {
    const workspaceId = required(input.workspaceId, 'workspaceId');
    const requestId = required(input.requestId, 'requestId');
    const providerInstanceId = required(input.providerInstanceId, 'providerInstanceId');
    if (!executionStatuses.has(input.state)) {
      throw new TypeError('Provider execution state is invalid.');
    }
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) {
      throw new TypeError('Provider execution attempt must be a non-negative integer.');
    }
    if (input.nextAttemptAt && Number.isNaN(Date.parse(input.nextAttemptAt))) {
      throw new TypeError('nextAttemptAt must be a valid date-time.');
    }
    if (input.errorCode && !/^[a-z0-9_]{1,100}$/.test(input.errorCode)) {
      throw new TypeError('Provider execution error code is invalid.');
    }

    await this.requireActiveRequest(workspaceId, requestId, input.actorId);
    if (input.actorId) {
      await this.dependencies.assertExecutionEligible?.({ workspaceId, requestId, providerInstanceId, actorId: input.actorId });
    }
    if (!this.dependencies.updateProviderExecutionState) {
      throw new Error('Provider execution state persistence is not configured.');
    }
    await this.dependencies.updateProviderExecutionState({
      ...input,
      workspaceId,
      requestId,
      providerInstanceId,
    });
  }

  private async requireActiveRequest(
    workspaceId: string,
    requestId: string,
    actorId?: string,
  ): Promise<ProviderExecutionRequest> {
    const request = await this.dependencies.getRequestFromPostgres(requestId, workspaceId, actorId);
    if (!request) {
      throw new Error('The authoritative PostgreSQL request does not exist.');
    }
    if (request.workspaceId !== workspaceId) {
      throw new Error('Provider execution cannot cross workspace boundaries.');
    }
    if (terminalRequestStatuses.has(request.status)) {
      throw new Error('Provider execution cannot be created for a terminal request.');
    }
    return request;
  }
}

function required(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} is required.`);
  }
  return value.trim();
}

function executionJobId(workspaceId: string, requestId: string, providerInstanceId: string) {
  return [workspaceId, requestId, providerInstanceId].join(':');
}

function providerQueueName(providerInstanceId: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(providerInstanceId)) {
    throw new TypeError('providerInstanceId contains unsupported queue-name characters.');
  }
  return `provider-execution-${providerInstanceId}`;
}
