import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { VerifiedWorkspaceId } from '@platform/contracts';
import { DatabaseService } from '../database/database.service.js';
import { ObjectStorageService } from '../assets/object-storage.service.js';
import { DeletionLedgerService } from '../deletion-ledger/deletion-ledger.service.js';

@Injectable()
export class WorkspaceLifecycleService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ObjectStorageService) private readonly storage: ObjectStorageService,
    @Inject(DeletionLedgerService) private readonly ledger: DeletionLedgerService,
  ) {}

  async export(workspaceId: VerifiedWorkspaceId, userId: string) {
    const result = await this.database.transaction(
      { userId, verifiedWorkspaceId: workspaceId },
      async (client) => {
        const exported = await client.query<{ document: Record<string, unknown> }>(
          'SELECT export_workspace_data($1) AS document',
          [workspaceId],
        );
        const assets = await client.query<{
          id: string; name: string; folder_path: string; content_type: string | null;
          byte_size: string | null; width: number | null; height: number | null;
          object_key: string | null;
        }>(
          `SELECT id,name,folder_path,content_type,byte_size,width,height,object_key
             FROM workspace_assets WHERE workspace_id=$1 AND status='ready'
             ORDER BY created_at,id`,
          [workspaceId],
        );
        return { document: exported.rows[0]?.document, assets: assets.rows };
      },
    );
    if (!result.document) throw new NotFoundException('Workspace not found.');
    const assetFiles = result.assets.filter((asset) => asset.object_key).map((asset) => ({
      id: asset.id,
      name: asset.name,
      folder: asset.folder_path,
      contentType: asset.content_type,
      size: Number(asset.byte_size),
      width: asset.width,
      height: asset.height,
      downloadUrl: this.storage.presign('GET', asset.object_key as string, undefined, 604800),
      downloadUrlExpiresInSeconds: 604800,
    }));
    const document = { ...result.document, assetFiles };
    if (Buffer.byteLength(JSON.stringify(document), 'utf8') > 50 * 1024 * 1024) {
      throw new BadRequestException('Workspace export exceeds the 50 MiB safety limit.');
    }
    return document;
  }

  async delete(workspaceId: VerifiedWorkspaceId, userId: string, confirmationName: unknown) {
    if (typeof confirmationName !== 'string' || !confirmationName.trim()) {
      throw new BadRequestException('Enter the exact workspace name to confirm permanent deletion.');
    }
    return this.database.transaction(
      { userId, verifiedWorkspaceId: workspaceId },
      async (client) => {
        const found = await client.query<{ name: string; owner_user_id: string }>(
          'SELECT name,owner_user_id FROM workspaces WHERE id=$1 FOR UPDATE',
          [workspaceId],
        );
        const workspace = found.rows[0];
        if (!workspace) throw new NotFoundException('Workspace not found.');
        if (workspace.owner_user_id !== userId) {
          throw new ForbiddenException('Only the workspace owner can permanently delete it.');
        }
        if (workspace.name !== confirmationName.trim()) {
          throw new BadRequestException('The confirmation name does not match this workspace.');
        }

        const assets = await client.query<{ object_key: string | null; pending_object_key: string | null }>(
          'SELECT object_key,pending_object_key FROM workspace_assets WHERE workspace_id=$1',
          [workspaceId],
        );
        const keys = [...new Set(assets.rows.flatMap((asset) =>
          [asset.object_key, asset.pending_object_key].filter((key): key is string => Boolean(key)),
        ))];

        // Remove private objects before the cascading database delete. If storage
        // is unavailable, the transaction remains intact and the owner can retry.
        for (const key of keys) await this.storage.delete(key);

        const deleted = await client.query(
          'DELETE FROM workspaces WHERE id=$1 AND owner_user_id=$2 RETURNING id',
          [workspaceId, userId],
        );
        if (!deleted.rowCount) throw new NotFoundException('Workspace not found.');
        await this.ledger.append('workspace', workspaceId);
        return {
          deleted: true,
          workspaceId,
          deletedAssetObjects: keys.length,
          message: 'Workspace data and credentials were deleted. The platform account remains active.',
        };
      },
    );
  }
}
