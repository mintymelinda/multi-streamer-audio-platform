import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { RightsComplianceService } from './rights-compliance.service.js';
import { RightsReviewWorkflowService } from './rights-review-workflow.service.js';

@Module({
  imports: [DatabaseModule, OutboxModule],
  providers: [
    {
      provide: RightsComplianceService,
      inject: [DatabaseService, OutboxService],
      useFactory: (database: DatabaseService, outbox: OutboxService) =>
        new RightsComplianceService({ database, outbox }),
    },
    {
      provide: RightsReviewWorkflowService,
      inject: [DatabaseService, RightsComplianceService],
      useFactory: (database: DatabaseService, compliance: RightsComplianceService) =>
        new RightsReviewWorkflowService({
          createReport: async (input) =>
            compliance.submitRightsHolderReport(input as Parameters<RightsComplianceService['submitRightsHolderReport']>[0]),
          findReport: async ({ reportId, workspaceId, actorId }) => {
            const result = await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              (client) => client.query<{ workspace_id: string; status: string }>(
                'SELECT workspace_id, status FROM rights_holder_reports WHERE id = $1 AND workspace_id = $2',
                [reportId, workspaceId],
              ),
            );
            const row = result.rows[0];
            return row ? { workspaceId: row.workspace_id, status: row.status as never } : null;
          },
          updateStatus: async ({ reportId, workspaceId, actorId, from, status, reason }) => {
            await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              async (client) => {
                const updated = await client.query(
                  `UPDATE rights_holder_reports SET status = $4, updated_at = now()
                    WHERE id = $1 AND workspace_id = $2 AND status = $3`,
                  [reportId, workspaceId, from, status],
                );
                if (updated.rowCount !== 1) throw new Error('Rights report was not found or its status changed.');
                await client.query(
                  `INSERT INTO rights_report_events
                    (workspace_id, report_id, actor_user_id, from_status, to_status, reason)
                   VALUES ($1, $2, $3, $4, $5, $6)`,
                  [workspaceId, reportId, actorId, from, status, reason],
                );
              },
            );
          },
          saveDecision: async (input) => {
            const actorId = String(input.actorId);
            const workspaceId = String(input.workspaceId);
            await database.transaction(
              { userId: actorId, verifiedWorkspaceId: workspaceId as never },
              async (client) => {
                const updated = await client.query(
                  `UPDATE rights_holder_reports
                      SET decision = $4, decision_reason = $5, decided_by_user_id = $6,
                          decided_at = now(), status = 'closed', updated_at = now()
                    WHERE id = $1 AND workspace_id = $2 AND status = $3`,
                  [input.reportId, workspaceId, input.from, input.outcome, input.reason, actorId],
                );
                if (updated.rowCount !== 1) throw new Error('Rights report was not found or its status changed.');
                await client.query(
                  `INSERT INTO rights_report_events
                    (workspace_id, report_id, actor_user_id, from_status, to_status, reason, details)
                   VALUES ($1, $2, $3, $4, 'closed', $5, $6::jsonb)`,
                  [workspaceId, input.reportId, actorId, input.from, input.reason,
                    JSON.stringify({ outcome: input.outcome, preserveEvidence: input.preserveEvidence })],
                );
              },
            );
          },
          appendAudit: async (event) => {
            if (event.to === 'received') {
              const workspaceId = String(event.workspaceId);
              await database.transaction(
                { verifiedWorkspaceId: workspaceId as never },
                (client) => client.query(
                  `INSERT INTO rights_report_events
                    (workspace_id, report_id, from_status, to_status, reason)
                   VALUES ($1, $2, NULL, 'received', 'Rights-holder report received')`,
                  [workspaceId, event.reportId],
                ),
              );
            }
          },
          assignReviewer: async () => null,
          blockContent: async (input) =>
            compliance.blockContent(input as Parameters<RightsComplianceService['blockContent']>[0]),
        }),
    },
  ],
  exports: [RightsComplianceService, RightsReviewWorkflowService],
})
export class RightsComplianceModule {}
