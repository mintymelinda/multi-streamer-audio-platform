import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { link, open, readFile, rm, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('MSAPBK01');
const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 16 * 1024;
const FORMAT = 'multi-streamer-audio-platform.backup';
const VERSION = 1;

async function readProtectedKeyFile(filePath, { encoding, expectedBytes, maximumBytes }) {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('Secure no-follow file opening is unavailable on this platform.');
  }
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n) {
      throw new Error('Backup key files must be regular, singly linked files with 0600 permissions or stricter.');
    }
    if (
      (expectedBytes !== undefined && before.size !== BigInt(expectedBytes)) ||
      (maximumBytes !== undefined && before.size > BigInt(maximumBytes))
    ) {
      throw new Error('Backup key file size is invalid.');
    }

    const contents = await file.readFile(encoding ? { encoding } : undefined);
    const after = await file.stat({ bigint: true });
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error('Backup key file changed while it was being read.');
    }
    return contents;
  } finally {
    await file.close();
  }
}

export async function loadBackupKey({ keyFile, keyId }) {
  if (typeof keyFile !== 'string' || !keyFile.trim()) {
    throw new TypeError('A backup encryption key file is required.');
  }
  if (typeof keyId !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(keyId)) {
    throw new TypeError('Backup key ID must contain 1 to 64 letters, numbers, dots, underscores, or hyphens.');
  }

  const key = await readProtectedKeyFile(keyFile, { expectedBytes: 32 });
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Backup encryption key must contain exactly 32 raw bytes.');
  }
  return { key, keyId };
}

function validateKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError('Backup encryption key must contain exactly 32 bytes.');
  }
}

function additionalData(keyId, context) {
  if (typeof context !== 'string' || !context.trim() || context.length > 1024) {
    throw new TypeError('Backup encryption context must contain 1 to 1024 characters.');
  }
  return Buffer.from(FORMAT + ':' + VERSION + ':' + keyId + ':' + context, 'utf8');
}

function createHashingTransform(hash, count) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      count.bytes += chunk.length;
      callback(null, chunk);
    },
  });
}

export async function loadBackupKeyRing({ keyFile }) {
  if (typeof keyFile !== 'string' || !keyFile.trim()) {
    throw new TypeError('A backup key-ring file is required.');
  }
  let document;
  try {
    document = JSON.parse(await readProtectedKeyFile(keyFile, { encoding: 'utf8', maximumBytes: 64 * 1024 }));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Backup key-ring file is not valid JSON.');
    }
    throw error;
  }
  if (
    document?.format !== 'multi-streamer-audio-platform.backup-keyring' ||
    document.version !== 1 ||
    typeof document.activeKeyId !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,64}$/.test(document.activeKeyId) ||
    !document.keys ||
    typeof document.keys !== 'object' ||
    Array.isArray(document.keys)
  ) {
    throw new Error('Backup key-ring metadata is invalid.');
  }

  const keys = new Map();
  for (const [id, encoded] of Object.entries(document.keys)) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id) || typeof encoded !== 'string' || !/^[a-f0-9]{64}$/i.test(encoded)) {
      throw new Error('Backup key-ring contains an invalid key entry.');
    }
    keys.set(id, Buffer.from(encoded, 'hex'));
  }
  const activeKey = keys.get(document.activeKeyId);
  if (!activeKey) throw new Error('Backup key-ring active key is missing.');
  return { activeKeyId: document.activeKeyId, activeKey, keys };
}

