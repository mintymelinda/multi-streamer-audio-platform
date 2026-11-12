import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseContext } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  loadIntegrationKeyRing,
} from '../security/integration-credential-crypto.js';
import { ProviderScopePolicyService } from './provider-scope-policy.service.js';

export interface ProviderCredentialCrypto {
  encrypt(
    value: string,
    context: { workspaceId: string; providerId: string; credentialId: string },
  ): Promise<{
    ciphertext: string;
    nonce: string;
    authTag: string;
    wrappedDek?: string;
    dekNonce?: string;
    dekAuthTag?: string;
    kekVersion?: string;
  }>;
  decrypt(
    value: {
      ciphertext: string;
      nonce: string;
      authTag: string;
      wrappedDek?: string;
      dekNonce?: string;
      dekAuthTag?: string;
      kekVersion?: string;
    },
    context: { workspaceId: string; providerId: string; credentialId: string },
  ): Promise<string>;
}

export interface ProviderCredentialRevoker {
  revoke(input: {
    providerId: string;
    credentials: Record<string, unknown>;
  }): Promise<{ revoked: boolean }>;
}

export interface ProviderCredentialAudit {
  append(
    client: PoolClient,
    event: {
      workspaceId: string;
      actorId: string;
      eventType: string;
      providerInstanceId: string;
      details?: Record<string, unknown>;
    },
  ): Promise<unknown>;
}

export interface ProviderIntegrationDataStore {
  removeSettings(workspaceId: string, providerInstanceId: string): Promise<void>;
  removeCache(workspaceId: string, providerInstanceId: string): Promise<void>;
}

interface CredentialRow {
  id?: string;
  ciphertext: string;
  nonce: string;
  authTag?: string;
  auth_tag?: string;
  wrappedDek?: string;
  wrapped_dek?: string;
  dekNonce?: string;
  dek_nonce?: string;
  dekAuthTag?: string;
  dek_auth_tag?: string;
  kekVersion?: string;
  kek_version?: string;
}

@Injectable()
export class ProviderCredentialsService {
  private integrationDataStore: ProviderIntegrationDataStore | undefined;
  private readonly credentialIds = new Map<string, string>();

  constructor(
    @Inject(DatabaseService)
    private readonly database: Pick<DatabaseService, 'transaction'>,
    private readonly crypto: ProviderCredentialCrypto = productionCredentialCrypto(),
    private readonly revoker: ProviderCredentialRevoker = {
      revoke: async () => ({ revoked: false }),
    },
    private readonly audit: ProviderCredentialAudit = { append: async () => undefined },
    private readonly scopes = new ProviderScopePolicyService(),
  ) {}

  setIntegrationDataStore(store: ProviderIntegrationDataStore): void {
    this.integrationDataStore = store;
  }

