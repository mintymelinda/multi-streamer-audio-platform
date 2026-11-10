import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { sha256 } from '../identity/security.js';

export interface OverlaySceneSnapshot {
  sceneId: string;
  name: string;
  publishedState: unknown | null;
}

interface SnapshotRow {
  scene_id: string;
  workspace_id: string;
  scene_name: string;
  published_state: unknown | null;
}

@Injectable()
export class OverlayRuntimeService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async authenticate(sceneId: string, token: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sceneId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await this.database.queryInfrastructure<SnapshotRow>(
      'SELECT * FROM get_overlay_scene_snapshot($1::uuid, $2::text)',
      [sceneId, sha256(token)],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      sceneId: row.scene_id,
      workspaceId: row.workspace_id,
      snapshot: {
        sceneId: row.scene_id,
        name: row.scene_name,
        publishedState: row.published_state,
      } satisfies OverlaySceneSnapshot,
    };
  }

  async snapshot(sceneId: string, token: string): Promise<OverlaySceneSnapshot | null> {
    return (await this.authenticate(sceneId, token))?.snapshot ?? null;
  }

  async activeSceneIds(workspaceId: string): Promise<string[]> {
    const result = await this.database.queryInfrastructure<{ scene_id: string }>(
      'SELECT scene_id FROM get_active_overlay_scene_ids($1::uuid)',
      [workspaceId],
    );
    return result.rows.map((row) => row.scene_id);
  }
}
