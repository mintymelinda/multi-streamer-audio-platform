import { createHash, createHmac } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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

function hashEmpty() {
  return createHash('sha256').update(Buffer.alloc(0)).digest('hex');
}

function sameFileSnapshot(before, after) {
  return before.isFile() &&
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs;
}

async function readEncryptedArchiveHeader(file, fileStat) {
  const prefix = Buffer.alloc(12);
  const prefixRead = await file.read(prefix, 0, prefix.length, 0);
  if (
    prefixRead.bytesRead !== prefix.length ||
    !prefix.subarray(0, 8).equals(Buffer.from('MSAPBK01'))
  ) {
    throw new Error('Only platform-encrypted backup archives may be uploaded.');
  }
  const headerLength = prefix.readUInt32BE(8);
  if (headerLength < 2 || headerLength > 16 * 1024 || fileStat.size < 12 + headerLength) {
    throw new Error('Encrypted backup archive header is invalid.');
  }
  const headerBytes = Buffer.alloc(headerLength);
  const headerRead = await file.read(headerBytes, 0, headerLength, 12);
  if (headerRead.bytesRead !== headerLength) {
    throw new Error('Encrypted backup archive header is truncated.');
  }
  let header;
  try {
    header = JSON.parse(headerBytes.toString('utf8'));
  } catch {
    throw new Error('Encrypted backup archive metadata is invalid.');
  }
  if (
    header?.format !== 'multi-streamer-audio-platform.backup' ||
    header.version !== 1 ||
    header.algorithm !== 'aes-256-gcm' ||
    typeof header.keyId !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,64}$/.test(header.keyId) ||
    typeof header.context !== 'string' ||
    !header.context.trim() ||
    header.context.length > 1024 ||
    !/^[a-f0-9]{24}$/i.test(header.nonce ?? '') ||
    !/^[a-f0-9]{32}$/i.test(header.tag ?? '') ||
    !/^[a-f0-9]{64}$/i.test(header.sha256 ?? '') ||
    !Number.isSafeInteger(header.plaintextBytes) ||
    header.plaintextBytes < 0
  ) {
    throw new Error('Encrypted backup archive metadata is invalid.');
  }
}

function hashQuery(query = {}) {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [encode(key), encode(String(value))])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .map(([key, value]) => key + '=' + value)
    .join('&');
}

function signedRequest(config, method, key, options = {}) {
  const endpoint = new URL(config.endpoint);
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const path = basePath + '/' + encode(config.bucket)
    + (key ? '/' + key.split('/').map(encode).join('/') : '');
  const query = hashQuery(options.query);
  const url = endpoint.origin + path + (query ? '?' + query : '');
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const scope = date + '/' + config.region + '/s3/aws4_request';
  const payloadHash = options.payloadHash ?? hashEmpty();
  const canonicalHeadersMap = {
    host: endpoint.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(options.contentType ? { 'content-type': options.contentType } : {}),
    ...(options.ifNoneMatch ? { 'if-none-match': options.ifNoneMatch } : {}),
    ...(options.metadata ?? {}),
  };
  const headerNames = Object.keys(canonicalHeadersMap).sort();
  const signedHeaders = headerNames.join(';');
  const canonicalHeaders = headerNames
    .map((name) => name + ':' + canonicalHeadersMap[name].trim() + '\n')
    .join('');
  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signature = createHmac('sha256', signingKey(config.secretKey, date, config.region))
    .update(stringToSign, 'utf8').digest('hex');
  const headers = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: 'AWS4-HMAC-SHA256 Credential=' + config.accessKey + '/' + scope
      + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    ...(options.contentType ? { 'content-type': options.contentType } : {}),
    ...(options.ifNoneMatch ? { 'if-none-match': options.ifNoneMatch } : {}),
    ...(options.metadata ?? {}),
    ...(options.contentLength !== undefined ? { 'content-length': String(options.contentLength) } : {}),
  };
  return { url, headers };
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (entity, hex, decimal) => {
      const value = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      if (
        !Number.isInteger(value) ||
        value < 0 ||
        value > 0x10ffff ||
        (value >= 0xd800 && value <= 0xdfff)
      ) {
        return entity;
      }
      return String.fromCodePoint(value);
    })
    .replace(/&amp;/g, '&');
}

