import { randomUUID } from 'node:crypto';
import type { VerifiedWorkspaceId } from '@platform/contracts';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedUser, WorkspaceRequestContext } from '../identity/http.types.js';
import { OutboxService } from './outbox.service.js';

interface FailedOutboxEvent {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  attempt_count: number;
  last_error_code: string | null;
  occurred_at: Date;
}

@Injectable()
export class OutboxRecoveryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async listFailed(workspace: WorkspaceRequestContext, actor: AuthenticatedUser) {
    const result = await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      (client) =>
        client.query<FailedOutboxEvent>(
          `SELECT id, event_type, aggregate_type, aggregate_id,
                  attempt_count, last_error_code, occurred_at
             FROM outbox_events
            WHERE workspace_id = $1 AND dispatch_status = 'failed'
            ORDER BY occurred_at DESC, id DESC LIMIT 100`,
          [workspace.id],
        ),
    );
    return result.rows;
  }

  async retry(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    eventId: string,
    reason: string,
  ) {
    return this.changeFailedEvent(workspace, actor, eventId, reason, 'retry');
  }

  async dismiss(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    eventId: string,
    reason: string,
  ) {
    return this.changeFailedEvent(workspace, actor, eventId, reason, 'dismiss');
  }

  private async changeFailedEvent(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    eventId: string,
    reason: string,
    action: 'retry' | 'dismiss',
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) {
      throw new NotFoundException('Outbox event not found.');
    }
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 10 || normalizedReason.length > 500) {
      throw new ConflictException('A recovery reason between 10 and 500 characters is required.');
    }

    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const result = await client.query<FailedOutboxEvent>(
          `SELECT id, event_type, aggregate_type, aggregate_id,
                  attempt_count, last_error_code, occurred_at
             FROM outbox_events
            WHERE workspace_id = $1 AND id = $2 AND dispatch_status = 'failed'
            FOR UPDATE`,
          [workspace.id, eventId],
        );
        const event = result.rows[0];
        if (!event) {
          throw new ConflictException('Only failed outbox events can be recovered.');
        }

        const status = action === 'retry' ? 'pending' : 'dismissed';
        const updated = await client.query(
          `UPDATE outbox_events
              SET dispatch_status = $3,
                  attempt_count = CASE WHEN $3 = 'pending' THEN 0 ELSE attempt_count END,
                  available_at = now(),
                  published_at = CASE WHEN $3 = 'dismissed' THEN now() ELSE NULL END,
                  locked_at = NULL,
                  lock_token = NULL,
                  last_error_code = NULL
            WHERE workspace_id = $1 AND id = $2 AND dispatch_status = 'failed'`,
          [workspace.id, eventId, status],
        );
        if (updated.rowCount !== 1) {
          throw new ConflictException('Outbox event recovery raced another action.');
        }
        await client.query(
          `INSERT INTO audit_events
            (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1,$2,$3,'outbox_event',$4,$5::jsonb)`,
          [
            workspace.id,
            actor.id,
            `outbox.delivery.${action}`,
            eventId,
            JSON.stringify({ reason: normalizedReason, previousStatus: 'failed' }),
          ],
        );
        await this.outbox.append(client, {
          workspaceId: workspace.id as VerifiedWorkspaceId,
          eventType: `outbox.delivery.${action}`,
          aggregateType: 'outbox_event',
          aggregateId: eventId,
          idempotencyKey: `outbox.delivery.${action}:${eventId}:${randomUUID()}`,
          payload: { eventType: event.event_type, reason: normalizedReason },
        });
        return { eventId, status };
      },
    );
  }
}
