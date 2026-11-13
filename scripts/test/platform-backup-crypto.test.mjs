import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  decryptBackupFile,
  encryptBackupFile,
  loadBackupKey,
  loadBackupKeyRing,
} from '../lib/platform-backup-crypto.mjs';

async function withTemporaryDirectory(action) {
  const directory = await mkdtemp(join(tmpdir(), 'platform-backup-test-'));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('encrypts and decrypts an archive with authenticated metadata and payload integrity', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'source.dump');
    const encryptedPath = join(directory, 'source.dump.msapbk');
    const decryptedPath = join(directory, 'restored.dump');
    const keyFile = join(directory, 'backup.key');
    const source = Buffer.concat([Buffer.from('database-backup\n'), randomBytes(128 * 1024)]);
    const key = randomBytes(32);
    await writeFile(sourcePath, source);
    await writeFile(keyFile, key, { mode: 0o600 });

    const loaded = await loadBackupKey({ keyFile, keyId: 'primary-2026' });
    const encrypted = await encryptBackupFile({
      sourcePath,
      destinationPath: encryptedPath,
      key: loaded.key,
      keyId: loaded.keyId,
      context: 'postgres:backup-001',
    });

    assert.equal(encrypted.plaintextBytes, source.length);
    assert.equal(encrypted.keyId, 'primary-2026');
    assert.notDeepEqual(await readFile(encryptedPath), source);

    const restored = await decryptBackupFile({
      sourcePath: encryptedPath,
      destinationPath: decryptedPath,
      key: loaded.key,
      keyId: loaded.keyId,
    });
    assert.equal(restored.context, 'postgres:backup-001');
    assert.deepEqual(await readFile(decryptedPath), source);
  });
});

test('rejects an authenticated archive when its artifact context is not the requested backup', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'source.dump');
    const encryptedPath = join(directory, 'source.dump.msapbk');
    const decryptedPath = join(directory, 'restored.dump');
    const key = randomBytes(32);
    await writeFile(sourcePath, Buffer.from('backup identity fixture'));
    await encryptBackupFile({
      sourcePath,
      destinationPath: encryptedPath,
      key,
      keyId: 'key-a',
      context: 'postgres:backup-identity-a',
    });

    await assert.rejects(
      decryptBackupFile({
        sourcePath: encryptedPath,
        destinationPath: decryptedPath,
        key,
        context: 'postgres:backup-identity-b',
      }),
      /key ID is invalid/,
    );
    assert.equal(await readFile(decryptedPath).then(() => true, () => false), false);
  });
});

test('rejects a different key and refuses to replace a restored file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'source.dump');
    const encryptedPath = join(directory, 'source.dump.msapbk');
    const decryptedPath = join(directory, 'restored.dump');
    const source = Buffer.from('private backup material');
    const key = randomBytes(32);
    await writeFile(sourcePath, source);
    await encryptBackupFile({
      sourcePath,
      destinationPath: encryptedPath,
      key,
      keyId: 'key-a',
      context: 'postgres:backup-002',
    });

    await assert.rejects(
      decryptBackupFile({
        sourcePath: encryptedPath,
        destinationPath: decryptedPath,
        key: randomBytes(32),
      }),
    );
    assert.equal(await readFile(decryptedPath).then(() => true, () => false), false);

    await decryptBackupFile({
      sourcePath: encryptedPath,
      destinationPath: decryptedPath,
      key,
    });
    await assert.rejects(
      decryptBackupFile({
        sourcePath: encryptedPath,
        destinationPath: decryptedPath,
        key,
      }),
      /EEXIST/,
    );
  });
});

test('rejects modified ciphertext and unauthenticated metadata', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'source.dump');
    const encryptedPath = join(directory, 'source.dump.msapbk');
    const tamperedPath = join(directory, 'tampered.msapbk');
    const outputPath = join(directory, 'restored.dump');
    const key = randomBytes(32);
    await writeFile(sourcePath, Buffer.from('backup integrity fixture'));
    await encryptBackupFile({
      sourcePath,
      destinationPath: encryptedPath,
      key,
      keyId: 'key-a',
      context: 'objects:snapshot-003',
    });

    const tampered = await readFile(encryptedPath);
    tampered[tampered.length - 1] ^= 0x01;
    await writeFile(tamperedPath, tampered);
    await assert.rejects(
      decryptBackupFile({
        sourcePath: tamperedPath,
        destinationPath: outputPath,
        key,
      }),
    );
    assert.equal(await readFile(outputPath).then(() => true, () => false), false);

    await assert.rejects(
      decryptBackupFile({
        sourcePath: encryptedPath,
        destinationPath: outputPath,
        key,
        keyId: 'retired-key',
      }),
      /key ID is invalid/,
    );
  });
});

test('requires a private 32-byte key file and an explicit versioned key ID', async () => {
  await withTemporaryDirectory(async (directory) => {
    const keyFile = join(directory, 'backup.key');
    await writeFile(keyFile, randomBytes(32), { mode: 0o644 });
    await assert.rejects(
      loadBackupKey({ keyFile, keyId: 'key-a' }),
      /permissions must be 0600/,
    );

    await chmod(keyFile, 0o600);
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    await assert.rejects(
      loadBackupKey({ keyFile, keyId: 'key with spaces' }),
      /key ID must contain/,
    );
    await writeFile(keyFile, Buffer.from('short'), { mode: 0o600 });
    await assert.rejects(
      loadBackupKey({ keyFile, keyId: 'key-a' }),
      /exactly 32 raw bytes/,
    );
  });
});


test('loads a private versioned key ring and selects historical keys by archive metadata', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, 'source.dump');
    const encryptedPath = join(directory, 'source.dump.msapbk');
    const decryptedPath = join(directory, 'restored.dump');
    const keyFile = join(directory, 'backup-keyring.json');
    const oldKey = randomBytes(32);
    const activeKey = randomBytes(32);
    const keyRingDocument = {
      format: 'multi-streamer-audio-platform.backup-keyring',
      version: 1,
      activeKeyId: 'backup-2026-11',
      keys: {
        'backup-2026-07': oldKey.toString('hex'),
        'backup-2026-11': activeKey.toString('hex'),
      },
    };
    const source = Buffer.from('backup encrypted under a key that is no longer active');
    await writeFile(sourcePath, source);
    await writeFile(keyFile, JSON.stringify(keyRingDocument), { mode: 0o600 });

    const keyRing = await loadBackupKeyRing({ keyFile });
    await encryptBackupFile({
      sourcePath,
      destinationPath: encryptedPath,
      key: keyRing.keys.get('backup-2026-07'),
      keyId: 'backup-2026-07',
      context: 'postgres:historical-backup',
    });
    await decryptBackupFile({
      sourcePath: encryptedPath,
      destinationPath: decryptedPath,
      keyRing: keyRing.keys,
    });
    assert.equal(keyRing.activeKeyId, 'backup-2026-11');
    assert.deepEqual(await readFile(decryptedPath), source);
  });
});
