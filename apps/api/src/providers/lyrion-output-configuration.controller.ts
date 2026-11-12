import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { HttpRequest } from '../identity/http.types.js';
import { CsrfGuard } from '../identity/csrf.guard.js';
import { SessionGuard } from '../identity/session.guard.js';
import {
  RequireWorkspacePermission,
  WorkspacePermissionGuard,
} from '../workspaces/workspace-permission.guard.js';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard.js';
import { DatabaseService } from '../database/database.service.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';
import { InvidiousResolverService } from './invidious-resolver.service.js';
import { YouTubeInvidiousMediaResolver } from './playback-media-source.resolver.js';
import { LyrionPlaybackAdapter } from './lyrion-playback.adapter.js';
import { YouTubeInvidiousAdapter } from './youtube-invidious.adapter.js';

type LyrionConfiguration = {
  instanceKey: string;
  baseUrl: string;
  outputId: string;
  playerId: string;
  username?: string;
  password?: string;
  removeCredentials: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new BadRequestException(`${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function parseConfiguration(value: unknown): LyrionConfiguration {
  const body = record(value);
  const instanceKey = requiredString(body.instanceKey, 'instanceKey', 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(instanceKey)) {
    throw new BadRequestException('instanceKey contains unsupported characters.');
  }
  const username = body.username === undefined || body.username === '' ? undefined : requiredString(body.username, 'username', 256);
  const password = body.password === undefined || body.password === '' ? undefined : requiredString(body.password, 'password', 256);
  const removeCredentials = body.removeCredentials === true;
  if (removeCredentials && (username || password)) {
    throw new BadRequestException('New credentials and removeCredentials cannot be supplied together.');
  }
  if (Boolean(username) !== Boolean(password)) {
    throw new BadRequestException('Lyrion username and password must be supplied together.');
  }
  return {
    instanceKey,
    baseUrl: validateBaseUrl(requiredString(body.baseUrl, 'baseUrl', 2048)),
    outputId: requiredString(body.outputId, 'outputId', 200),
    playerId: requiredString(body.playerId, 'playerId', 200),
    ...(username && password ? { username, password } : {}),
    removeCredentials,
  };
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('baseUrl must be an absolute HTTP(S) URL.');
  }
  const host = url.hostname.toLowerCase();
  const allowedHosts = (process.env.LYRION_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const allowed = allowedHosts.some((entry) => entry.startsWith('*.')
    ? host.endsWith(entry.slice(1)) && host !== entry.slice(2)
    : host === entry);
  const localDevelopmentHost = process.env.NODE_ENV !== 'production' &&
    (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!allowed && !localDevelopmentHost) ||
    (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
  ) {
    throw new BadRequestException('Lyrion base URL must use an operator-approved host and secure transport.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function userId(request: HttpRequest): string {
  if (!request.user) throw new NotFoundException('Workspace not found.');
  return request.user.id;
}

function workspaceId(request: HttpRequest): string {
  const value = request.workspace?.id;
  if (!value) throw new NotFoundException('Workspace not found.');
  return value;
}

@Controller('workspaces/:workspaceId/providers')
@UseGuards(SessionGuard, WorkspaceAccessGuard, WorkspacePermissionGuard)
@RequireWorkspacePermission('workspace:manage')
export class LyrionOutputConfigurationController {
  constructor(
    private readonly database: DatabaseService,
    private readonly credentials: ProviderCredentialsService,
    private readonly invidious: InvidiousResolverService,
  ) {}

  @Post('lyrion')
  @UseGuards(CsrfGuard)
  async configure(@Req() request: HttpRequest, @Body() body: unknown) {
    const actorId = userId(request);
    const tenantId = workspaceId(request);
    const input = parseConfiguration(body);
    const capabilities = {
      search: false,
      resolve: false,
      playback: true,
      pause: true,
      resume: true,
      seek: true,
      queue: false,
      maxDurationSeconds: null,
      mediaTypes: ['audio'],
      supportedSourceProviderIds: ['youtube'],
    };
    const sourceAdapter = new YouTubeInvidiousAdapter({
      instances: process.env.INVIDIOUS_INSTANCE_URL ? [process.env.INVIDIOUS_INSTANCE_URL] : [],
    });
    const sourceHealth = await sourceAdapter.healthCheck();
    if (sourceHealth.status !== 'healthy') {
      throw new ServiceUnavailableException('A healthy Invidious source resolver must be configured before enabling Lyrion playback.');
    }

    const identity = await this.database.transaction(
      { userId: actorId, verifiedWorkspaceId: tenantId as never },
      async (client) => {
        await client.query(
          `INSERT INTO provider_instances (
             workspace_id, provider_id, instance_key, contract_version,
             capabilities, connection_health, enabled
           )
           VALUES ($1, 'youtube', 'invidious-default', 1, $2::jsonb, 'healthy', true)
           ON CONFLICT (workspace_id, provider_id, instance_key)
           DO UPDATE SET capabilities = EXCLUDED.capabilities,
                         connection_health = 'healthy', enabled = true, updated_at = now()`,
          [tenantId, JSON.stringify(sourceAdapter.capabilities)],
        );
        const result = await client.query<{ id: string }>(
          `INSERT INTO provider_instances (
             workspace_id, provider_id, instance_key, contract_version,
             capabilities, connection_health, configuration, enabled
           )
           VALUES ($1, 'lyrion', $2, 1, $3::jsonb, 'unconfigured', '{}'::jsonb, true)
           ON CONFLICT (workspace_id, provider_id, instance_key)
           DO UPDATE SET enabled = true, updated_at = now()
           RETURNING id`,
          [tenantId, input.instanceKey, JSON.stringify(capabilities)],
        );
        return result.rows[0]?.id ?? null;
      },
    );
    if (!identity) throw new ServiceUnavailableException('Lyrion provider instance could not be created.');

    const existingCredentials = await this.credentials.getCredentials({
      workspaceId: tenantId,
      providerInstanceId: identity,
      actorId,
      providerId: 'lyrion',
    });
    if (input.username && input.password) {
      await this.credentials.connect({
        workspaceId: tenantId,
        providerInstanceId: identity,
        actorId,
        providerId: 'lyrion',
        credentials: { username: input.username, password: input.password },
        requestedScopes: [],
        grantedScopes: [],
      });
    } else if (input.removeCredentials) {
      await this.credentials.disconnect({
        workspaceId: tenantId,
        providerInstanceId: identity,
        actorId,
        providerId: 'lyrion',
      });
    }
    const activeCredentials = input.removeCredentials
      ? null
      : input.username && input.password
        ? { username: input.username, password: input.password }
        : existingCredentials;

    const adapter = new LyrionPlaybackAdapter({
      baseUrl: input.baseUrl,
      playerId: input.playerId,
      ...(typeof activeCredentials?.username === 'string' && typeof activeCredentials.password === 'string'
        ? { username: activeCredentials.username, password: activeCredentials.password }
        : {}),
      mediaResolver: new YouTubeInvidiousMediaResolver(this.invidious),
      allowedHosts: (process.env.LYRION_ALLOWED_HOSTS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    });
    const health = await adapter.healthCheck();
    if (health.status !== 'healthy') {
      await this.database.transaction(
        { userId: actorId, verifiedWorkspaceId: tenantId as never },
        (client) => client.query(
          `UPDATE provider_instances
              SET connection_health = 'unavailable', configuration = $1::jsonb, updated_at = now()
            WHERE workspace_id = $2 AND id = $3`,
          [JSON.stringify({ baseUrl: input.baseUrl }), tenantId, identity],
        ),
      );
      throw new ServiceUnavailableException('Lyrion could not be reached or rejected the configured credentials.');
    }

    try {
      await this.database.transaction(
        { userId: actorId, verifiedWorkspaceId: tenantId as never },
        async (client) => {
          await client.query(
            `UPDATE provider_instances
                SET capabilities = $1::jsonb, configuration = $2::jsonb,
                    connection_health = 'healthy', enabled = true, updated_at = now()
              WHERE workspace_id = $3 AND id = $4 AND provider_id = 'lyrion'`,
            [JSON.stringify(capabilities), JSON.stringify({ baseUrl: input.baseUrl }), tenantId, identity],
          );
          await client.query(
            `INSERT INTO provider_output_assignments (
               workspace_id, provider_instance_id, output_id, player_id, assigned_by, active
             )
             VALUES ($1, $2, $3, $4, $5, true)
             ON CONFLICT (workspace_id, provider_instance_id) WHERE active = true
             DO UPDATE SET output_id = EXCLUDED.output_id, player_id = EXCLUDED.player_id,
                           assigned_by = EXCLUDED.assigned_by, updated_at = now()`,
            [tenantId, identity, input.outputId, input.playerId, actorId],
          );
        },
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new ConflictException('The selected Lyrion output or player is already assigned in this workspace.');
      }
      throw error;
    }

    return {
      providerInstanceId: identity,
      providerId: 'lyrion',
      outputId: input.outputId,
      playerId: input.playerId,
      connectionHealth: 'healthy',
      credentialsStored: Boolean(activeCredentials?.username && activeCredentials.password),
    };
  }

  @Delete('lyrion/:providerInstanceId')
  @UseGuards(CsrfGuard)
  async disconnect(
    @Req() request: HttpRequest,
    @Param('providerInstanceId') providerInstanceId: string,
  ) {
    const actorId = userId(request);
    const tenantId = workspaceId(request);
    const instance = await this.database.transaction(
      { userId: actorId, verifiedWorkspaceId: tenantId as never },
      (client) => client.query(
        `UPDATE provider_instances
            SET enabled = false, connection_health = 'unconfigured', updated_at = now()
          WHERE workspace_id = $1 AND id = $2 AND provider_id = 'lyrion'
          RETURNING id`,
        [tenantId, providerInstanceId],
      ),
    );
    if (instance.rowCount !== 1) throw new NotFoundException('Lyrion provider instance not found.');
    await this.credentials.disconnect({
      workspaceId: tenantId,
      providerInstanceId,
      actorId,
      providerId: 'lyrion',
    });
    return { disconnected: true, settingsPreserved: true };
  }
}
