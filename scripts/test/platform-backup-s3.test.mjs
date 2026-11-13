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

test('streams immutable file uploads and signs the plaintext integrity metadata', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'archive.msapbk');
    const body = Buffer.from('encrypted archive payload');
    await writeFile(sourcePath, body);
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
    assert.equal(captured.options.headers['if-none-match'], '*');
    assert.equal(captured.options.headers['x-amz-meta-plaintext-sha256'], result.sha256);
    assert.equal(captured.options.headers['x-amz-meta-backup-id'], 'backup-001');
    assert.match(captured.options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=test-access\//);
    assert.equal(captured.url.includes('test-secret'), false);
  });
});

test('treats an identical immutable object as a successful retry but rejects content collisions', async () => {
  const body = Buffer.from('wal segment');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const client = createPlatformBackupS3Client({
    ...baseOptions,
    fetchImpl: async (_url, options) => {
      if (options.method === 'PUT') return new Response(null, { status: 412 });
      return new Response(null, {
        status: 200,
        headers: { 'x-amz-meta-plaintext-sha256': sha256 },
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
        headers: { 'x-amz-meta-plaintext-sha256': '0'.repeat(64) },
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
        '<?xml version="1.0"?><ListBucketResult><Contents><Key>assets/a&amp;b.png</Key><Size>12</Size><ETag>"abc"</ETag><LastModified>2026-11-12T00:00:00.000Z</LastModified></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>token&amp;next</NextContinuationToken></ListBucketResult>',
        { status: 200, headers: { 'Content-Type': 'application/xml' } },
      );
    },
  });
  const result = await client.listObjects({ prefix: 'assets/', continuationToken: 'token one' });
  assert.deepEqual(result, {
    contents: [{
      key: 'assets/a&b.png',
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
