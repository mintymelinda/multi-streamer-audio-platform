import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';

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

    const key = 'v1/' + (entityType === 'workspace' ? 'workspaces' : 'accounts') + '/' + entityId.toLowerCase() + '.json';
    const existing = await this.request(this.presign('HEAD', key), { method: 'HEAD' });
    if (existing.ok) return;
    if (existing.status !== 404) {
      throw new Error('Deletion ledger lookup failed (' + existing.status + ').');
    }

    const record = {
      format: 'multi-streamer-audio-platform.deletion-tombstone',
      version: 1,
      entityType,
      entityId: entityId.toLowerCase(),
      deletedAt: new Date().toISOString(),
    };
    const response = await this.request(this.presign('PUT', key, true), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' },
      body: JSON.stringify(record),
    });
    // Conditional creation makes concurrent/retried deletes idempotent.
    if (response.ok || response.status === 412) return;
    if (response.status === 409) {
      const retry = await this.request(this.presign('HEAD', key), { method: 'HEAD' });
      if (retry.ok) return;
    }
    throw new Error('Deletion ledger append failed (' + response.status + ').');
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
    const key = 'v1/credentials/' + normalizedId + '.json';
    const existing = await this.request(this.presign('HEAD', key), { method: 'HEAD' });
    if (existing.ok) return;
    if (existing.status !== 404) {
      throw new Error('Deletion ledger lookup failed (' + existing.status + ').');
    }
    const record = {
      format: 'multi-streamer-audio-platform.deletion-tombstone',
      version: 1,
      entityType: 'credential',
      entityId: normalizedId,
      workspaceId: workspaceId.toLowerCase(),
      providerInstanceId: providerInstanceId.toLowerCase(),
      deletedAt: new Date().toISOString(),
    };
    const response = await this.request(this.presign('PUT', key, true), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' },
      body: JSON.stringify(record),
    });
    if (response.ok || response.status === 412) return;
    if (response.status === 409) {
      const retry = await this.request(this.presign('HEAD', key), { method: 'HEAD' });
      if (retry.ok) return;
    }
    throw new Error('Deletion ledger credential append failed (' + response.status + ').');
  }

  private presign(method: 'PUT' | 'HEAD', key: string, conditional = false): string {
    const config = this.config;
    if (!config) throw new Error('Deletion ledger storage is not configured.');
    const endpoint = new URL(config.endpoint);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const scope = date + '/' + config.region + '/s3/aws4_request';
    const path = '/' + encode(config.bucket) + '/' + key.split('/').map(encode).join('/');
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': config.accessKey + '/' + scope,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': '60',
      'X-Amz-SignedHeaders': conditional ? 'content-type;host;if-none-match' : 'host',
    };
    const canonicalQuery = Object.entries(query)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, value]) => encode(name) + '=' + encode(value))
      .join('&');
    const canonicalHeaders = conditional
      ? 'content-type:application/json\nhost:' + endpoint.host + '\nif-none-match:*\n'
      : 'host:' + endpoint.host + '\n';
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
