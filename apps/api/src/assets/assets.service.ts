import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { VerifiedWorkspaceId } from '@platform/contracts';
import { DatabaseService } from '../database/database.service.js';
import { ObjectStorageService } from './object-storage.service.js';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

type AssetRow = {
  id: string;
  name: string;
  folder_path: string;
  content_type: string | null;
  byte_size: string | null;
  width: number | null;
  height: number | null;
  status: 'pending' | 'ready';
  object_key: string | null;
  pending_object_key: string | null;
  pending_content_type?: string | null;
  created_at: Date;
  updated_at: Date;
};

function assetName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) {
    throw new BadRequestException('Asset names must contain between 1 and 160 characters.');
  }
  return value.trim();
}

function folderPath(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 512 || value.startsWith('/') || value.includes('\\')) {
    throw new BadRequestException('Folder path is invalid.');
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.length > 80 || part.split('').some((character) => character.charCodeAt(0) < 32))) {
    throw new BadRequestException('Folder path is invalid.');
  }
  return parts.join('/');
}

function imageDimensions(bytes: Buffer, contentType: string): { width: number; height: number } | null {
  if (contentType === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (contentType === 'image/gif' && bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (contentType === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      return { width: 1 + (((bytes[22] ?? 0) & 0x3f) << 8 | (bytes[21] ?? 0)), height: 1 + (((bytes[24] ?? 0) & 0x0f) << 10 | (bytes[23] ?? 0) << 2 | ((bytes[22] ?? 0) & 0xc0) >> 6) };
    }
  }
  if (contentType === 'image/jpeg' && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1] ?? 0;
      const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return null;
}

async function readLimited(response: Response, maximumBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new BadRequestException('Uploaded image content could not be read.');
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new BadRequestException('Image files must be no larger than 10 MiB.');
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, totalBytes);
}

