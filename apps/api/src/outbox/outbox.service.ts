import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

export interface NewOutboxEvent {
  workspaceId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  /**
   * Append using the caller's existing transaction. The caller must already
   * have authenticated the actor and established verified workspace context.
   * Business state and this event therefore commit or roll back together.
   */
  async append(client: PoolClient, event: NewOutboxEvent): Promise<string> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO outbox_events
        (workspace_id, event_type, aggregate_type, aggregate_id, idempotency_key, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        event.workspaceId,
        event.eventType,
        event.aggregateType,
        event.aggregateId,
        event.idempotencyKey,
        JSON.stringify(event.payload),
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id) return id;

    const existing = await client.query<{ id: string }>(
      'SELECT id FROM outbox_events WHERE workspace_id = $1 AND idempotency_key = $2',
      [event.workspaceId, event.idempotencyKey],
    );
    const existingId = existing.rows[0]?.id;
    if (!existingId) {
      throw new Error('Outbox idempotency conflict could not be resolved.');
    }
    return existingId;
  }
}
