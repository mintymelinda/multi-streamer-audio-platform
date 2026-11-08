import { randomUUID } from 'node:crypto';
import type { VerifiedWorkspaceId } from '@platform/contracts';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedUser, WorkspaceRequestContext } from '../identity/http.types.js';
import { OutboxService } from '../outbox/outbox.service.js';
import {
  assertRequestTransition,
  classifyModeration,
  type RequestStatus,
} from './request-state-machine.js';

type RequestSource = 'twitch_reward' | 'dashboard' | 'moderator' | 'api';
type IntakeInput = {
  workspace: WorkspaceRequestContext;
  actor?: AuthenticatedUser | undefined;
  source: RequestSource;
  title: string;
  artist?: string | undefined;
  mediaUrl?: string | undefined;
  provider?: string | undefined;
  mediaId?: string | undefined;
  requesterTwitchUserId?: string | undefined;
  requesterDisplayName?: string | undefined;
  sourceEventId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

@Injectable()
export class RequestsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async submit(input: IntakeInput) {
    const title = input.title.trim();
    if (!title || title.length > 500) {
      throw new ConflictException('A valid media title is required.');
    }
    if (input.mediaUrl && !/^https?:\/\//i.test(input.mediaUrl)) {
      throw new ConflictException('Media URL must use HTTP or HTTPS.');
    }
    return this.database.transaction(
      {
        ...(input.actor ? { userId: input.actor.id } : {}),
        verifiedWorkspaceId: input.workspace.id,
      },
      async (client) => {
        await client.query(
          'INSERT INTO workspace_request_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [input.workspace.id],
        );
        const settings = await client.query<{
          moderation_mode: 'automatic' | 'manual' | 'filtered';
          queue_limit: number;
          per_user_limit: number;
          per_source_limit: number;
          hold_terms: string[];
          reject_terms: string[];
        }>(
          'SELECT moderation_mode, queue_limit, per_user_limit, per_source_limit, hold_terms, reject_terms FROM workspace_request_settings WHERE workspace_id = $1 FOR UPDATE',
          [input.workspace.id],
        );
        const policy = settings.rows[0];
        if (!policy) throw new Error('Workspace request settings could not be initialized.');

        const requesterId = input.requesterTwitchUserId ?? input.actor?.twitchUserId;
        if (input.sourceEventId) {
          const duplicate = await client.query(
            'SELECT * FROM media_requests WHERE workspace_id = $1 AND source = $2 AND source_event_id = $3',
            [input.workspace.id, input.source, input.sourceEventId],
          );
          if (duplicate.rows[0]) {
            const existing = duplicate.rows[0] as {
              submitted_by_user_id: string | null;
              requester_twitch_user_id: string | null;
            };
            const sameSubmitter =
              (input.actor?.id ?? null) === existing.submitted_by_user_id &&
              (requesterId ?? null) === existing.requester_twitch_user_id;
            if (!sameSubmitter) {
              throw new ConflictException('This idempotency key has already been used.');
            }
            return duplicate.rows[0];
          }
        }

        const active =
          "status IN ('submitted','pending','held','approved','queued','resolving','ready','playing')";
        const queueCount = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM media_requests WHERE workspace_id = $1 AND ${active}`,
          [input.workspace.id],
        );
        if (Number(queueCount.rows[0]?.count ?? 0) >= policy.queue_limit) {
          throw new ConflictException('The workspace request limit has been reached.');
        }
        if (requesterId) {
          const userCount = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM media_requests WHERE workspace_id = $1 AND requester_twitch_user_id = $2 AND ${active}`,
            [input.workspace.id, requesterId],
          );
          if (Number(userCount.rows[0]?.count ?? 0) >= policy.per_user_limit) {
            throw new ConflictException('This requester has reached the active request limit.');
          }
        }
        const sourceCount = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM media_requests WHERE workspace_id = $1 AND source = $2 AND ${active}`,
          [input.workspace.id, input.source],
        );
        if (Number(sourceCount.rows[0]?.count ?? 0) >= policy.per_source_limit) {
          throw new ConflictException('This request source has reached its active request limit.');
        }

        const decision = classifyModeration(
          policy.moderation_mode,
          title,
          input.artist ?? null,
          policy.hold_terms,
          policy.reject_terms,
        );
        const inserted = await client.query<{ id: string; status: RequestStatus }>(
          `INSERT INTO media_requests
            (workspace_id, source, source_event_id, submitted_by_user_id, requester_twitch_user_id,
             requester_display_name, provider, media_id, media_url, title, artist, metadata, status, status_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'submitted',NULL)
           RETURNING id, status`,
          [
            input.workspace.id,
            input.source,
            input.sourceEventId ?? null,
            input.actor?.id ?? null,
            requesterId ?? null,
            input.requesterDisplayName ?? null,
            input.provider ?? null,
            input.mediaId ?? null,
            input.mediaUrl ?? null,
            title,
            input.artist ?? null,
            JSON.stringify(input.metadata ?? {}),
          ],
        );
        const created = inserted.rows[0];
        if (!created) throw new Error('Request insert did not return a row.');
        await this.recordTransition(
          client,
          input.workspace.id,
          created.id,
          null,
          'submitted',
          input.actor?.id,
          input.source === 'twitch_reward' ? 'twitch' : 'user',
        );
        await client.query(
          'UPDATE media_requests SET status = $1, status_reason = $2, updated_at = now() WHERE id = $3',
          [
            decision,
            decision === 'rejected' ? 'Matched a configured reject filter.' : null,
            created.id,
          ],
        );
        await this.recordTransition(
          client,
          input.workspace.id,
          created.id,
          'submitted',
          decision,
          input.actor?.id,
          'system',
          decision === 'rejected' ? 'Matched a configured reject filter.' : undefined,
        );
        let finalStatus: RequestStatus = decision;
        if (decision === 'approved') {
          finalStatus = 'queued';
          await this.enqueue(client, input.workspace.id, created.id, 0, input.actor?.id);
          await client.query(
            "UPDATE media_requests SET status = 'queued', updated_at = now() WHERE id = $1",
            [created.id],
          );
          await this.recordTransition(
            client,
            input.workspace.id,
            created.id,
            'approved',
            'queued',
            input.actor?.id,
            'system',
          );
        }
        await this.outbox.append(client, {
          workspaceId: input.workspace.id as VerifiedWorkspaceId,
          eventType: 'request.created',
          aggregateType: 'media_request',
          aggregateId: created.id,
          idempotencyKey: `request.created:${created.id}`,
          payload: { requestId: created.id, status: finalStatus, source: input.source },
        });
        const result = await client.query('SELECT * FROM media_requests WHERE id = $1', [
          created.id,
        ]);
        return result.rows[0];
      },
    );
  }

  async getSettings(workspace: WorkspaceRequestContext, userId: string) {
    return this.database.transaction(
      { userId, verifiedWorkspaceId: workspace.id },
      async (client) => {
        await client.query(
          'INSERT INTO workspace_request_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [workspace.id],
        );
        const result = await client.query(
          'SELECT moderation_mode, queue_limit, per_user_limit, per_source_limit, hold_terms, reject_terms, updated_at FROM workspace_request_settings WHERE workspace_id = $1',
          [workspace.id],
        );
        return result.rows[0];
      },
    );
  }

  async updateSettings(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    settings: {
      moderationMode: 'automatic' | 'manual' | 'filtered';
      queueLimit: number;
      perUserLimit: number;
      perSourceLimit: number;
      holdTerms: string[];
      rejectTerms: string[];
    },
  ) {
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        await client.query(
          'INSERT INTO workspace_request_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [workspace.id],
        );
        const result = await client.query(
          `UPDATE workspace_request_settings
              SET moderation_mode = $2, queue_limit = $3, per_user_limit = $4,
                  per_source_limit = $5, hold_terms = $6::text[], reject_terms = $7::text[],
                  updated_at = now()
            WHERE workspace_id = $1
            RETURNING moderation_mode, queue_limit, per_user_limit, per_source_limit,
                      hold_terms, reject_terms, updated_at`,
          [
            workspace.id,
            settings.moderationMode,
            settings.queueLimit,
            settings.perUserLimit,
            settings.perSourceLimit,
            settings.holdTerms,
            settings.rejectTerms,
          ],
        );
        const updated = result.rows[0];
        if (!updated) throw new Error('Workspace request settings could not be updated.');
        await this.outbox.append(client, {
          workspaceId: workspace.id as VerifiedWorkspaceId,
          eventType: 'request.settings.updated',
          aggregateType: 'workspace_request_settings',
          aggregateId: workspace.id,
          idempotencyKey: `request.settings.updated:${workspace.id}:${randomUUID()}`,
          payload: { workspaceId: workspace.id, actorUserId: actor.id },
        });
        return updated;
      },
    );
  }

  async list(workspace: WorkspaceRequestContext, userId: string) {
    return this.database.transaction(
      { userId, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const result = await client.query(
          'SELECT * FROM media_requests WHERE workspace_id = $1 ORDER BY submitted_at DESC LIMIT 100',
          [workspace.id],
        );
        return result.rows;
      },
    );
  }

  async queue(workspace: WorkspaceRequestContext, userId: string) {
    return this.database.transaction(
      { userId, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const result = await client.query(
          `SELECT r.*, q.priority AS queue_priority, q.sequence AS queue_sequence, q.inserted_at
             FROM logical_queue_entries q
             JOIN media_requests r ON r.id = q.request_id AND r.workspace_id = q.workspace_id
            WHERE q.workspace_id = $1 AND r.status = 'queued'
            ORDER BY q.priority DESC, q.sequence ASC`,
          [workspace.id],
        );
        return result.rows;
      },
    );
  }

  async reorderQueue(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    requestIds: string[],
  ) {
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        await this.lockQueueSettings(client, workspace.id);
        const currentIds = await this.getQueuedRequestIds(client, workspace.id);
        this.assertQueuePermutation(currentIds, requestIds);
        await this.rewriteQueueOrder(client, workspace.id, requestIds);
        await this.outbox.append(client, {
          workspaceId: workspace.id as VerifiedWorkspaceId,
          eventType: 'queue.reordered',
          aggregateType: 'logical_queue',
          aggregateId: workspace.id,
          idempotencyKey: `queue.reordered:${workspace.id}:${randomUUID()}`,
          payload: { requestIds, actorUserId: actor.id },
        });
        return { requestIds };
      },
    );
  }

  async promoteQueueRequest(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    requestId: string,
  ) {
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        await this.lockQueueSettings(client, workspace.id);
        const currentIds = await this.getQueuedRequestIds(client, workspace.id);
        if (!currentIds.includes(requestId)) {
          throw new NotFoundException('Queued request not found.');
        }
        const nextIds = [requestId, ...currentIds.filter((id) => id !== requestId)];
        await this.rewriteQueueOrder(client, workspace.id, nextIds);
        await this.outbox.append(client, {
          workspaceId: workspace.id as VerifiedWorkspaceId,
          eventType: 'queue.request.promoted',
          aggregateType: 'media_request',
          aggregateId: requestId,
          idempotencyKey: `queue.request.promoted:${requestId}:${randomUUID()}`,
          payload: { requestId, actorUserId: actor.id },
        });
        return { requestId, position: 1 };
      },
    );
  }

  async specialInsertQueueRequest(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    requestId: string,
    position: 'front' | 'back',
  ) {
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        await this.lockQueueSettings(client, workspace.id);
        const currentIds = await this.getQueuedRequestIds(client, workspace.id);
        if (!currentIds.includes(requestId)) {
          throw new NotFoundException('Queued request not found.');
        }
        const remaining = currentIds.filter((id) => id !== requestId);
        const nextIds = position === 'front' ? [requestId, ...remaining] : [...remaining, requestId];
        await this.rewriteQueueOrder(client, workspace.id, nextIds);
        await this.outbox.append(client, {
          workspaceId: workspace.id as VerifiedWorkspaceId,
          eventType: 'queue.request.special_inserted',
          aggregateType: 'media_request',
          aggregateId: requestId,
          idempotencyKey: `queue.request.special_inserted:${requestId}:${randomUUID()}`,
          payload: { requestId, position, actorUserId: actor.id },
        });
        return { requestId, position };
      },
    );
  }

  private async lockQueueSettings(client: PoolClient, workspaceId: VerifiedWorkspaceId) {
    await client.query(
      'INSERT INTO workspace_request_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [workspaceId],
    );
    await client.query(
      'SELECT workspace_id FROM workspace_request_settings WHERE workspace_id = $1 FOR UPDATE',
      [workspaceId],
    );
  }

  private async getQueuedRequestIds(client: PoolClient, workspaceId: VerifiedWorkspaceId) {
    const result = await client.query<{ request_id: string }>(
      `SELECT q.request_id
         FROM logical_queue_entries q
         JOIN media_requests r ON r.id = q.request_id AND r.workspace_id = q.workspace_id
        WHERE q.workspace_id = $1 AND r.status = 'queued'
        ORDER BY q.priority DESC, q.sequence ASC
        FOR UPDATE OF q`,
      [workspaceId],
    );
    return result.rows.map((row) => row.request_id);
  }

  private assertQueuePermutation(currentIds: string[], requestedIds: string[]) {
    if (
      requestedIds.length !== currentIds.length ||
      new Set(requestedIds).size !== requestedIds.length ||
      requestedIds.some((id) => !currentIds.includes(id))
    ) {
      throw new ConflictException(
        'Queue order must contain every currently queued request exactly once.',
      );
    }
  }

  private async rewriteQueueOrder(
    client: PoolClient,
    workspaceId: VerifiedWorkspaceId,
    requestIds: string[],
  ) {
    await client.query(
      `DELETE FROM logical_queue_entries q
        USING media_requests r
        WHERE q.workspace_id = $1
          AND r.workspace_id = q.workspace_id
          AND r.id = q.request_id
          AND r.status <> 'queued'`,
      [workspaceId],
    );
    const bounds = await client.query<{ offset: string }>(
      'SELECT (COALESCE(MAX(sequence), 0) + count(*) + 1)::text AS offset FROM logical_queue_entries WHERE workspace_id = $1',
      [workspaceId],
    );
    const offset = BigInt(bounds.rows[0]?.offset ?? '1');
    await client.query(
      'UPDATE logical_queue_entries SET sequence = sequence + $2::bigint WHERE workspace_id = $1',
      [workspaceId, offset.toString()],
    );
    for (const [index, requestId] of requestIds.entries()) {
      await client.query(
        'UPDATE logical_queue_entries SET priority = 0, sequence = $3 WHERE workspace_id = $1 AND request_id = $2',
        [workspaceId, requestId, index + 1],
      );
      await client.query(
        'UPDATE media_requests SET priority = 0 WHERE workspace_id = $1 AND id = $2',
        [workspaceId, requestId],
      );
    }
    await client.query(
      'INSERT INTO workspace_queue_counters (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [workspaceId],
    );
    await client.query(
      'UPDATE workspace_queue_counters SET next_sequence = $2 WHERE workspace_id = $1',
      [workspaceId, requestIds.length + 1],
    );
  }

  async moderate(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    requestId: string,
    action: 'approve' | 'reject' | 'hold',
    reason?: string,
  ) {
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        await client.query(
          'INSERT INTO workspace_request_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [workspace.id],
        );
        const policy = await client.query<{ queue_limit: number }>(
          'SELECT queue_limit FROM workspace_request_settings WHERE workspace_id = $1 FOR UPDATE',
          [workspace.id],
        );
        const current = await this.getRequestForUpdate(client, workspace.id, requestId);
        const target: RequestStatus =
          action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'held';
        assertRequestTransition(current.status, target);
        if (target === 'approved') {
          const queued = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM media_requests WHERE workspace_id = $1 AND status IN ('queued','resolving','ready','playing')",
            [workspace.id],
          );
          if (Number(queued.rows[0]?.count ?? 0) >= (policy.rows[0]?.queue_limit ?? 50)) {
            throw new ConflictException('The playable queue is full; the request remains pending.');
          }
        }
        await client.query(
          'UPDATE media_requests SET status = $1, status_reason = $2, updated_at = now() WHERE id = $3',
          [target, reason ?? null, requestId],
        );
        await this.recordTransition(
          client,
          workspace.id,
          requestId,
          current.status,
          target,
          actor.id,
          'moderator',
          reason,
        );
        if (target === 'approved') {
          await this.enqueue(client, workspace.id, requestId, current.priority, actor.id);
          await client.query(
            "UPDATE media_requests SET status = 'queued', updated_at = now() WHERE id = $1",
            [requestId],
          );
          await this.recordTransition(
            client,
            workspace.id,
            requestId,
            'approved',
            'queued',
            actor.id,
            'system',
          );
        }
        await this.outbox.append(client, {
          workspaceId: workspace.id as VerifiedWorkspaceId,
          eventType: 'request.moderated',
          aggregateType: 'media_request',
          aggregateId: requestId,
          idempotencyKey: `request.moderated:${requestId}:${current.status}:${target}`,
          payload: { requestId, status: target, actorUserId: actor.id, reason: reason ?? null },
        });
        const updated = await client.query('SELECT * FROM media_requests WHERE id = $1', [
          requestId,
        ]);
        return updated.rows[0];
      },
    );
  }

  async cancel(workspace: WorkspaceRequestContext, actor: AuthenticatedUser, requestId: string) {
    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const current = await this.getRequestForUpdate(client, workspace.id, requestId);
        if (
          current.submitted_by_user_id !== actor.id &&
          current.requester_twitch_user_id !== actor.twitchUserId
        ) {
          throw new NotFoundException('Request not found.');
        }
        assertRequestTransition(current.status, 'cancelled');
        await client.query(
          "UPDATE media_requests SET status = 'cancelled', updated_at = now() WHERE id = $1",
          [requestId],
        );
        await client.query('DELETE FROM logical_queue_entries WHERE request_id = $1', [requestId]);
        await this.recordTransition(
          client,
          workspace.id,
          requestId,
          current.status,
          'cancelled',
          actor.id,
          'user',
        );
        await this.outbox.append(client, {
          workspaceId: workspace.id as VerifiedWorkspaceId,
          eventType: 'request.cancelled',
          aggregateType: 'media_request',
          aggregateId: requestId,
          idempotencyKey: `request.cancelled:${requestId}:${current.status}`,
          payload: { requestId, actorUserId: actor.id },
        });
        return { id: requestId, status: 'cancelled' };
      },
    );
  }

  private async getRequestForUpdate(
    client: PoolClient,
    workspaceId: VerifiedWorkspaceId,
    requestId: string,
  ) {
    const result = await client.query<{
      id: string;
      status: RequestStatus;
      priority: number;
      submitted_by_user_id: string | null;
      requester_twitch_user_id: string | null;
    }>(
      'SELECT id, status, priority, submitted_by_user_id, requester_twitch_user_id FROM media_requests WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
      [workspaceId, requestId],
    );
    const request = result.rows[0];
    if (!request) throw new NotFoundException('Request not found.');
    return request;
  }

  private async enqueue(
    client: PoolClient,
    workspaceId: VerifiedWorkspaceId,
    requestId: string,
    priority: number,
    actorId?: string,
  ) {
    await client.query(
      'INSERT INTO workspace_queue_counters (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [workspaceId],
    );
    const counter = await client.query<{ next_sequence: string }>(
      'UPDATE workspace_queue_counters SET next_sequence = next_sequence + 1 WHERE workspace_id = $1 RETURNING next_sequence - 1 AS next_sequence',
      [workspaceId],
    );
    const sequence = counter.rows[0]?.next_sequence;
    if (!sequence) throw new Error('Queue sequence could not be allocated.');
    await client.query(
      'INSERT INTO logical_queue_entries (workspace_id, request_id, priority, sequence, inserted_by_user_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (request_id) DO NOTHING',
      [workspaceId, requestId, priority, sequence, actorId ?? null],
    );
  }

  private async recordTransition(
    client: PoolClient,
    workspaceId: VerifiedWorkspaceId,
    requestId: string,
    from: RequestStatus | null,
    to: RequestStatus,
    actorId?: string,
    actorType: 'user' | 'moderator' | 'system' | 'twitch' = 'system',
    reason?: string,
  ) {
    await client.query(
      'INSERT INTO request_state_history (workspace_id, request_id, from_status, to_status, actor_user_id, actor_type, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [workspaceId, requestId, from, to, actorId ?? null, actorType, reason ?? null],
    );
  }
}
