import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export type RightsReportStatus = 'received' | 'investigating' | 'decision_pending' | 'escalated' | 'closed';

export interface ProviderUseGuidance {
  permittedUse: string;
  restrictions: string[];
}

export interface RightsReviewWorkflowOptions {
  guidance?: Record<string, ProviderUseGuidance>;
  createReport?: (input: Record<string, unknown>) => Promise<{ id: string }>;
  findReport?: (input: { reportId: string; workspaceId: string; actorId: string }) =>
    Promise<{ workspaceId: string; status: RightsReportStatus } | null>;
  updateStatus?: (input: {
    reportId: string; workspaceId: string; actorId: string;
    from: RightsReportStatus; status: RightsReportStatus; reason: string;
  }) => Promise<void>;
  saveDecision?: (input: Record<string, unknown>) => Promise<void>;
  appendAudit?: (event: Record<string, unknown>) => Promise<void>;
  assignReviewer?: (input: { reportId: string; workspaceId: string }) => Promise<string | null>;
  blockContent?: (input: Record<string, unknown>) => Promise<void>;
  legalReview?: {
    policyApproved?: boolean;
    proceduresApproved?: boolean;
    reviewerQualified?: boolean;
    reviewedAt?: Date | null;
  };
}

const DEFAULT_GUIDANCE: Record<string, ProviderUseGuidance> = {
  youtube: {
    permittedUse: 'Use only where the streamer has the necessary rights and the applicable provider terms permit the use.',
    restrictions: ['Do not circumvent access controls or provider restrictions.', 'Do not extract or redistribute streams.'],
  },
  spotify: {
    permittedUse: 'Use only through approved Spotify authorization and playback flows and where the applicable terms permit the use.',
    restrictions: ['Do not extract, download, rebroadcast, or redistribute Spotify streams.', 'Authorization is not a grant of music rights.'],
  },
  lyrion: {
    permittedUse: 'Use only with operator-managed libraries and sources for which the operator has the necessary rights.',
    restrictions: ['Confirm rights for each source.', 'The platform does not verify ownership of locally managed media.'],
  },
};

const ALLOWED_TRANSITIONS: Record<RightsReportStatus, RightsReportStatus[]> = {
  received: ['investigating', 'escalated'],
  investigating: ['decision_pending', 'escalated'],
  decision_pending: ['investigating', 'closed', 'escalated'],
  escalated: ['investigating', 'decision_pending', 'closed'],
  closed: [],
};

@Injectable()
export class RightsReviewWorkflowService {
  private readonly guidance: Record<string, ProviderUseGuidance>;
  private legalReview: Required<NonNullable<RightsReviewWorkflowOptions['legalReview']>>;
  private readonly reports = new Map<string, { workspaceId: string; status: RightsReportStatus }>();

  constructor(private readonly options: RightsReviewWorkflowOptions = {}) {
    this.guidance = options.guidance ?? DEFAULT_GUIDANCE;
    this.legalReview = {
      policyApproved: options.legalReview?.policyApproved ?? false,
      proceduresApproved: options.legalReview?.proceduresApproved ?? false,
      reviewerQualified: options.legalReview?.reviewerQualified ?? false,
      reviewedAt: options.legalReview?.reviewedAt ?? null,
    };
  }

  getProviderUseGuidance(providerId: string) {
    const guidance = this.guidance[providerId.trim().toLowerCase()];
    if (!guidance) throw new BadRequestException('No usage guidance is configured for this provider.');
    return {
      permittedUse: guidance.permittedUse,
      restrictions: [...guidance.restrictions],
      platformOwnerRiskAcceptanceGrantsPermission: false as const,
    };
  }

  async receiveReport(input: {
    workspaceId: string;
    claimant: { name: string; contact: string };
    content: { providerId: string; mediaId: string; url?: string };
    allegation: string;
    evidence: string[];
  }): Promise<{ id: string; status: 'received'; assignedReviewerId: string | null }> {
    if (!input.workspaceId || !input.claimant?.name?.trim() || !input.claimant?.contact?.trim() ||
        !input.content?.providerId?.trim() || !input.content?.mediaId?.trim() ||
        !input.allegation?.trim() || !Array.isArray(input.evidence)) {
      throw new BadRequestException('Rights-holder report is incomplete.');
    }
    const created = this.options.createReport
      ? await this.options.createReport(input)
      : { id: randomUUID() };
    const report = { id: created.id, workspaceId: input.workspaceId, status: 'received' as const };
    this.reports.set(report.id, { workspaceId: report.workspaceId, status: report.status });
    const assignedReviewerId = await this.options.assignReviewer?.({
      reportId: report.id, workspaceId: input.workspaceId,
    }) ?? null;
    await this.options.appendAudit?.({
      reportId: report.id, workspaceId: input.workspaceId, actorId: null,
      from: null, to: 'received', reason: 'Rights-holder report received',
    });
    return { ...report, assignedReviewerId };
  }

