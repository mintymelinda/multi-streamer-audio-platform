import type { VerifiedWorkspaceId } from '@platform/contracts';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { newOpaqueToken, sha256 } from '../identity/security.js';

export interface OverlaySceneRecord {
  id: string;
  name: string;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
  token_created_at: Date | null;
  token_revoked_at: Date | null;
  has_active_access: boolean;
}

function sceneName(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('A scene name is required.');
  const name = value.trim();
  if (name.length < 1 || name.length > 80) {
    throw new BadRequestException('Scene names must contain between 1 and 80 characters.');
  }
  return name;
}

@Injectable()
export class OverlayScenesService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(workspaceId: VerifiedWorkspaceId, userId: string): Promise<OverlaySceneRecord[]> {
    const result = await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, (client) =>
      client.query<OverlaySceneRecord>(
        `SELECT id, name, sort_order, created_at, updated_at, token_created_at,
                token_revoked_at,
                (access_token_hash IS NOT NULL AND token_revoked_at IS NULL) AS has_active_access
           FROM overlay_scenes
          WHERE workspace_id = $1
          ORDER BY sort_order, created_at, id`,
        [workspaceId],
      ),
    );
    return result.rows;
  }

  async create(workspaceId: VerifiedWorkspaceId, userId: string, nameInput: unknown) {
    const name = sceneName(nameInput);
    const sceneId = randomUUID();
    const accessToken = newOpaqueToken();
    const scene = await this.database.transaction(
      { userId, verifiedWorkspaceId: workspaceId },
      async (client) => {
        const created = await client.query<OverlaySceneRecord>(
          `INSERT INTO overlay_scenes
             (id, workspace_id, name, access_token_hash, token_created_at, created_by_user_id)
           VALUES ($1, $2, $3, $4, now(), $5)
           RETURNING id, name, sort_order, created_at, updated_at, token_created_at,
                     token_revoked_at,
                     (access_token_hash IS NOT NULL AND token_revoked_at IS NULL) AS has_active_access`,
          [sceneId, workspaceId, name, sha256(accessToken), userId],
        );
        const row = created.rows[0];
        if (!row) throw new Error('Scene creation did not return a record.');
        await client.query(
          `INSERT INTO audit_events
             (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1, $2, 'overlay.scene.created', 'overlay_scene', $3,
                   jsonb_build_object('name', $4::text))`,
          [workspaceId, userId, sceneId, name],
        );
        return row;
      },
    );
    return { scene, accessToken, overlayPath: `/scene/${sceneId}` };
  }

  async rotateAccessToken(workspaceId: VerifiedWorkspaceId, userId: string, sceneId: string) {
    const accessToken = newOpaqueToken();
    const scene = await this.database.transaction(
      { userId, verifiedWorkspaceId: workspaceId },
      async (client) => {
        const updated = await client.query<OverlaySceneRecord>(
          `UPDATE overlay_scenes
              SET access_token_hash = $3, token_created_at = now(),
                  token_revoked_at = NULL, updated_at = now()
            WHERE id = $1 AND workspace_id = $2
            RETURNING id, name, sort_order, created_at, updated_at, token_created_at,
                      token_revoked_at,
                      (access_token_hash IS NOT NULL AND token_revoked_at IS NULL) AS has_active_access`,
          [sceneId, workspaceId, sha256(accessToken)],
        );
        const row = updated.rows[0];
        if (!row) throw new NotFoundException('Scene not found.');
        await client.query(
          `INSERT INTO audit_events
             (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1, $2, 'overlay.scene.access_token_rotated', 'overlay_scene', $3, '{}'::jsonb)`,
          [workspaceId, userId, sceneId],
        );
        await client.query("SELECT pg_notify('overlay_scene_access_changed', $1)", [sceneId]);
        return row;
      },
    );
    return { scene, accessToken, overlayPath: `/scene/${sceneId}` };
  }

  async revokeAccessToken(workspaceId: VerifiedWorkspaceId, userId: string, sceneId: string) {
    return this.database.transaction(
      { userId, verifiedWorkspaceId: workspaceId },
      async (client) => {
        const updated = await client.query<{ id: string; token_revoked_at: Date }>(
          `UPDATE overlay_scenes
              SET access_token_hash = NULL,
                  token_revoked_at = COALESCE(token_revoked_at, now()),
                  updated_at = now()
            WHERE id = $1 AND workspace_id = $2
            RETURNING id, token_revoked_at`,
          [sceneId, workspaceId],
        );
        const row = updated.rows[0];
        if (!row) throw new NotFoundException('Scene not found.');
        await client.query(
          `INSERT INTO audit_events
             (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1, $2, 'overlay.scene.access_token_revoked', 'overlay_scene', $3, '{}'::jsonb)`,
          [workspaceId, userId, sceneId],
        );
        await client.query("SELECT pg_notify('overlay_scene_access_changed', $1)", [sceneId]);
        return { sceneId: row.id, hasActiveAccess: false, tokenRevokedAt: row.token_revoked_at };
      },
    );
  }
}
