import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPlatformBackupS3Client } from '../lib/platform-backup-s3.mjs';

const baseOptions = {
  endpoint: 'https://objects.example.test',
  bucket: 'platform-backups',
  accessKey: 'test-access',
  secretKey: 'test-secret',
  region: 'us-east-1',
};

async function withTemporaryDirectory(action) {
  const directory = await mkdtemp(join(tmpdir(), 'platform-backup-s3-test-'));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function encryptedArchiveFixture(plainText = 'encrypted archive payload') {
  const plaintext = Buffer.from(plainText);
  const header = Buffer.from(JSON.stringify({
    format: 'multi-streamer-audio-platform.backup',
    version: 1,
    algorithm: 'aes-256-gcm',
    keyId: 'test-key',
    context: 'test:fixture',
    nonce: '0'.repeat(24),
    tag: '0'.repeat(32),
    sha256: createHash('sha256').update(plaintext).digest('hex'),
    plaintextBytes: plaintext.length,
  }));
  const prefix = Buffer.alloc(12);
  Buffer.from('MSAPBK01').copy(prefix);
  prefix.writeUInt32BE(header.length, 8);
  return Buffer.concat([prefix, header, Buffer.from('ciphertext-fixture')]);
}

test('streams only private encrypted backup archives to immutable S3 objects', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'archive.msapbk');
    const body = encryptedArchiveFixture();
    await writeFile(sourcePath, body, { mode: 0o600 });
    let captured;
    const client = createPlatformBackupS3Client({
      ...baseOptions,
      fetchImpl: async (url, options) => {
        const chunks = [];
        for await (const chunk of options.body) chunks.push(chunk);
        captured = { url: String(url), options, body: Buffer.concat(chunks) };
        return new Response(null, { status: 200 });
      },
    });

    const result = await client.putFile('postgres/daily/archive.msapbk', sourcePath, {
      metadata: { 'x-amz-meta-backup-id': 'backup-001' },
    });

    assert.equal(result.bytes, body.length);
    assert.equal(result.sha256, createHash('sha256').update(body).digest('hex'));
    assert.deepEqual(captured.body, body);
    assert.equal(captured.options.method, 'PUT');
    assert.equal(captured.options.duplex, 'half');
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.headers['if-none-match'], '*');
    assert.equal(captured.options.headers['x-amz-meta-content-sha256'], result.sha256);
    assert.equal(captured.options.headers['x-amz-meta-backup-id'], 'backup-001');
    assert.match(captured.options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=test-access\//);
    assert.equal(captured.url.includes('test-secret'), false);
  });
});

test('refuses to send a local file that is not a platform-encrypted archive', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'secrets.msapbk');
    await writeFile(sourcePath, Buffer.from('raw credential data'), { mode: 0o600 });
    let requests = 0;
    const client = createPlatformBackupS3Client({
      ...baseOptions,
      fetchImpl: async () => {
        requests += 1;
        return new Response(null, { status: 200 });
      },
    });
    await assert.rejects(
      client.putFile('postgres/archive.msapbk', sourcePath),
      /Only platform-encrypted backup archives may be uploaded/,
    );
    assert.equal(requests, 0);
  });
});

test('rejects credentials embedded in the S3 endpoint URL', () => {
  assert.throws(
    () => createPlatformBackupS3Client({
      ...baseOptions,
      endpoint: 'https://access:secret@objects.example.test',
    }),
    /must not contain credentials/,
  );
});


test('treats identical ciphertext as a successful retry even when plaintext metadata differs, but rejects collisions', async () => {
  const body = Buffer.from('wal segment');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const client = createPlatformBackupS3Client({
    ...baseOptions,
    fetchImpl: async (_url, options) => {
      if (options.method === 'PUT') return new Response(null, { status: 412 });
      return new Response(null, {
        status: 200,
        headers: { 'x-amz-meta-content-sha256': sha256, 'x-amz-meta-plaintext-sha256': 'plaintext-digest' },
      });
    },
  });
  assert.deepEqual(
    await client.putObject('wal/000000010000000000000001.msapbk', body),
    { sha256, alreadyPresent: true },
  );

  const collision = createPlatformBackupS3Client({
    ...baseOptions,
    fetchImpl: async (_url, options) => {
      if (options.method === 'PUT') return new Response(null, { status: 412 });
      return new Response(null, {
        status: 200,
        headers: { 'x-amz-meta-content-sha256': '0'.repeat(64), 'x-amz-meta-plaintext-sha256': '0'.repeat(64) },
      });
    },
  });
  await assert.rejects(collision.putObject('wal/000000010000000000000001.msapbk', body), /different content/);
});

test('paginates object listings and decodes XML object keys', async () => {
  const requests = [];
  const client = createPlatformBackupS3Client({
    ...baseOptions,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), method: options.method });
      return new Response(
        '<?xml version="1.0"?><ListBucketResult><Contents><Key>assets/a&amp;b&#x2F;&#233;.png</Key><Size>12</Size><ETag>"abc"</ETag><LastModified>2026-11-12T00:00:00.000Z</LastModified></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>token&amp;next</NextContinuationToken></ListBucketResult>',
        { status: 200, headers: { 'Content-Type': 'application/xml' } },
      );
    },
  });
  const result = await client.listObjects({ prefix: 'assets/', continuationToken: 'token one' });
  assert.deepEqual(result, {
    contents: [{
      key: 'assets/a&b/é.png',
      size: 12,
      etag: 'abc',
      lastModified: '2026-11-12T00:00:00.000Z',
    }],
    isTruncated: true,
    nextContinuationToken: 'token&next',
  });
  assert.equal(requests[0].method, 'GET');
  assert.match(requests[0].url, /continuation-token=token%20one/);
  assert.match(requests[0].url, /list-type=2/);
});

test('streams downloaded objects to new private files', async () => {
  await withTemporaryDirectory(async (directory) => {
    const destinationPath = join(directory, 'restored-object.bin');
    const body = Buffer.from('restored object');
    const client = createPlatformBackupS3Client({
      ...baseOptions,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: {
          'content-length': String(body.length),
          'x-amz-meta-plaintext-sha256': createHash('sha256').update(body).digest('hex'),
        },
      }),
    });
    const result = await client.getFile('objects/snapshot/object.msapbk', destinationPath);
    assert.equal(result.contentLength, body.length);
    assert.deepEqual(await readFile(destinationPath), body);
    await assert.rejects(client.getFile('objects/snapshot/object.msapbk', destinationPath), /EEXIST/);
  });
});

test('requires HTTPS outside local development', () => {
  assert.throws(
    () => createPlatformBackupS3Client({
      ...baseOptions,
      endpoint: 'http://objects.example.test',
    }),
    /must use HTTPS/,
  );
  assert.doesNotThrow(
    () => createPlatformBackupS3Client({
      ...baseOptions,
      endpoint: 'http://localhost:9000',
      allowInsecureHttp: true,
      nodeEnv: 'development',
    }),
  );
  assert.throws(
    () => createPlatformBackupS3Client({
      ...baseOptions,
      endpoint: 'http://localhost:9000',
      allowInsecureHttp: true,
      nodeEnv: 'production',
    }),
    /must use HTTPS/,
  );
});
