import { createHash, createHmac } from 'node:crypto';

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function signingKey(secret, date, region) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), 's3'), 'aws4_request');
}

function signedRequest(config, method, key, body, contentType) {
  const endpoint = new URL(config.endpoint);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const scope = date + '/' + config.region + '/s3/aws4_request';
  const path = '/' + encode(config.bucket) + '/' + key.split('/').map(encode).join('/');
  const payloadHash = createHash('sha256').update(body).digest('hex');
  const canonicalHeadersMap = {
    host: endpoint.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (method === 'PUT') {
    canonicalHeadersMap['content-type'] = contentType;
    canonicalHeadersMap['if-none-match'] = '*';
  }
  const headerNames = Object.keys(canonicalHeadersMap).sort();
  const signedHeaders = headerNames.join(';');
  const canonicalHeaders = headerNames
    .map((name) => name + ':' + canonicalHeadersMap[name].trim() + '\n')
    .join('');
  const canonicalRequest = [
    method, path, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signature = createHmac('sha256', signingKey(config.secretKey, date, config.region))
    .update(stringToSign, 'utf8').digest('hex');
  const headers = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: 'AWS4-HMAC-SHA256 Credential=' + config.accessKey + '/' + scope
      + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
  };
  if (method === 'PUT') {
    headers['content-type'] = contentType;
    headers['if-none-match'] = '*';
  }
  return { url: endpoint.origin + path, headers };
}

export function createDeletionLedgerS3Client(options) {
  const {
    endpoint,
    bucket,
    accessKey,
    secretKey,
    region = 'us-east-1',
    allowInsecureHttp = false,
    nodeEnv = process.env.NODE_ENV,
    fetchImpl = fetch,
  } = options ?? {};
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error('Deletion ledger S3 endpoint, bucket, access key, and secret key are required.');
  }
  const parsed = new URL(endpoint);
  const localEndpoint = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !localEndpoint && !(allowInsecureHttp && nodeEnv !== 'production')) {
    throw new Error('Deletion ledger S3 storage must use HTTPS outside local development.');
  }
  const config = {
    endpoint: parsed.origin,
    bucket,
    accessKey,
    secretKey,
    region,
  };

  return {
    async putObject(key, value, contentType = 'application/octet-stream') {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const signed = signedRequest(config, 'PUT', key, body, contentType);
      const response = await fetchImpl(signed.url, {
        method: 'PUT',
        headers: signed.headers,
        body,
      });
      if (response.status === 412) {
        throw new Error('Deletion ledger export object already exists; refusing to overwrite an immutable artifact.');
      }
      if (!response.ok) {
        throw new Error('Deletion ledger S3 upload failed (' + response.status + ').');
      }
    },

    async getObject(key) {
      const signed = signedRequest(config, 'GET', key, Buffer.alloc(0));
      const response = await fetchImpl(signed.url, {
        method: 'GET',
        headers: signed.headers,
      });
      if (!response.ok) {
        throw new Error('Deletion ledger S3 download failed (' + response.status + ').');
      }
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
