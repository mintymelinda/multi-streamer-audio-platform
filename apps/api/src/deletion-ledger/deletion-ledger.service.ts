import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, createHmac, randomUUID } from 'node:crypto';

export type DeletionEntityType = 'account' | 'workspace';

interface LedgerConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), 's3'), 'aws4_request');
}

@Injectable()
export class DeletionLedgerService {
  private readonly config: LedgerConfig | null;
  private readonly request: typeof fetch;

  constructor(@Optional() @Inject('DELETION_LEDGER_FETCH') request?: typeof fetch) {
    this.request = request ?? fetch;
    const endpoint = process.env.DELETION_LEDGER_INTERNAL_ENDPOINT
      ?? process.env.DELETION_LEDGER_ENDPOINT;
    const bucket = process.env.DELETION_LEDGER_BUCKET;
    const accessKey = process.env.DELETION_LEDGER_ACCESS_KEY;
    const secretKey = process.env.DELETION_LEDGER_SECRET_KEY;
    if (!endpoint || !bucket || !accessKey || !secretKey) {
      this.config = null;
      return;
    }
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new Error('Deletion ledger storage must use HTTPS outside local development.');
    }
    this.config = {
      endpoint: parsed.origin,
      bucket,
      accessKey,
      secretKey,
      region: process.env.DELETION_LEDGER_REGION ?? 'us-east-1',
    };
  }

  async append(entityType: DeletionEntityType, entityId: string): Promise<void> {
    if (!this.config) {
      throw new Error('Permanent deletion is disabled because the independent deletion ledger is not configured.');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entityId)) {
      throw new TypeError('Deletion ledger entity ID must be a UUID.');
    }
    const normalizedId = entityId.toLowerCase();
    const eventId = randomUUID();
    const key = 'v1/' + (entityType === 'workspace' ? 'workspaces' : 'accounts') + '/' + normalizedId + '/' + eventId + '.json';
    const record = {
      format: 'multi-streamer-audio-platform.deletion-tombstone',
      version: 1,
      entityType,
      entityId: normalizedId,
      eventId,
      deletedAt: new Date().toISOString(),
    };
    await this.putRecord(key, record, 'deletion ledger append');
  }

  async appendCredential(credentialId: string, workspaceId: string, providerInstanceId: string): Promise<void> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!this.config) {
      throw new Error('Permanent credential revocation is disabled because the independent deletion ledger is not configured.');
    }
    if (!uuid.test(credentialId) || !uuid.test(workspaceId) || !uuid.test(providerInstanceId)) {
      throw new TypeError('Credential tombstones require valid credential, workspace, and provider instance UUIDs.');
    }
    const normalizedId = credentialId.toLowerCase();
    const eventId = randomUUID();
    const key = 'v1/credentials/' + normalizedId + '/' + eventId + '.json';
    const record = {
      format: 'multi-streamer-audio-platform.deletion-tombstone',
      version: 1,
      entityType: 'credential',
      entityId: normalizedId,
      workspaceId: workspaceId.toLowerCase(),
      providerInstanceId: providerInstanceId.toLowerCase(),
      eventId,
      deletedAt: new Date().toISOString(),
    };
    await this.putRecord(key, record, 'deletion ledger credential append');
  }

  async appendMembershipRevocation(workspaceId: string, userId: string, revokedAt: Date | string): Promise<void> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!this.config) {
      throw new Error('Access revocation is disabled because the independent deletion ledger is not configured.');
    }
    if (!uuid.test(workspaceId) || !uuid.test(userId)) {
      throw new TypeError('Membership tombstones require valid workspace and user UUIDs.');
    }
    const timestamp = new Date(revokedAt);
    if (Number.isNaN(timestamp.getTime())) throw new TypeError('Membership revocation timestamp is invalid.');
    const eventId = randomUUID();
    const normalizedWorkspace = workspaceId.toLowerCase();
    const normalizedUser = userId.toLowerCase();
    const key = 'v1/membership-revocations/' + normalizedWorkspace + '/' + normalizedUser + '/' + eventId + '.json';
    const record = {
      format: 'multi-streamer-audio-platform.deletion-tombstone',
      version: 1,
      entityType: 'membership_revocation',
      entityId: normalizedUser,
      workspaceId: normalizedWorkspace,
      eventId,
      revokedAt: timestamp.toISOString(),
      deletedAt: timestamp.toISOString(),
    };
    await this.putRecord(key, record, 'deletion ledger membership append');
  }

  private async putRecord(key: string, record: Record<string, unknown>, description: string): Promise<void> {
    const response = await this.request(this.presign('PUT', key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' },
      body: JSON.stringify(record),
    });
    // A conditional conflict means this exact immutable event key already exists.
    if (response.ok || response.status === 412) return;
    throw new Error(description + ' failed (' + response.status + ').');
  }

256',
      'X-Amz-Credential': config.accessKey + '/' + scope,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': '60',
      'X-Amz-SignedHeaders': 'content-type;host;if-none-match',
    };
    const canonicalQuery = Object.entries(query)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, value]) => encode(name) + '=' + encode(value))
      .join('&');
    const canonicalHeaders = 'content-type:application/json\nhost:' + endpoint.host + '\nif-none-match:*\n';
    const canonicalRequest = [
      method, path, canonicalQuery, canonicalHeaders, query['X-Amz-SignedHeaders'], 'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signature = createHmac('sha256', signingKey(config.secretKey, date, config.region))
      .update(stringToSign, 'utf8').digest('hex');
    return endpoint.origin + path + '?' + canonicalQuery + '&X-Amz-Signature=' + signature;
  }
}
