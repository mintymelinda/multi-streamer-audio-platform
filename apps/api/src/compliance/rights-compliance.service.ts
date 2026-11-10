import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { VerifiedWorkspaceId } from '@platform/contracts';

interface RightsComplianceDependencies {
  database: {
    transaction<T>(
      context: { userId?: string; verifiedWorkspaceId: VerifiedWorkspaceId },
      operation: (client: PoolClient) => Promise<T>,
    ): Promise<T>;
  };
  outbox: {
    append(
      client: PoolClient,
      event: {
        workspaceId: VerifiedWorkspaceId;
        eventType: string;
        aggregateType: string;
        aggregateId: string;
        idempotencyKey: string;
        payload: Record<string, unknown>;
      },
    ): Promise<string>;
  };
  policy?: {
    repeatInfringerThreshold?: number;
    requireRightsAttestation?: boolean;
    currentVersion?: string;
  };
}

@Injectable()
export class RightsComplianceService {
  private readonly policy: Required<NonNullable<RightsComplianceDependencies['policy']>>;

  constructor(private readonly dependencies: RightsComplianceDependencies) {
    this.policy = {
      repeatInfringerThreshold: dependencies.policy?.repeatInfringerThreshold ?? 3,
      requireRightsAttestation: dependencies.policy?.requireRightsAttestation ?? true,
      currentVersion: dependencies.policy?.currentVersion ?? '2026-11',
    };
    if (!Number.isInteger(this.policy.repeatInfringerThreshold) || this.policy.repeatInfringerThreshold < 1) {
      throw new TypeError('repeatInfringerThreshold must be a positive integer.');
    }
  }

  async assertWorkspacePlaybackEligible(input: { workspaceId: string; actorId: string }): Promise<void> {
    if (!input.workspaceId || !input.actorId) throw new BadRequestException('Workspace and actor are required.');
    if (!this.policy.requireRightsAttestation) return;
    const accepted = await this.dependencies.database.transaction(
      { userId: input.actorId, verifiedWorkspaceId: input.workspaceId as VerifiedWorkspaceId },
      async (client) => {
        const result = await client.query(
          `SELECT 1 FROM workspace_rights_attestations
            WHERE workspace_id = $1 AND policy_version = $2 AND accepted_at IS NOT NULL
            LIMIT 1`,
          [input.workspaceId, this.policy.currentVersion],
        );
        return result.rowCount > 0;
      },
    );
    if (!accepted) {
      const error = new ForbiddenException('The workspace must accept the current rights and use policy before playback.');
      Object.assign(error, { code: 'RIGHTS_ATTESTATION_REQUIRED' });
      throw error;
    }
  }

  async recordAttestation(input: {
    workspaceId: string;
    actorId: string;
    policyVersion: string;
    accepted: boolean;
  }): Promise<{ accepted: true; policyVersion: string }> {
    if (!input.workspaceId || !input.actorId || !input.policyVersion?.trim()) {
      throw new BadRequestException('Workspace, actor, and policy version are required.');
    }
    if (input.policyVersion !== this.policy.currentVersion || input.accepted !== true) {
      throw new BadRequestException('The current rights and use policy must be explicitly accepted.');
    }
    await this.dependencies.database.transaction(
      { userId: input.actorId, verifiedWorkspaceId: input.workspaceId as VerifiedWorkspaceId },
      async (client) => {
        await client.query(
          `INSERT INTO workspace_rights_attestations
             (workspace_id, policy_version, accepted_by_user_id, accepted_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (workspace_id, policy_version)
           DO UPDATE SET accepted_by_user_id = EXCLUDED.accepted_by_user_id,
                         accepted_at = EXCLUDED.accepted_at`,
          [input.workspaceId, input.policyVersion, input.actorId],
        );
        await this.appendEvent(client, input.workspaceId, 'rights.attestation.accepted',
          'workspace', input.workspaceId, `rights-attestation:${input.policyVersion}`,
          { policyVersion: input.policyVersion, actorId: input.actorId });
      },
    );
    return { accepted: true, policyVersion: input.policyVersion };
  }

