import type { VerifiedWorkspaceId } from '@platform/contracts';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedUser, WorkspaceRequestContext } from '../identity/http.types.js';
import { OutboxService } from '../outbox/outbox.service.js';

interface FailedDelivery {
  id: string;
  message_id: string;
  message_type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  received_at: Date;
}

@Injectable()
export class EventSubRecoveryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async listFailed(workspace: WorkspaceRequestContext, actor: AuthenticatedUser) {
    const result = await this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      (client) =>
        client.query<FailedDelivery>(
          `SELECT id, message_id, message_type, status, attempts, last_error, received_at
             FROM twitch_eventsub_deliveries
            WHERE workspace_id = $1 AND status = 'failed'
            ORDER BY received_at DESC, id DESC LIMIT 100`,
          [workspace.id],
        ),
    );
    return result.rows;
  }

  async retry(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    deliveryId: string,
    reason: string,
  ) {
    return this.changeFailedDelivery(workspace, actor, deliveryId, reason, 'retry');
  }

  async dismiss(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    deliveryId: string,
    reason: string,
  ) {
    return this.changeFailedDelivery(workspace, actor, deliveryId, reason, 'dismiss');
  }

  private async changeFailedDelivery(
    workspace: WorkspaceRequestContext,
    actor: AuthenticatedUser,
    deliveryId: string,
    reason: string,
    action: 'retry' | 'dismiss',
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) {
      throw new NotFoundException('EventSub delivery not found.');
    }
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 10 || normalizedReason.length > 500) {
      throw new ConflictException('A recovery reason between 10 and 500 characters is required.');
    }

    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const result = await client.query<FailedDelivery>(
          `SELECT id, message_id, message_type, status, attempts, last_error, received_at
             FROM twitch_eventsub_deliveries
            WHERE workspace_id = $1 AND id = $2 AND status = 'failed'
            FOR UPDATE`,
          [workspace.id, deliveryId],
        );
        const delivery = result.rows[0];
        if (!delivery) throw new ConflictException('Only failed EventSub deliveries can be recovered.');

        const status = action === 'retry' ? 'accepted' : 'dismissed';
        const updated = await client.query(
          `UPDATE twitch_eventsub_deliveries
              SET status = $3,
                  attempts = CASE WHEN $3 = 'accepted' THEN 0 ELSE attempts END,
                  processed_at = CASE WHEN $3 = 'dismissed' THEN now() ELSE NULL END,
                  last_error = NULL,
                  dispatch_published_at = NULL,
                  next_dispatch_at = now(),
                  dispatch_locked_at = NULL,
                  dispatch_lock_token = NULL,
                  dispatch_error_code = NULL
            WHERE workspace_id = $1 AND id = $2 AND status = 'failed'`,
          [workspace.id, deliveryId, status],
        );
        if (updated.rowCount !== 1) {
          throw new ConflictException('EventSub delivery recovery raced another action.');
        }
        await client.query(
          `INSERT INTO audit_events
            (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1,$2,$3,'twitch_eventsub_delivery',$4,$5::jsonb)`,
          [
            workspace.id,
            actor.id,
            `twitch.eventsub.delivery.${action}`,
            deliveryId,
            JSON.stringify({ reason: normalizedReason, previousStatus: 'failed' }),
          ],
        );
        await this.outbox.append(client, {
          workspaceId: workspace.id as VerifiedWorkspaceId,
          eventType: `twitch.eventsub.delivery.${action}`,
          aggregateType: 'twitch_eventsub_delivery',
          aggregateId: deliveryId,
          idempotencyKey: `twitch.eventsub.delivery.${action}:${deliveryId}`,
          payload: { messageId: delivery.message_id, reason: normalizedReason },
        });
        return { deliveryId, status };
      },
    );
  }
}
