import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hmac(key: Buffer | string, value: string, encoding?: 'hex'): Buffer | string {
  return createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, date) as Buffer;
  const regionKey = hmac(dateKey, region) as Buffer;
  const serviceKey = hmac(regionKey, 's3') as Buffer;
  return hmac(serviceKey, 'aws4_request') as Buffer;
}

export interface ObjectStorageConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

@Injectable()
export class ObjectStorageService {
  private readonly config: ObjectStorageConfig;

  constructor() {
    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
    const bucket = process.env.OBJECT_STORAGE_BUCKET;
    const accessKey = process.env.OBJECT_STORAGE_ACCESS_KEY;
    const secretKey = process.env.OBJECT_STORAGE_SECRET_KEY;
    if (!endpoint || !bucket || !accessKey || !secretKey) {
      throw new Error('Object storage is not configured. Set OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY, and OBJECT_STORAGE_SECRET_KEY.');
    }
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new Error('Object storage must use HTTPS outside local development.');
    }
    this.config = { endpoint: parsed.origin, bucket, accessKey, secretKey, region: process.env.OBJECT_STORAGE_REGION ?? 'us-east-1' };
  }

  presign(method: 'PUT' | 'GET' | 'HEAD', key: string, contentType?: string, expiresSeconds = 600): string {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${this.config.region}/s3/aws4_request`;
    const endpoint = new URL(this.config.endpoint);
    const path = `/${awsEncode(this.config.bucket)}/${key.split('/').map(awsEncode).join('/')}`;
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKey}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': contentType && method === 'PUT' ? 'content-type;host' : 'host',
    };
    const canonicalQuery = Object.entries(query)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
      .join('&');
    const signedHeaders = query['X-Amz-SignedHeaders'];
    const canonicalHeaders = contentType && method === 'PUT'
      ? `content-type:${contentType.trim()}\nhost:${endpoint.host}\n`
      : `host:${endpoint.host}\n`;
    const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const signature = hmac(signingKey(this.config.secretKey, date, this.config.region), stringToSign, 'hex') as string;
    return `${this.config.endpoint}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async delete(key: string): Promise<void> {
    const response = await fetch(this.presign('GET', key, undefined, 60), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error(`Object storage delete failed (${response.status}).`);
  }
}