  async submitRightsHolderReport(input: {
    workspaceId: string;
    claimant: { name: string; contact: string };
    content: { providerId: string; mediaId: string; url?: string };
    allegation: string;
    evidence: string[];
  }): Promise<{ id: string; status: 'received' }> {
    const name = input.claimant?.name?.trim();
    const contact = input.claimant?.contact?.trim();
    const providerId = input.content?.providerId?.trim().toLowerCase();
    const mediaId = input.content?.mediaId?.trim();
    const allegation = input.allegation?.trim();
    const evidence = Array.isArray(input.evidence) ? input.evidence.filter((item) => typeof item === 'string' && item.trim()) : [];
    if (!input.workspaceId || !name || name.length > 200 || !contact || contact.length > 320 ||
        !providerId || providerId.length > 80 || !mediaId || mediaId.length > 300 ||
        !allegation || allegation.length > 5000 || evidence.length > 20) {
      throw new BadRequestException('Rights-holder report is incomplete or invalid.');
    }
    if (input.content.url && !isHttpUrl(input.content.url)) throw new BadRequestException('Content URL must use HTTP or HTTPS.');
    if (evidence.some((url) => !isHttpUrl(url))) throw new BadRequestException('Evidence URLs must use HTTP or HTTPS.');
    return this.dependencies.database.transaction(
      { verifiedWorkspaceId: input.workspaceId as VerifiedWorkspaceId },
      async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO rights_holder_reports
             (workspace_id, claimant_name, claimant_contact, provider_id, media_id, content_url, allegation, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           RETURNING id`,
          [input.workspaceId, name, contact, providerId, mediaId, input.content.url ?? null, allegation, JSON.stringify(evidence)],
        );
        const id = inserted.rows[0]?.id;
        if (!id) throw new Error('Rights-holder report could not be recorded.');
        await this.appendEvent(client, input.workspaceId, 'rights.report.received',
          'rights_report', id, `rights-report-received:${id}`,
          { reportId: id, providerId, mediaId });
        return { id, status: 'received' };
      },
    );
  }

  async blockContent(input: {
    workspaceId: string;
    contentId: string;
    actorId: string;
    reason: string;
    preserveEvidence?: boolean;
  }): Promise<void> {
    this.assertReason(input.reason);
    if (!input.workspaceId || !input.contentId?.trim() || !input.actorId) {
      throw new BadRequestException('Workspace, content, and actor are required.');
    }
    await this.dependencies.database.transaction(
      { userId: input.actorId, verifiedWorkspaceId: input.workspaceId as VerifiedWorkspaceId },
      async (client) => {
        await client.query(
          `INSERT INTO rights_content_blocks
             (workspace_id, content_id, blocked_by_user_id, reason, preserve_evidence)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, content_id)
           DO UPDATE SET blocked_by_user_id = EXCLUDED.blocked_by_user_id,
                         reason = EXCLUDED.reason, preserve_evidence = EXCLUDED.preserve_evidence,
                         blocked_at = now()`,
          [input.workspaceId, input.contentId, input.actorId, input.reason.trim(), input.preserveEvidence ?? true],
        );
        await this.appendEvent(client, input.workspaceId, 'rights.content.blocked',
          'content', input.contentId, `rights-content-blocked:${input.contentId}`,
          { contentId: input.contentId, actorId: input.actorId, reason: input.reason.trim(),
            preserveEvidence: input.preserveEvidence ?? true });
      },
    );
  }

  async disableProviderPath(input: {
    workspaceId: string;
    providerId: string;
    actorId: string;
    reason: string;
  }): Promise<void> {
    this.assertReason(input.reason);
    const providerId = input.providerId?.trim().toLowerCase();
    if (!input.workspaceId || !providerId || !input.actorId) throw new BadRequestException('Workspace, provider, and actor are required.');
    await this.dependencies.database.transaction(
      { userId: input.actorId, verifiedWorkspaceId: input.workspaceId as VerifiedWorkspaceId },
      async (client) => {
        await client.query(
          `INSERT INTO workspace_provider_path_restrictions
             (workspace_id, provider_id, disabled_by_user_id, reason, disabled_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (workspace_id, provider_id)
           DO UPDATE SET disabled_by_user_id = EXCLUDED.disabled_by_user_id,
                         reason = EXCLUDED.reason, disabled_at = now()`,
          [input.workspaceId, providerId, input.actorId, input.reason.trim()],
        );
        await this.appendEvent(client, input.workspaceId, 'workspace.provider_path.disabled',
          'provider_path', providerId, `provider-path-disabled:${providerId}`,
          { providerId, actorId: input.actorId, reason: input.reason.trim() });
      },
    );
  }

  async suspendWorkspace(input: { workspaceId: string; actorId: string; reason: string }): Promise<void> {
    this.assertReason(input.reason);
    if (!input.workspaceId || !input.actorId) throw new BadRequestException('Workspace and actor are required.');
    await this.dependencies.database.transaction(
      { userId: input.actorId, verifiedWorkspaceId: input.workspaceId as VerifiedWorkspaceId },
      async (client) => {
        await client.query(
          `UPDATE workspaces SET status = 'suspended', restriction_reason = $2, updated_at = now()
            WHERE id = $1`,
          [input.workspaceId, input.reason.trim()],
        );
        await this.appendEvent(client, input.workspaceId, 'workspace.suspended',
          'workspace', input.workspaceId, `workspace-suspended:${input.workspaceId}`,
          { actorId: input.actorId, reason: input.reason.trim() });
      },
    );
  }

  evaluateRepeatInfringer(input: { workspaceId: string; substantiatedCaseCount: number }) {
    if (!input.workspaceId || !Number.isInteger(input.substantiatedCaseCount) || input.substantiatedCaseCount < 0) {
      throw new BadRequestException('A workspace and non-negative substantiated case count are required.');
    }
    return {
      actionRequired: input.substantiatedCaseCount >= this.policy.repeatInfringerThreshold,
      threshold: this.policy.repeatInfringerThreshold,
    };
  }

  private assertReason(reason: string): void {
    if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 1000) {
      throw new BadRequestException('A documented reason between 10 and 1000 characters is required.');
    }
  }

  private appendEvent(
    client: PoolClient, workspaceId: string, eventType: string, aggregateType: string,
    aggregateId: string, idempotencyKey: string, payload: Record<string, unknown>,
  ) {
    return this.dependencies.outbox.append(client, {
      workspaceId: workspaceId as VerifiedWorkspaceId, eventType, aggregateType, aggregateId, idempotencyKey, payload,
    });
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