export async function encryptBackupFile({ sourcePath, destinationPath, key, keyId, context }) {
  validateKey(key);
  const aad = additionalData(keyId, context);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);

  const cipherPath = destinationPath + '.cipher-' + randomUUID();
  const hash = createHash('sha256');
  const count = { bytes: 0 };
  let destinationCreated = false;
  try {
    await pipeline(
      createReadStream(sourcePath),
      createHashingTransform(hash, count),
      cipher,
      createWriteStream(cipherPath, { flags: 'wx', mode: 0o600 }),
    );

    const header = {
      format: FORMAT,
      version: VERSION,
      algorithm: 'aes-256-gcm',
      keyId,
      context,
      nonce: nonce.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      sha256: hash.digest('hex'),
      plaintextBytes: count.bytes,
      encryptedAt: new Date().toISOString(),
    };
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    if (headerBytes.length > MAX_HEADER_BYTES) throw new Error('Backup encryption header is too large.');

    const prefix = Buffer.alloc(MAGIC.length + HEADER_LENGTH_BYTES);
    MAGIC.copy(prefix);
    prefix.writeUInt32BE(headerBytes.length, MAGIC.length);
    await writeFile(destinationPath, Buffer.concat([prefix, headerBytes]), { flag: 'wx', mode: 0o600 });
    destinationCreated = true;
    await pipeline(
      createReadStream(cipherPath),
      createWriteStream(destinationPath, { flags: 'a', mode: 0o600 }),
    );
    return header;
  } catch (error) {
    if (destinationCreated) await rm(destinationPath, { force: true });
    throw error;
  } finally {
    await rm(cipherPath, { force: true });
  }
}

export async function decryptBackupFile({ sourcePath, destinationPath, key, keyRing, keyId, context }) {
  const file = await open(sourcePath, 'r');
  let header;
  let payloadOffset;
  try {
    const prefix = Buffer.alloc(MAGIC.length + HEADER_LENGTH_BYTES);
    const prefixRead = await file.read(prefix, 0, prefix.length, 0);
    if (prefixRead.bytesRead !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Backup archive header is invalid.');
    }
    const headerLength = prefix.readUInt32BE(MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
      throw new Error('Backup archive header length is invalid.');
    }
    const headerBytes = Buffer.alloc(headerLength);
    const headerRead = await file.read(headerBytes, 0, headerLength, prefix.length);
    if (headerRead.bytesRead !== headerLength) throw new Error('Backup archive header is truncated.');
    try {
      header = JSON.parse(headerBytes.toString('utf8'));
    } catch {
      throw new Error('Backup archive metadata is invalid.');
    }
    payloadOffset = prefix.length + headerLength;
  } finally {
    await file.close();
  }

  if (
    header?.format !== FORMAT ||
    header.version !== VERSION ||
    header.algorithm !== 'aes-256-gcm' ||
    typeof header.keyId !== 'string' ||
    typeof header.context !== 'string' ||
    !/^[a-f0-9]{24}$/i.test(header.nonce) ||
    !/^[a-f0-9]{32}$/i.test(header.tag) ||
    !/^[a-f0-9]{64}$/i.test(header.sha256) ||
    !Number.isSafeInteger(header.plaintextBytes) ||
    header.plaintextBytes < 0 ||
    (keyId !== undefined && header.keyId !== keyId) ||
    (context !== undefined && header.context !== context)
  ) {
    throw new Error('Backup archive metadata or key ID is invalid.');
  }

  const selectedKey = key ?? keyRing?.get(header.keyId);
  validateKey(selectedKey);
  const decipher = createDecipheriv('aes-256-gcm', selectedKey, Buffer.from(header.nonce, 'hex'));
  decipher.setAAD(additionalData(header.keyId, header.context));
  decipher.setAuthTag(Buffer.from(header.tag, 'hex'));
  const hash = createHash('sha256');
  const count = { bytes: 0 };
  const temporaryPath = destinationPath + '.decrypt-' + randomUUID();
  try {
    await pipeline(
      createReadStream(sourcePath, { start: payloadOffset }),
      decipher,
      createHashingTransform(hash, count),
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    );
    if (count.bytes !== header.plaintextBytes || hash.digest('hex') !== header.sha256) {
      throw new Error('Backup archive integrity check failed.');
    }
    await link(temporaryPath, destinationPath);
    return header;
  } catch (error) {
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