  async connect(input: {
    workspaceId: string;
    providerInstanceId: string;
    actorId: string;
    providerId?: string;
    credentials: Record<string, unknown>;
    requestedScopes: string[];
    grantedScopes: string[];
    expiresAt?: Date | string | null;
  }): Promise<{ credentialId: string; status: 'connected'; grantedScopes: string[] }> {
    this.assertIdentity(input);
    const providerId = input.providerId ?? inferProviderId(input.providerInstanceId);
    const validation = this.scopes.validateGrantedScopes({
      providerId,
      requestedScopes: input.requestedScopes,
      grantedScopes: input.grantedScopes,
    });
    if (!validation.valid) throw new Error('Provider granted scopes exceed the approved request.');
    const credentialId = randomUUID();
    const envelope = await this.crypto.encrypt(JSON.stringify(input.credentials), {
      workspaceId: input.workspaceId,
      providerId,
      credentialId,
    });
    const context: DatabaseContext = {
      userId: input.actorId,
      verifiedWorkspaceId: input.workspaceId as never,
    };
    await this.database.transaction(context, async (client) => {
      await client.query(
        "INSERT INTO provider_credentials (id, workspace_id, provider_instance_id, ciphertext, nonce, auth_tag, wrapped_dek, dek_nonce, dek_auth_tag, kek_version, format_version, granted_scopes, status, expires_at, connected_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,'connected',$12,now(),now()) ON CONFLICT (workspace_id, provider_instance_id) DO UPDATE SET id = EXCLUDED.id, ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag, wrapped_dek = EXCLUDED.wrapped_dek, dek_nonce = EXCLUDED.dek_nonce, dek_auth_tag = EXCLUDED.dek_auth_tag, kek_version = EXCLUDED.kek_version, format_version = EXCLUDED.format_version, granted_scopes = EXCLUDED.granted_scopes, status = 'connected', expires_at = EXCLUDED.expires_at, connected_at = now(), updated_at = now(), disconnected_at = NULL",
        [
          credentialId,
          input.workspaceId,
          input.providerInstanceId,
          envelope.ciphertext,
          envelope.nonce,
          envelope.authTag,
          envelope.wrappedDek ?? '',
          envelope.dekNonce ?? '',
          envelope.dekAuthTag ?? '',
          envelope.kekVersion ?? 'injected',
          input.grantedScopes,
          input.expiresAt ?? null,
        ],
      );
      await this.audit.append(client, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        eventType: 'provider.connected',
        providerInstanceId: input.providerInstanceId,
        details: { providerId, grantedScopes: input.grantedScopes },
      });
    });
    this.credentialIds.set(
      this.instanceKey(input.workspaceId, input.providerInstanceId),
      credentialId,
    );
    return { credentialId, status: 'connected', grantedScopes: [...input.grantedScopes] };
  }

  async getCredentials(input: {
    workspaceId: string;
    providerInstanceId: string;
    actorId: string;
    providerId?: string;
  }): Promise<Record<string, unknown> | null> {
    this.assertIdentity(input);
    return this.database.transaction(
      { userId: input.actorId, verifiedWorkspaceId: input.workspaceId as never },
      async (client) => {
        const knownId = this.credentialIds.get(
          this.instanceKey(input.workspaceId, input.providerInstanceId),
        );
        const result = knownId
          ? await client.query<CredentialRow>(
              "SELECT * FROM provider_credentials WHERE id = $1 AND workspace_id = $2 AND provider_instance_id = $3 AND status = 'connected'",
              [knownId, input.workspaceId, input.providerInstanceId],
            )
          : await client.query<CredentialRow>(
              "SELECT * FROM provider_credentials WHERE workspace_id = $1 AND provider_instance_id = $2 AND status = 'connected'",
              [input.workspaceId, input.providerInstanceId],
            );
        const row = result.rows[0];
        if (!row) return null;
        const providerId = input.providerId ?? inferProviderId(input.providerInstanceId);
        const plaintext = await this.crypto.decrypt(
          {
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            authTag: row.authTag ?? row.auth_tag ?? '',
            wrappedDek: row.wrappedDek ?? row.wrapped_dek ?? '',
            dekNonce: row.dekNonce ?? row.dek_nonce ?? '',
            dekAuthTag: row.dekAuthTag ?? row.dek_auth_tag ?? '',
            kekVersion: row.kekVersion ?? row.kek_version ?? 'injected',
          },
          {
            workspaceId: input.workspaceId,
            providerId,
            credentialId: row.id ?? knownId ?? '',
          },
        );
        return JSON.parse(plaintext) as Record<string, unknown>;
      },
    );
  }

  async disconnect(input: {
    workspaceId: string;
    providerInstanceId: string;
    actorId: string;
    providerId?: string;
  }): Promise<void> {
    this.assertIdentity(input);
    const credentials = await this.getCredentials(input);
    if (credentials) {
      const revoked = await this.revoker.revoke({
        providerId: input.providerId ?? inferProviderId(input.providerInstanceId),
        credentials,
      });
      if (!revoked.revoked)
        throw new Error('Provider authorization revocation could not be confirmed.');
    }
    await this.database.transaction(
      { userId: input.actorId, verifiedWorkspaceId: input.workspaceId as never },
      async (client) => {
        const knownId = this.credentialIds.get(
          this.instanceKey(input.workspaceId, input.providerInstanceId),
        );
        if (knownId) {
          await client.query(
            'DELETE FROM provider_credentials WHERE id = $1 AND workspace_id = $2',
            [knownId, input.workspaceId],
          );
        } else {
          await client.query(
            'DELETE FROM provider_credentials WHERE workspace_id = $1 AND provider_instance_id = $2',
            [input.workspaceId, input.providerInstanceId],
          );
        }
        await this.audit.append(client, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          eventType: 'provider.disconnected',
          providerInstanceId: input.providerInstanceId,
        });
      },
    );
    this.credentialIds.delete(this.instanceKey(input.workspaceId, input.providerInstanceId));
  }

  async disconnectAndRemoveData(input: {
    workspaceId: string;
    providerInstanceId: string;
    actorId: string;
    providerId?: string;
  }): Promise<void> {
    await this.disconnect(input);
    if (this.integrationDataStore) {
      await this.integrationDataStore.removeSettings(input.workspaceId, input.providerInstanceId);
      await this.integrationDataStore.removeCache(input.workspaceId, input.providerInstanceId);
    }
  }

  async markAuthorizationExpired(input: {
    workspaceId: string;
    providerInstanceId: string;
    actorId: string;
  }): Promise<void> {
    this.assertIdentity(input);
    await this.database.transaction(
      { userId: input.actorId, verifiedWorkspaceId: input.workspaceId as never },
      async (client) => {
        await client.query(
          "UPDATE provider_credentials SET status = 'authorization_expired', updated_at = now() WHERE workspace_id = $1 AND provider_instance_id = $2",
          [input.workspaceId, input.providerInstanceId],
        );
        await this.audit.append(client, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          eventType: 'provider.authorization_expired',
          providerInstanceId: input.providerInstanceId,
        });
      },
    );
  }

  private assertIdentity(input: {
    workspaceId: string;
    providerInstanceId: string;
    actorId: string;
  }): void {
    if (!input.workspaceId.trim() || !input.providerInstanceId.trim() || !input.actorId.trim()) {
      throw new TypeError('Workspace, provider instance, and actor identity are required.');
    }
  }

  private instanceKey(workspaceId: string, providerInstanceId: string): string {
    return `${workspaceId}:${providerInstanceId}`;
  }
}