@Injectable()
export class AssetsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ObjectStorageService) private readonly storage: ObjectStorageService,
  ) {}

  async folders(workspaceId: VerifiedWorkspaceId, userId: string): Promise<string[]> {
    const result = await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, (client) =>
      client.query<{ folder_path: string }>(
        'SELECT DISTINCT folder_path FROM workspace_assets WHERE workspace_id = $1 AND status = \'ready\' ORDER BY folder_path',
        [workspaceId],
      ),
    );
    return result.rows.map((row) => row.folder_path).filter(Boolean);
  }

  async list(workspaceId: VerifiedWorkspaceId, userId: string, folder?: string) {
    const path = folderPath(folder);
    const result = await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, (client) =>
      client.query<AssetRow>(
        `SELECT id, name, folder_path, content_type, byte_size, width, height, status, object_key,
                pending_object_key, created_at, updated_at
           FROM workspace_assets
          WHERE workspace_id = $1 AND folder_path = $2
          ORDER BY name, id`,
        [workspaceId, path],
      ),
    );
    return Promise.all(result.rows.filter((row) => row.status === 'ready').map(async (row) => ({
      id: row.id, name: row.name, folder: row.folder_path, contentType: row.content_type,
      size: Number(row.byte_size), width: row.width, height: row.height,
      createdAt: row.created_at, updatedAt: row.updated_at,
      url: this.storage.presign('GET', row.object_key as string, undefined, 3600),
    })));
  }

  async createUpload(workspaceId: VerifiedWorkspaceId, userId: string, input: { name: unknown; folder?: unknown; contentType: unknown }) {
    const name = assetName(input.name);
    const folder = folderPath(input.folder);
    if (typeof input.contentType !== 'string' || !ALLOWED_TYPES.has(input.contentType)) {
      throw new BadRequestException('Only PNG, JPEG, WebP, and GIF images are supported.');
    }
    const id = randomUUID();
    const key = `${workspaceId}/${id}/${randomUUID()}`;
    await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, async (client) => {
      await client.query(
        `INSERT INTO workspace_assets (id, workspace_id, name, folder_path, pending_object_key, pending_content_type, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, workspaceId, name, folder, key, input.contentType, userId],
      );
      await client.query(
        `INSERT INTO audit_events (workspace_id, actor_user_id, event_type, target_type, target_id, details)
         VALUES ($1, $2, 'asset.upload_started', 'workspace_asset', $3, jsonb_build_object('contentType', $4::text))`,
        [workspaceId, userId, id, input.contentType],
      );
    });
    return { assetId: id, uploadUrl: this.storage.presign('PUT', key, input.contentType), method: 'PUT', headers: { 'Content-Type': input.contentType }, completePath: `/workspaces/${workspaceId}/assets/${id}/complete` };
  }

  async createReplacementUpload(workspaceId: VerifiedWorkspaceId, userId: string, assetId: string, contentType: unknown) {
    if (typeof contentType !== 'string' || !ALLOWED_TYPES.has(contentType)) throw new BadRequestException('Only PNG, JPEG, WebP, and GIF images are supported.');
    const key = `${workspaceId}/${assetId}/${randomUUID()}`;
    const updated = await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, (client) =>
      client.query<AssetRow>(
        `UPDATE workspace_assets SET pending_object_key = $3, pending_content_type = $4, updated_at = now()
          WHERE id = $1 AND workspace_id = $2 RETURNING id`,
        [assetId, workspaceId, key, contentType],
      ),
    );
    if (!updated.rowCount) throw new NotFoundException('Asset not found.');
    return { assetId, uploadUrl: this.storage.presign('PUT', key, contentType), method: 'PUT', headers: { 'Content-Type': contentType }, completePath: `/workspaces/${workspaceId}/assets/${assetId}/complete` };
  }

  async completeUpload(workspaceId: VerifiedWorkspaceId, userId: string, assetId: string) {
    const pending = await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, (client) =>
      client.query<AssetRow>(
        `SELECT id, name, folder_path, object_key, pending_object_key, pending_content_type, status
           FROM workspace_assets WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [assetId, workspaceId],
      ),
    );
    const row = pending.rows[0];
    if (!row?.pending_object_key || !row.pending_content_type) throw new ConflictException('There is no pending upload for this asset.');
    const url = this.storage.presign('HEAD', row.pending_object_key, undefined, 60, true);
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) throw new BadRequestException('The uploaded object could not be verified.');
    const contentLength = Number(head.headers.get('content-length'));
    if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > MAX_BYTES) throw new BadRequestException('Image files must be no larger than 10 MiB.');
    if (head.headers.get('content-type')?.split(';')[0]?.trim() !== row.pending_content_type) throw new BadRequestException('Uploaded image content type does not match the declared type.');
    const response = await fetch(this.storage.presign('GET', row.pending_object_key, undefined, 60, true));
    if (!response.ok) throw new BadRequestException('The uploaded object could not be verified.');
    const bytes = await readLimited(response, MAX_BYTES);
    if (bytes.length !== contentLength || bytes.length > MAX_BYTES) throw new BadRequestException('Image files must be no larger than 10 MiB.');
    const dimensions = imageDimensions(bytes, row.pending_content_type);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 8192 || dimensions.height > 8192) {
      throw new BadRequestException('The uploaded file is not a supported image or its dimensions exceed 8192 × 8192.');
    }
    const oldKey = row.object_key;
    const completed = await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, async (client) => {
      const result = await client.query(
        `UPDATE workspace_assets SET object_key = pending_object_key, content_type = pending_content_type,
             byte_size = $3, width = $4, height = $5, status = 'ready',
             pending_object_key = NULL, pending_content_type = NULL, updated_at = now()
           WHERE id = $1 AND workspace_id = $2 AND pending_object_key = $6
           RETURNING id, name, folder_path, content_type, byte_size, width, height, created_at, updated_at`,
        [assetId, workspaceId, bytes.length, dimensions.width, dimensions.height, row.pending_object_key],
      );
      if (!result.rowCount) throw new ConflictException('A newer upload replaced this pending upload.');
      await client.query(
        `INSERT INTO audit_events (workspace_id, actor_user_id, event_type, target_type, target_id, details)
         VALUES ($1, $2, 'asset.upload_completed', 'workspace_asset', $3,
                 jsonb_build_object('size', $4::bigint, 'width', $5::integer, 'height', $6::integer))`,
        [workspaceId, userId, assetId, bytes.length, dimensions.width, dimensions.height],
      );
      return result.rows[0];
    });
    if (oldKey) await this.storage.delete(oldKey).catch(() => undefined);
    return completed.rows[0];
  }

  async update(workspaceId: VerifiedWorkspaceId, userId: string, assetId: string, input: { name?: unknown; folder?: unknown }) {
    const name = input.name === undefined ? undefined : assetName(input.name);
    const folder = input.folder === undefined ? undefined : folderPath(input.folder);
    if (name === undefined && folder === undefined) throw new BadRequestException('Provide an asset name or folder.');
    const result = await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, async (client) => {
      const updated = await client.query(
        `UPDATE workspace_assets SET name = COALESCE($3, name), folder_path = COALESCE($4, folder_path), updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND status = 'ready'
          RETURNING id, name, folder_path`,
        [assetId, workspaceId, name ?? null, folder ?? null],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow) {
        await client.query(
          `INSERT INTO audit_events (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1, $2, 'asset.updated', 'workspace_asset', $3,
                   jsonb_build_object('name', $4::text, 'folder', $5::text))`,
          [workspaceId, userId, assetId, updatedRow.name, updatedRow.folder_path],
        );
      }
      return updated;
    });
    if (!result.rowCount) throw new NotFoundException('Asset not found.');
    return result.rows[0];
  }

  async usage(workspaceId: VerifiedWorkspaceId, userId: string, assetId: string) {
    const result = await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, (client) =>
      client.query<{ id: string; name: string; draft_used: boolean; published_used: boolean }>(
        `SELECT s.id, s.name,
          s.draft_state @> jsonb_build_object('elements', jsonb_build_array(jsonb_build_object('assetId', $3::text))) AS draft_used,
          COALESCE(s.published_state @> jsonb_build_object('elements', jsonb_build_array(jsonb_build_object('assetId', $3::text))), false) AS published_used
         FROM overlay_scenes s
         WHERE s.workspace_id = $1 AND (
           s.draft_state @> jsonb_build_object('elements', jsonb_build_array(jsonb_build_object('assetId', $3::text)))
           OR COALESCE(s.published_state @> jsonb_build_object('elements', jsonb_build_array(jsonb_build_object('assetId', $3::text))), false)
         ) ORDER BY s.name, s.id`,
        [workspaceId, assetId, assetId],
      ),
    );
    return result.rows.map((row) => ({ sceneId: row.id, sceneName: row.name, draft: row.draft_used, published: row.published_used }));
  }

  async remove(workspaceId: VerifiedWorkspaceId, userId: string, assetId: string) {
    const usage = await this.usage(workspaceId, userId, assetId);
    if (usage.length) throw new ConflictException({ message: 'This asset is still used by one or more scenes.', usage });
    const result = await this.database.transaction({ userId, verifiedWorkspaceId: workspaceId }, async (client) => {
      const deleted = await client.query<{ object_key: string | null; pending_object_key: string | null }>(
        'DELETE FROM workspace_assets WHERE id = $1 AND workspace_id = $2 RETURNING object_key, pending_object_key',
        [assetId, workspaceId],
      );
      if (deleted.rows[0]) {
        await client.query(
          `INSERT INTO audit_events (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1, $2, 'asset.deleted', 'workspace_asset', $3, '{}'::jsonb)`,
          [workspaceId, userId, assetId],
        );
      }
      return deleted.rows[0];
    });
    if (!result) throw new NotFoundException('Asset not found.');
    for (const key of [result.object_key, result.pending_object_key]) if (key) await this.storage.delete(key).catch(() => undefined);
    return { deleted: true };
  }
}
