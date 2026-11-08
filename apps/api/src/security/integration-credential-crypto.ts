import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface IntegrationEncryptionContext {
  workspaceId: string;
  provider: string;
  credentialId: string;
}

export interface IntegrationKeyRing {
  currentVersion: string;
  keys: Record<string, string>;
}

export interface EncryptedCredentialEnvelope {
  formatVersion: 1;
  ciphertext: string;
  nonce: string;
  authTag: string;
  wrappedDek: string;
  dekNonce: string;
  dekAuthTag: string;
  kekVersion: string;
}

function decodeKey(encoded: string, version: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== encoded) {
    throw new Error(
      `Integration KEK version "${version}" must be a canonical base64-encoded 32-byte key.`,
    );
  }
  return key;
}

function credentialAad(context: IntegrationEncryptionContext): Buffer {
  if (!context.workspaceId || !context.provider || !context.credentialId) {
    throw new Error('Integration credential encryption requires complete record context.');
  }
  return Buffer.from(
    `integration-credential:v1:${context.workspaceId}:${context.provider}:${context.credentialId}`,
    'utf8',
  );
}

function wrappingAad(credentialId: string, kekVersion: string): Buffer {
  return Buffer.from(`integration-dek:v1:${credentialId}:${kekVersion}`, 'utf8');
}

export function loadIntegrationKeyRing(): IntegrationKeyRing {
  const path = process.env.INTEGRATION_KEK_RING_FILE;
  if (!path) {
    throw new Error(
      'Integration credential encryption is unavailable: INTEGRATION_KEK_RING_FILE is not configured.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Integration KEK ring file could not be read or parsed.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('currentVersion' in parsed) ||
    typeof parsed.currentVersion !== 'string' ||
    !('keys' in parsed) ||
    typeof parsed.keys !== 'object' ||
    parsed.keys === null ||
    Array.isArray(parsed.keys)
  ) {
    throw new Error('Integration KEK ring file has an invalid structure.');
  }
  const ring = parsed as IntegrationKeyRing;
  const current = ring.keys[ring.currentVersion];
  if (typeof current !== 'string') {
    throw new Error('The current Integration KEK version is missing from the key ring.');
  }
  decodeKey(current, ring.currentVersion);
  for (const [version, encoded] of Object.entries(ring.keys)) {
    if (typeof encoded !== 'string') {
      throw new Error(`Integration KEK version "${version}" is invalid.`);
    }
    decodeKey(encoded, version);
  }
  return ring;
}

export function encryptIntegrationCredentials(
  plaintext: string,
  context: IntegrationEncryptionContext,
  keyRing: IntegrationKeyRing,
): EncryptedCredentialEnvelope {
  const kekVersion = keyRing.currentVersion;
  const encodedKek = keyRing.keys[kekVersion];
  if (!encodedKek) throw new Error('The current Integration KEK is unavailable.');
  const kek = decodeKey(encodedKek, kekVersion);
  const aad = credentialAad(context);
  const dek = randomBytes(KEY_BYTES);

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const dekNonce = randomBytes(NONCE_BYTES);
  const dekCipher = createCipheriv('aes-256-gcm', kek, dekNonce);
  dekCipher.setAAD(wrappingAad(context.credentialId, kekVersion));
  const wrappedDek = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
  const dekAuthTag = dekCipher.getAuthTag();

  dek.fill(0);
  return {
    formatVersion: FORMAT_VERSION,
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: authTag.toString('base64'),
    wrappedDek: wrappedDek.toString('base64'),
    dekNonce: dekNonce.toString('base64'),
    dekAuthTag: dekAuthTag.toString('base64'),
    kekVersion,
  };
}

export function decryptIntegrationCredentials(
  envelope: EncryptedCredentialEnvelope,
  context: IntegrationEncryptionContext,
  keyRing: IntegrationKeyRing,
): string {
  if (envelope.formatVersion !== FORMAT_VERSION) {
    throw new Error('Unsupported integration credential encryption format.');
  }
  const encodedKek = keyRing.keys[envelope.kekVersion];
  if (!encodedKek) {
    throw new Error(`Integration KEK version "${envelope.kekVersion}" is unavailable.`);
  }
  const kek = decodeKey(encodedKek, envelope.kekVersion);

  const dekDecipher = createDecipheriv(
    'aes-256-gcm',
    kek,
    Buffer.from(envelope.dekNonce, 'base64'),
  );
  dekDecipher.setAAD(wrappingAad(context.credentialId, envelope.kekVersion));
  dekDecipher.setAuthTag(Buffer.from(envelope.dekAuthTag, 'base64'));
  const dek = Buffer.concat([
    dekDecipher.update(Buffer.from(envelope.wrappedDek, 'base64')),
    dekDecipher.final(),
  ]);

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      dek,
      Buffer.from(envelope.nonce, 'base64'),
    );
    decipher.setAAD(credentialAad(context));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}