function inferProviderId(instanceId: string): string {
  const prefix = instanceId.split(/[._-]/, 1)[0]?.toLowerCase();
  return ['youtube', 'spotify', 'lyrion'].includes(prefix ?? '') ? (prefix as string) : 'spotify';
}

function productionCredentialCrypto(): ProviderCredentialCrypto {
  return {
    encrypt: async (value, context) =>
      encryptIntegrationCredentials(
        value,
        {
          workspaceId: context.workspaceId,
          provider: context.providerId,
          credentialId: context.credentialId,
        },
        loadIntegrationKeyRing(),
      ),
    decrypt: async (value, context) => {
      if (!value.wrappedDek || !value.dekNonce || !value.dekAuthTag || !value.kekVersion) {
        throw new Error('Credential envelope is incomplete.');
      }
      return decryptIntegrationCredentials(
        {
          formatVersion: 1,
          ciphertext: value.ciphertext,
          nonce: value.nonce,
          authTag: value.authTag,
          wrappedDek: value.wrappedDek,
          dekNonce: value.dekNonce,
          dekAuthTag: value.dekAuthTag,
          kekVersion: value.kekVersion,
        },
        {
          workspaceId: context.workspaceId,
          provider: context.providerId,
          credentialId: context.credentialId,
        },
        loadIntegrationKeyRing(),
      );
    },
  };
}
