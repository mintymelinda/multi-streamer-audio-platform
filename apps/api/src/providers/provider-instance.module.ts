import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { ProviderHealthService, ProviderInstanceService } from './provider-instance.service.js';
import { InvidiousResolverService } from './invidious-resolver.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    ProviderHealthService,
    InvidiousResolverService,
    {
      provide: ProviderInstanceService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) =>
        new ProviderInstanceService({
          repository: {
            findByIdentity: async ({ workspaceId, providerId, instanceKey, userId }) => {
              if (!userId)
                throw new Error('An authenticated user is required for provider instance access.');
              const result = await database.transaction(
                { userId, verifiedWorkspaceId: workspaceId as never },
                (client) =>
                  client.query<{
                    id: string;
                    workspace_id: string;
                    provider_id: string;
                    instance_key: string;
                  }>(
                    `SELECT id, workspace_id, provider_id, instance_key FROM provider_instances
                  WHERE workspace_id = $1 AND provider_id = $2 AND instance_key = $3`,
                    [workspaceId, providerId, instanceKey],
                  ),
              );
              const row = result.rows[0];
              return row
                ? {
                    id: row.id,
                    workspaceId: row.workspace_id,
                    providerId: row.provider_id,
                    instanceKey: row.instance_key,
                  }
                : null;
            },
            create: async ({ workspaceId, providerId, instanceKey, userId, contractVersion }) => {
              const result = await database.transaction(
                { userId, verifiedWorkspaceId: workspaceId as never },
                (client) =>
                  client.query<{
                    id: string;
                    workspace_id: string;
                    provider_id: string;
                    instance_key: string;
                  }>(
                    `INSERT INTO provider_instances (workspace_id, provider_id, instance_key, contract_version)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (workspace_id, provider_id, instance_key)
                 DO UPDATE SET updated_at = now()
                 RETURNING id, workspace_id, provider_id, instance_key`,
                    [workspaceId, providerId, instanceKey, contractVersion],
                  ),
              );
              const row = result.rows[0];
              if (!row) throw new Error('Provider instance could not be persisted.');
              return {
                id: row.id,
                workspaceId: row.workspace_id,
                providerId: row.provider_id,
                instanceKey: row.instance_key,
              };
            },
          },
        }),
    },
  ],
  exports: [ProviderInstanceService, ProviderHealthService, InvidiousResolverService],
})
export class ProviderInstanceModule {}