function readTag(xml, name) {
  const match = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return match ? decodeXml(match[1]) : null;
}

function listResult(xml) {
  const contents = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = readTag(match[1], 'Key');
    if (key !== null) {
      contents.push({
        key,
        size: Number(readTag(match[1], 'Size') ?? 0),
        etag: (readTag(match[1], 'ETag') ?? '').replace(/^"|"$/g, ''),
        lastModified: readTag(match[1], 'LastModified'),
      });
    }
  }
  return {
    contents,
    isTruncated: readTag(xml, 'IsTruncated') === 'true',
    nextContinuationToken: readTag(xml, 'NextContinuationToken'),
  };
}

export function createPlatformBackupS3Client(options) {
  const {
    endpoint,
    bucket,
    accessKey,
    secretKey,
    region = 'us-east-1',
    allowInsecureHttp = false,
    allowPlaintextRestore = false,
    nodeEnv = process.env.NODE_ENV,
    fetchImpl = fetch,
  } = options ?? {};
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error('Backup S3 endpoint, bucket, access key, and secret key are required.');
  }
  const parsed = new URL(endpoint);
  const localEndpoint = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    || parsed.hostname === 'object-storage';
  if (parsed.protocol !== 'https:' && !(localEndpoint && nodeEnv !== 'production')
    && !(allowInsecureHttp && nodeEnv !== 'production')) {
    throw new Error('Backup S3 storage must use HTTPS outside local development.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Backup S3 endpoint must not contain credentials, a query, or a fragment.');
  }
  const config = { endpoint: parsed.origin + parsed.pathname, bucket, accessKey, secretKey, region };

  async function request(method, key, options = {}) {
    const signed = signedRequest(config, method, key, options);
    // This outbound file transfer is intentional: putFile validates a private AES-GCM archive
    // before it reaches this transport, and this client rejects redirects and non-TLS endpoints.
    return fetchImpl(signed.url, {
      method,
      redirect: 'error',
      headers: signed.headers,
      ...(options.body !== undefined ? { body: options.body, duplex: 'half' } : {}),
    });
  }

  async function headObject(key) {
    const response = await request('HEAD', key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Backup S3 metadata request failed (' + response.status + ').');
    return {
      contentLength: Number(response.headers.get('content-length') ?? 0),
      contentType: response.headers.get('content-type'),
      contentSha256: response.headers.get('x-amz-meta-content-sha256'),
      plaintextSha256: response.headers.get('x-amz-meta-plaintext-sha256'),
      etag: (response.headers.get('etag') ?? '').replace(/^"|"$/g, ''),
    };
  }

  async function putFile(key, filePath, options = {}) {
    if (typeof constants.O_NOFOLLOW !== 'number') {
      throw new Error('Secure no-follow archive opening is unavailable on this platform.');
    }
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n) {
        throw new Error('Backup archives must be regular, singly linked private files.');
      }
      await readEncryptedArchiveHeader(file, before);

      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      const details = { sha256: hash.digest('hex'), bytes };
      const afterDigest = await file.stat({ bigint: true });
      if (!sameFileSnapshot(before, afterDigest) || bytes !== Number(before.size)) {
        throw new Error('Encrypted backup archive changed while its upload digest was being calculated.');
      }

      const metadata = {
        ...(options.metadata ?? {}),
        'x-amz-meta-content-sha256': details.sha256,
      };
      // This is the intentional off-site backup transfer: only the encrypted archive format above
      // is sent, to the operator-configured S3 endpoint, with redirects disabled.
      const response = await request('PUT', key, {
        payloadHash: details.sha256,
        contentType: options.contentType ?? 'application/octet-stream',
        contentLength: Number(before.size),
        ifNoneMatch: options.immutable === false ? undefined : '*',
        metadata,
        body: file.createReadStream({ start: 0, autoClose: false }),
      });
      const afterUpload = await file.stat({ bigint: true });
      if (!sameFileSnapshot(before, afterUpload)) {
        throw new Error('Encrypted backup archive changed while it was being uploaded.');
      }
      if (response.status === 412 || response.status === 409) {
        const existing = await headObject(key);
        if (existing?.contentSha256 === details.sha256) return { ...details, alreadyPresent: true };
        throw new Error('Backup object already exists with different content; refusing to overwrite it.');
      }
      if (!response.ok) throw new Error('Backup S3 upload failed (' + response.status + ').');
      return { ...details, alreadyPresent: false };
    } finally {
      await file.close();
    }
  }

  async function putRestoredFile(key, filePath, options = {}) {
    if (!allowPlaintextRestore) {
      throw new Error('Plaintext object restore uploads are disabled for this S3 client.');
    }
    if (typeof constants.O_NOFOLLOW !== 'number') {
      throw new Error('Secure no-follow restored-file opening is unavailable on this platform.');
    }

    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n) {
        throw new Error('Restored objects must be regular, singly linked private files.');
      }
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Restored object exceeds the supported upload size.');
      }

      const contentType = options.contentType ?? 'application/octet-stream';
      if (
        typeof contentType !== 'string' ||
        contentType.length > 255 ||
        /[\r\n]/.test(contentType)
      ) {
        throw new Error('Restored object Content-Type is invalid.');
      }

      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      const details = { sha256: hash.digest('hex'), bytes };
      const afterDigest = await file.stat({ bigint: true });
      if (!sameFileSnapshot(before, afterDigest) || bytes !== Number(before.size)) {
        throw new Error('Restored object changed while its upload digest was being calculated.');
      }

      // Intentional restore transfer: this operation is only enabled on the separately configured
      // recovery-bucket client and uploads bytes only after authenticated archive decryption.
      const response = await request('PUT', key, {
        payloadHash: details.sha256,
        contentType,
        contentLength: Number(before.size),
        ifNoneMatch: '*',
        metadata: { 'x-amz-meta-content-sha256': details.sha256 },
        body: file.createReadStream({ start: 0, autoClose: false }),
      });
      const afterUpload = await file.stat({ bigint: true });
      if (!sameFileSnapshot(before, afterUpload)) {
        throw new Error('Restored object changed while it was being uploaded.');
      }
      if (response.status === 412 || response.status === 409) {
        throw new Error('Restore target object already exists; use a new empty recovery bucket.');
      }
      if (!response.ok) {
        throw new Error('Restored object upload failed (' + response.status + ').');
      }
      return { ...details, alreadyPresent: false };
    } finally {
      await file.close();
    }
  }

  async function putObject(key, value, options = {}) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const response = await request('PUT', key, {
      payloadHash: sha256,
      contentType: options.contentType ?? 'application/json',
      contentLength: body.length,
      ifNoneMatch: options.immutable === false ? undefined : '*',
      metadata: { ...(options.metadata ?? {}), 'x-amz-meta-content-sha256': sha256 },
      body,
    });
    if (response.status === 412 || response.status === 409) {
      const existing = await headObject(key);
      if (existing?.contentSha256 === sha256) return { sha256, alreadyPresent: true };
      throw new Error('Backup object already exists with different content; refusing to overwrite it.');
    }
    if (!response.ok) throw new Error('Backup S3 upload failed (' + response.status + ').');
    return { sha256, alreadyPresent: false };
  }

  async function getFile(key, destinationPath) {
    const response = await request('GET', key);
    if (!response.ok || !response.body) {
      throw new Error('Backup S3 download failed (' + response.status + ').');
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 }),
    );
    return {
      contentLength: Number(response.headers.get('content-length') ?? 0),
      contentSha256: response.headers.get('x-amz-meta-content-sha256'),
      plaintextSha256: response.headers.get('x-amz-meta-plaintext-sha256'),
      contentType: response.headers.get('content-type'),
    };
  }

  async function getObject(key) {
    const response = await request('GET', key);
    if (!response.ok) throw new Error('Backup S3 download failed (' + response.status + ').');
    return Buffer.from(await response.arrayBuffer());
  }

  async function listObjects({ prefix = '', continuationToken } = {}) {
    const response = await request('GET', '', {
      query: {
        'list-type': 2,
        prefix,
        'continuation-token': continuationToken,
      },
    });
    if (!response.ok) throw new Error('Backup S3 listing failed (' + response.status + ').');
    return listResult(await response.text());
  }

  return { getFile, getObject, headObject, listObjects, putFile, putObject, putRestoredFile };
}
