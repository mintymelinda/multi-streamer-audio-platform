import { Injectable } from '@nestjs/common';

export type ProviderOutputAssignmentErrorCode = 'OUTPUT_NOT_ASSIGNED' | 'OUTPUT_ALREADY_ASSIGNED' | 'INVALID_OUTPUT_ASSIGNMENT' | 'CONCURRENT_OUTPUT_NOT_APPROVED';
export class ProviderOutputAssignmentError extends Error {
  constructor(message: string, readonly code: ProviderOutputAssignmentErrorCode) { super(message); this.name = 'ProviderOutputAssignmentError'; }
}
export interface ProviderOutputAssignmentRecord {
  id: string; workspaceId: string; providerInstanceId: string; outputId: string; playerId: string; assignedBy: string;
}
export interface ProviderConcurrencyApproval { approvedBy: string; capability: 'concurrentOutput'; approvalId: string; }
type Repository = {
  findAssignment(input: { workspaceId: string; providerInstanceId: string; userId?: string }): Promise<ProviderOutputAssignmentRecord | null>;
  findConflicts(input: { workspaceId: string; providerInstanceId: string; outputId: string; playerId: string; userId?: string }): Promise<ProviderOutputAssignmentRecord[]>;
  saveAssignment?(input: { workspaceId: string; providerInstanceId: string; outputId: string; playerId: string; actorId: string }): Promise<ProviderOutputAssignmentRecord>;
  releaseAssignment?(input: { workspaceId: string; providerInstanceId: string; userId?: string }): Promise<boolean>;
};
export interface ProviderOutputAssignmentServiceOptions {
  findAssignment?: Repository['findAssignment']; findConflicts?: Repository['findConflicts'];
  saveAssignment?: Repository['saveAssignment']; releaseAssignment?: Repository['releaseAssignment'];
  verifyConcurrencyApproval?: (approval: ProviderConcurrencyApproval) => Promise<boolean>;
  recordConcurrencyApprovalUse?: (approval: ProviderConcurrencyApproval) => Promise<void>;
  repository?: Repository;
}
@Injectable()
export class ProviderOutputAssignmentService {
  private readonly repository: Repository;
  private readonly hasAssignmentLookup: boolean;
  constructor(private readonly options: ProviderOutputAssignmentServiceOptions = {}) {
    this.hasAssignmentLookup = Boolean(options.repository || options.findAssignment);
    this.repository = options.repository ?? {
      findAssignment: options.findAssignment ?? (async () => null),
      findConflicts: options.findConflicts ?? (async () => []),
      ...(options.saveAssignment ? { saveAssignment: options.saveAssignment } : {}),
      ...(options.releaseAssignment ? { releaseAssignment: options.releaseAssignment } : {}),
    };
  }
  async assign(input: { workspaceId: string; providerInstanceId: string; outputId: string; playerId: string; actorId: string }): Promise<ProviderOutputAssignmentRecord> {
    const value = {
      workspaceId: required(input.workspaceId, 'workspaceId'),
      providerInstanceId: required(input.providerInstanceId, 'providerInstanceId'),
      outputId: required(input.outputId, 'outputId'), playerId: required(input.playerId, 'playerId'),
      actorId: required(input.actorId, 'actorId'),
    };
    const conflicts = await this.repository.findConflicts({ ...value, userId: value.actorId });
    if (conflicts.length) throw new ProviderOutputAssignmentError('This output is already assigned to another provider instance.', 'OUTPUT_ALREADY_ASSIGNED');
    if (!this.repository.saveAssignment) throw new Error('Provider output assignment persistence is not configured.');
    try { return await this.repository.saveAssignment(value); }
    catch (error) {
      if (isUniqueViolation(error)) throw new ProviderOutputAssignmentError('This output or provider instance was assigned concurrently. Refresh and try again.', 'OUTPUT_ALREADY_ASSIGNED');
      throw error;
    }
  }
  async release(input: { workspaceId: string; providerInstanceId: string; actorId?: string }): Promise<boolean> {
    const workspaceId = required(input.workspaceId, 'workspaceId');
    const providerInstanceId = required(input.providerInstanceId, 'providerInstanceId');
    if (!this.repository.releaseAssignment) throw new Error('Provider output assignment release is not configured.');
    return this.repository.releaseAssignment({ workspaceId, providerInstanceId, ...(input.actorId ? { userId: input.actorId } : {}) });
  }
  async requireAssignment(input: { workspaceId: string; providerInstanceId: string; playerId?: string; actorId?: string }): Promise<ProviderOutputAssignmentRecord> {
    const workspaceId = required(input.workspaceId, 'workspaceId');
    const providerInstanceId = required(input.providerInstanceId, 'providerInstanceId');
    const assignment = await this.repository.findAssignment({ workspaceId, providerInstanceId, ...(input.actorId ? { userId: input.actorId } : {}) });
    if (!assignment || (input.playerId && assignment.playerId !== input.playerId)) throw new ProviderOutputAssignmentError('The provider instance has no matching explicit output assignment.', 'OUTPUT_NOT_ASSIGNED');
    return assignment;
  }
  async assertCanStartPlayback(input: {
    workspaceId: string; providerInstanceId: string; playerId: string; outputId: string; actorId?: string;
    capabilities: { playback: boolean; concurrentOutput?: boolean }; concurrencyApproval: ProviderConcurrencyApproval | null;
  }): Promise<void> {
    const workspaceId = required(input.workspaceId, 'workspaceId');
    const providerInstanceId = required(input.providerInstanceId, 'providerInstanceId');
    const playerId = required(input.playerId, 'playerId'); const outputId = required(input.outputId, 'outputId');
    if (!input.capabilities.playback) throw new ProviderOutputAssignmentError('Provider does not declare playback capability.', 'INVALID_OUTPUT_ASSIGNMENT');
    if (this.hasAssignmentLookup) {
      const assignment = await this.repository.findAssignment({ workspaceId, providerInstanceId, ...(input.actorId ? { userId: input.actorId } : {}) });
      if (!assignment || assignment.outputId !== outputId || assignment.playerId !== playerId) throw new ProviderOutputAssignmentError('Playback is not permitted without a matching explicit output assignment.', 'OUTPUT_NOT_ASSIGNED');
    }
    const conflicts = await this.repository.findConflicts({ workspaceId, providerInstanceId, outputId, playerId, ...(input.actorId ? { userId: input.actorId } : {}) });
    if (!conflicts.length) return;
    const approval = input.concurrencyApproval;
    const approved = input.capabilities.concurrentOutput === true && approval?.capability === 'concurrentOutput' &&
      typeof approval.approvedBy === 'string' && Boolean(approval.approvedBy.trim() && approval.approvalId.trim()) &&
      (await this.options.verifyConcurrencyApproval?.(approval));
    if (!approved || !approval) throw new ProviderOutputAssignmentError('Another provider owns this output. Concurrent playback requires an explicit audited capability approval.', 'CONCURRENT_OUTPUT_NOT_APPROVED');
    await this.options.recordConcurrencyApprovalUse?.(approval);
  }
}
function required(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ProviderOutputAssignmentError(`${name} is required.`, 'INVALID_OUTPUT_ASSIGNMENT');
  return value.trim();
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505';
}