  async transition(input: {
    reportId: string; workspaceId: string; actorId: string; to: RightsReportStatus; reason: string;
  }): Promise<void> {
    this.assertReason(input.reason);
    const report = await this.getReport(input);
    if (!input.actorId || !ALLOWED_TRANSITIONS[report.status]?.includes(input.to)) {
      throw new BadRequestException('The requested rights-report status transition is not allowed.');
    }
    const from = report.status;
    await this.options.updateStatus?.({
      reportId: input.reportId, workspaceId: input.workspaceId, actorId: input.actorId,
      from, status: input.to, reason: input.reason.trim(),
    });
    report.status = input.to;
    await this.options.appendAudit?.({
      reportId: input.reportId, workspaceId: input.workspaceId, actorId: input.actorId,
      from, to: input.to, reason: input.reason.trim(),
    });
  }

  async escalate(input: { reportId: string; workspaceId: string; actorId: string; reason: string }): Promise<void> {
    await this.transition({ ...input, to: 'escalated' });
  }

  async recordDecision(input: {
    reportId: string; workspaceId: string; actorId: string;
    outcome: 'takedown' | 'no_action' | 'insufficient_evidence';
    contentId?: string; reason: string; preserveEvidence: boolean;
  }): Promise<void> {
    this.assertReason(input.reason);
    const report = await this.getReport(input);
    if (!input.actorId || (report.status !== 'decision_pending' && report.status !== 'escalated')) {
      throw new BadRequestException('A report must be decision-pending or escalated before a decision is recorded.');
    }
    if (input.outcome === 'takedown') {
      if (!input.contentId?.trim() || !this.options.blockContent) {
        throw new BadRequestException('A takedown requires an identified content item and blocking capability.');
      }
      await this.options.blockContent({
        workspaceId: report.workspaceId, contentId: input.contentId, actorId: input.actorId,
        reason: input.reason.trim(), preserveEvidence: input.preserveEvidence,
      });
    }
    await this.options.saveDecision?.({ ...input, workspaceId: report.workspaceId, from: report.status });
    await this.options.appendAudit?.({
      reportId: input.reportId, workspaceId: report.workspaceId, actorId: input.actorId,
      from: report.status, to: 'closed', reason: input.reason.trim(), outcome: input.outcome,
      preserveEvidence: input.preserveEvidence,
    });
    report.status = 'closed';
  }

  setLegalReview(input: {
    policyApproved: boolean; proceduresApproved: boolean; reviewerQualified: boolean; reviewedAt: Date;
  }): void {
    this.legalReview = { ...input };
  }

  async assertPublicLaunchReady(): Promise<true> {
    const review = this.legalReview;
    if (!review.policyApproved || !review.proceduresApproved || !review.reviewerQualified || !review.reviewedAt) {
      const error = new Error('Qualified legal review of policies and operational procedures is required before public launch.');
      Object.assign(error, { code: 'LEGAL_REVIEW_REQUIRED' });
      throw error;
    }
    return true;
  }

  getComplianceDisclosure() {
    return {
      guaranteesLegalCompliance: false as const,
      requiresQualifiedLegalReview: true as const,
    };
  }

  private async getReport(input: { reportId: string; workspaceId: string; actorId: string }) {
    const cached = this.reports.get(input.reportId);
    if (cached) {
      if (cached.workspaceId !== input.workspaceId) throw new BadRequestException('Rights report was not found.');
      return cached;
    }
    const persisted = await this.options.findReport?.(input);
    if (!persisted || persisted.workspaceId !== input.workspaceId) {
      throw new BadRequestException('Rights report was not found.');
    }
    this.reports.set(input.reportId, { workspaceId: persisted.workspaceId, status: persisted.status });
    return this.reports.get(input.reportId)!;
  }

  private assertReason(reason: string): void {
    if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 1000) {
      throw new BadRequestException('A documented reason between 10 and 1000 characters is required.');
    }
  }
}
