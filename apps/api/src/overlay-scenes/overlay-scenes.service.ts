import type { VerifiedWorkspaceId } from '@platform/contracts';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
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
  draft_revision?: number;
  published_at?: Date | null;
}

const MAX_SCENE_DOCUMENT_BYTES = 256 * 1024;

function sceneDocument(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Scene state must be a JSON object.');
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new BadRequestException('Scene state must be valid JSON.');
  }
  if (!serialized) throw new BadRequestException('Scene state must be a JSON object.');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCENE_DOCUMENT_BYTES) {
    throw new BadRequestException('Scene state must not exceed 256 KiB.');
  }
  const normalized: unknown = JSON.parse(serialized);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new BadRequestException('Scene state must be a JSON object.');
  }
  return normalized as Record<string, unknown>;
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
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

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


  async ensureStarter(workspaceId: VerifiedWorkspaceId, userId: string) {
    return this.database.transaction(
      { userId, verifiedWorkspaceId: workspaceId },
      async (client) => {
        // Serialize first-use requests for this workspace, including the no-row-yet case.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [workspaceId]);
        const existing = await client.query<OverlaySceneRecord>(
          `SELECT id, name, sort_order, created_at, updated_at, token_created_at,
                  token_revoked_at,
                  (access_token_hash IS NOT NULL AND token_revoked_at IS NULL) AS has_active_access
             FROM overlay_scenes
            WHERE workspace_id = $1 AND is_starter = true
            LIMIT 1`,
          [workspaceId],
        );
        const current = existing.rows[0];
        if (current) {
          return { scene: current, accessToken: null, overlayPath: `/scene/${current.id}`, created: false };
        }

        const sceneId = randomUUID();
        const accessToken = newOpaqueToken();
        const created = await client.query<OverlaySceneRecord>(
          `INSERT INTO overlay_scenes
             (id, workspace_id, name, is_starter, access_token_hash, token_created_at, created_by_user_id)
           VALUES ($1, $2, 'Now Playing', true, $3, now(), $4)
           RETURNING id, name, sort_order, created_at, updated_at, token_created_at,
                     token_revoked_at,
                     (access_token_hash IS NOT NULL AND token_revoked_at IS NULL) AS has_active_access`,
          [sceneId, workspaceId, sha256(accessToken), userId],
        );
        const scene = created.rows[0];
        if (!scene) throw new Error('Starter scene creation did not return a record.');
        await client.query(
          `INSERT INTO audit_events
             (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1, $2, 'overlay.scene.starter_created', 'overlay_scene', $3,
                   jsonb_build_object('name', 'Now Playing'))`,
          [workspaceId, userId, sceneId],
        );
        return { scene, accessToken, overlayPath: `/scene/${sceneId}`, created: true };
      },
    );
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

  async editorState(workspaceId: VerifiedWorkspaceId, userId: string, sceneId: string) {
    const result = await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, (client) =>
      client.query<{
        id: string;
        name: string;
        draft_state: Record<string, unknown>;
        draft_revision: string;
        published_state: Record<string, unknown> | null;
        published_at: Date | null;
        updated_at: Date;
      }>(
        `SELECT id, name, draft_state, draft_revision, published_state, published_at, updated_at
           FROM overlay_scenes
          WHERE id = $1 AND workspace_id = $2`,
        [sceneId, workspaceId],
      ),
    );
    const scene = result.rows[0];
    if (!scene) throw new NotFoundException('Scene not found.');
    return {
      sceneId: scene.id,
      name: scene.name,
      draftState: scene.draft_state,
      draftRevision: Number(scene.draft_revision),
      publishedAt: scene.published_at,
      updatedAt: scene.updated_at,
      hasPublishedState: scene.published_state !== null,
    };
  }

  async saveDraft(
    workspaceId: VerifiedWorkspaceId,
    userId: string,
    sceneId: string,
    stateInput: unknown,
    expectedRevisionInput: unknown,
  ) {
    const draftState = sceneDocument(stateInput);
    if (!Number.isSafeInteger(expectedRevisionInput) || (expectedRevisionInput as number) < 0) {
      throw new BadRequestException('A valid draft revision is required.');
    }
    const expectedRevision = expectedRevisionInput as number;
    return this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, async (client) => {
      const updated = await client.query<{
        id: string;
        name: string;
        draft_state: Record<string, unknown>;
        draft_revision: string;
        updated_at: Date;
      }>(
        `UPDATE overlay_scenes
            SET draft_state = $4::jsonb,
                draft_revision = draft_revision + 1,
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND draft_revision = $3
          RETURNING id, name, draft_state, draft_revision, updated_at`,
        [sceneId, workspaceId, expectedRevision, JSON.stringify(draftState)],
      );
      const scene = updated.rows[0];
      if (scene) {
        await client.query(
          `INSERT INTO audit_events
             (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1, $2, 'overlay.scene.draft_saved', 'overlay_scene', $3,
                   jsonb_build_object('revision', $4::bigint))`,
          [workspaceId, userId, sceneId, scene.draft_revision],
        );
        return {
          sceneId: scene.id,
          name: scene.name,
          draftState: scene.draft_state,
          draftRevision: Number(scene.draft_revision),
          updatedAt: scene.updated_at,
        };
      }
      const exists = await client.query('SELECT 1 FROM overlay_scenes WHERE id = $1 AND workspace_id = $2', [sceneId, workspaceId]);
      if (exists.rowCount === 0) throw new NotFoundException('Scene not found.');
      throw new ConflictException('This scene draft changed elsewhere. Reload it before saving again.');
    });
  }

  async publishDraft(workspaceId: VerifiedWorkspaceId, userId: string, sceneId: string, expectedRevisionInput: unknown) {
    if (!Number.isSafeInteger(expectedRevisionInput) || (expectedRevisionInput as number) < 0) {
      throw new BadRequestException('A valid draft revision is required to publish.');
    }
    const expectedRevision = expectedRevisionInput as number;
    return this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, async (client) => {
      const updated = await client.query<{
        id: string;
        name: string;
        published_state: Record<string, unknown>;
        draft_revision: string;
        published_at: Date;
      }>(
        `UPDATE overlay_scenes
            SET published_state = draft_state,
                published_at = now(),
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND draft_revision = $3
          RETURNING id, name, published_state, draft_revision, published_at`,
        [sceneId, workspaceId, expectedRevision],
      );
      const scene = updated.rows[0];
      if (!scene) {
        const exists = await client.query('SELECT 1 FROM overlay_scenes WHERE id = $1 AND workspace_id = $2', [sceneId, workspaceId]);
        if (exists.rowCount === 0) throw new NotFoundException('Scene not found.');
        throw new ConflictException('This scene draft changed elsewhere. Reload it before publishing.');
      }
      await this.outbox.append(client, {
        workspaceId,
        eventType: 'overlay.scene.published',
        aggregateType: 'overlay_scene',
        aggregateId: scene.id,
        idempotencyKey: `overlay-scene-published:${scene.id}:${scene.published_at.toISOString()}`,
        payload: { sceneId: scene.id, draftRevision: Number(scene.draft_revision) },
      });
      await client.query(
        `INSERT INTO audit_events
           (workspace_id, actor_user_id, event_type, target_type, target_id, details)
         VALUES ($1, $2, 'overlay.scene.published', 'overlay_scene', $3,
                 jsonb_build_object('draftRevision', $4::bigint))`,
        [workspaceId, userId, scene.id, scene.draft_revision],
      );
      return {
        sceneId: scene.id,
        name: scene.name,
        publishedAt: scene.published_at,
        publishedRevision: Number(scene.draft_revision),
      };
    });
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
