import { Injectable } from '@nestjs/common';
import type { VerifiedWorkspaceId } from '@platform/contracts';
import { DatabaseService } from '../database/database.service.js';
import { ProviderExecutionQueueService } from '../providers/provider-execution-queue.service.js';
import { ProviderRoutingError } from '../providers/provider-routing.service.js';

export type QueueDispatchResult =
  | { status: 'dispatched'; requestId: string }
  | { status: 'already_scheduled'; requestId: string }
  | { status: 'empty' }
  | { status: 'blocked'; requestId: string; reason: string };

type QueueCandidate = {
  id: string;
  source: 'twitch_reward' | 'dashboard' | 'moderator' | 'api';
  submitted_by_user_id: string | null;
  owner_user_id: string;
};

@Injectable()
export class QueueManagerService {
  constructor(
    private readonly database: DatabaseService,
    private readonly executionQueue: ProviderExecutionQueueService,
  ) {}

  async dispatchNext(input: {
    workspaceId: string;
    actorId: string;
  }): Promise<QueueDispatchResult> {
    const workspaceId = required(input.workspaceId, 'workspaceId');
    const triggerActorId = required(input.actorId, 'actorId');

    return this.database.transaction(
      {
        userId: triggerActorId,
        verifiedWorkspaceId: workspaceId as VerifiedWorkspaceId,
      },
      async (client) => {
        await client.query(
          'INSERT INTO workspace_request_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [workspaceId],
        );
        await client.query(
          'SELECT workspace_id FROM workspace_request_settings WHERE workspace_id = $1 FOR UPDATE',
          [workspaceId],
        );

        const selected = await client.query<QueueCandidate>(
          `SELECT r.id, r.source, r.submitted_by_user_id, w.owner_user_id
             FROM logical_queue_entries q
             JOIN media_requests r
               ON r.workspace_id = q.workspace_id AND r.id = q.request_id
             JOIN workspaces w ON w.id = r.workspace_id
            WHERE q.workspace_id = $1 AND r.status = 'queued'
            ORDER BY q.priority DESC, q.sequence ASC
            LIMIT 1`,
          [workspaceId],
        );
        const candidate = selected.rows[0];
        if (!candidate) return { status: 'empty' };

        const actorId =
          candidate.source === 'twitch_reward'
            ? candidate.owner_user_id
            : candidate.submitted_by_user_id;
        if (!actorId) {
          return {
            status: 'blocked',
            requestId: candidate.id,
            reason: 'request_actor_unavailable',
          };
        }

        const membership = await client.query(
          `SELECT 1 FROM workspace_memberships m
             JOIN platform_users u ON u.id = m.user_id
            WHERE m.workspace_id = $1 AND m.user_id = $2
              AND m.status = 'active' AND u.status = 'active'`,
          [workspaceId, actorId],
        );
        if ((membership.rowCount ?? 0) !== 1) {
          return {
            status: 'blocked',
            requestId: candidate.id,
            reason: 'request_actor_not_active',
          };
        }

        const existing = await client.query<{ state: string }>(
          `SELECT state FROM provider_execution_states
            WHERE workspace_id = $1 AND request_id = $2
              AND state <> 'retry_wait'
            ORDER BY updated_at DESC
            LIMIT 1`,
          [workspaceId, candidate.id],
        );
        if (existing.rows[0]) {
          return { status: 'already_scheduled', requestId: candidate.id };
        }

        try {
          await this.executionQueue.enqueue({
            workspaceId,
            requestId: candidate.id,
            actorId,
          });
          return { status: 'dispatched', requestId: candidate.id };
        } catch (error) {
          if (
            error instanceof ProviderRoutingError &&
            (error.code === 'OUTPUT_NOT_ASSIGNED' || error.code === 'NO_ELIGIBLE_PROVIDER')
          ) {
            return {
              status: 'blocked',
              requestId: candidate.id,
              reason: error.code.toLowerCase(),
            };
          }
          throw error;
        }
      },
    );
  }
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} is required.`);
  }
  return value.trim();
}
