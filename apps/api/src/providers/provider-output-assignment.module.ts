import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { ProviderOutputAssignmentService } from './provider-output-assignment.service.js';
type Row = { id: string; workspace_id: string; provider_instance_id: string; output_id: string; player_id: string; assigned_by: string; created_at: Date; updated_at: Date; };
@Module({
  imports: [DatabaseModule],
  providers: [{
    provide: ProviderOutputAssignmentService, inject: [DatabaseService],
    useFactory: (database: DatabaseService) => new ProviderOutputAssignmentService({ repository: {
      findAssignment: async ({ workspaceId, providerInstanceId, userId }) => {
        if (!userId) throw new Error('Authenticated workspace user is required.');
        const result = await database.transaction({ userId, verifiedWorkspaceId: workspaceId as never }, (client) =>
          client.query<Row>(`SELECT id, workspace_id, provider_instance_id, output_id, player_id, assigned_by, created_at, updated_at
            FROM provider_output_assignments WHERE workspace_id = $1 AND provider_instance_id = $2 AND active = true`, [workspaceId, providerInstanceId]));
        return mapRow(result.rows[0]);
      },
      findConflicts: async ({ workspaceId, providerInstanceId, outputId, userId }) => {
        if (!userId) throw new Error('Authenticated workspace user is required.');
        const result = await database.transaction({ userId, verifiedWorkspaceId: workspaceId as never }, (client) =>
          client.query<Row>(`SELECT id, workspace_id, provider_instance_id, output_id, player_id, assigned_by, created_at, updated_at
            FROM provider_output_assignments WHERE workspace_id = $1 AND output_id = $2 AND active = true AND provider_instance_id <> $3`, [workspaceId, outputId, providerInstanceId]));
        return result.rows.map(mapRow).filter((row) => row !== null);
      },
      saveAssignment: async ({ workspaceId, providerInstanceId, outputId, playerId, actorId }) => {
        const result = await database.transaction({ userId: actorId, verifiedWorkspaceId: workspaceId as never }, (client) =>
          client.query<Row>(`INSERT INTO provider_output_assignments (workspace_id, provider_instance_id, output_id, player_id, assigned_by, active)
            VALUES ($1, $2, $3, $4, $5, true)
            ON CONFLICT (workspace_id, provider_instance_id) WHERE active = true
            DO UPDATE SET output_id = EXCLUDED.output_id, player_id = EXCLUDED.player_id, assigned_by = EXCLUDED.assigned_by, updated_at = now()
            RETURNING id, workspace_id, provider_instance_id, output_id, player_id, assigned_by, created_at, updated_at`, [workspaceId, providerInstanceId, outputId, playerId, actorId]));
        const row = mapRow(result.rows[0]); if (!row) throw new Error('Provider output assignment could not be persisted.'); return row;
      },
      releaseAssignment: async ({ workspaceId, providerInstanceId, userId }) => {
        if (!userId) throw new Error('Authenticated workspace user is required.');
        const result = await database.transaction({ userId, verifiedWorkspaceId: workspaceId as never }, (client) =>
          client.query(`UPDATE provider_output_assignments SET active = false, updated_at = now() WHERE workspace_id = $1 AND provider_instance_id = $2 AND active = true`, [workspaceId, providerInstanceId]));
        return (result.rowCount ?? 0) > 0;
      },
    }}),
  }],
  exports: [ProviderOutputAssignmentService],
})
export class ProviderOutputAssignmentModule {}
function mapRow(row: Row | undefined) {
  if (!row) return null;
  return { id: row.id, workspaceId: row.workspace_id, providerInstanceId: row.provider_instance_id, outputId: row.output_id,
    playerId: row.player_id, assignedBy: row.assigned_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
