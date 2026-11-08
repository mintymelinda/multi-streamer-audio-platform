# Secret encryption and key management baseline

No third-party integration credentials may be persisted until this design is implemented and reviewed.

## Key hierarchy

- Use envelope encryption for stored integration credentials.
- Generate a cryptographically random data-encryption key (DEK) for each credential record or credential group.
- Encrypt credential payloads with an authenticated cipher (AES-256-GCM); use a fresh nonce for every encryption operation.
- Bind ciphertext to its context with authenticated additional data, including workspace ID, provider/integration ID, credential record ID, and format version.
- Wrap each DEK with a versioned key-encryption key (KEK). The KEK must be held outside PostgreSQL and outside ordinary application configuration.
- Store ciphertext, nonce, authentication tag, wrapped DEK, KEK version, and format metadata only. Never store plaintext access tokens, refresh tokens, client secrets, or DEKs.

## Key custody and recovery

- Production KEKs are provisioned through a host/deployment secret mechanism and exposed to the process through a protected secret file or dedicated secret provider, not a committed file or ordinary environment variable.
- Maintain an encrypted offline recovery copy of each active KEK, separately from database and object-storage backups.
- Restrict access to production and recovery keys; record key access and key-management operations.
- A backup is not considered recoverable until the matching key material and documented restore procedure have been tested together.
- Do not store a recovery key beside the encrypted database backup it is intended to recover.

## Rotation

1. Introduce a new KEK version without deleting the old version.
2. Make new writes use the new KEK.
3. Rewrap existing DEKs in bounded, restartable batches; ciphertext need not be decrypted and re-encrypted when only the wrapping KEK changes.
4. Verify every active credential references the new KEK version.
5. Retire the old KEK only after verification and a defined rollback/recovery window.
6. Audit rotation start, completion, failure, and authorized recovery operations without logging key material.

## Operational safeguards

- Fail closed if key material is missing, malformed, or unavailable. Do not silently store plaintext or substitute a development key.
- Keep local-development keys and sample passwords separate from production key material.
- Redact credentials and authorization headers from logs, traces, errors, crash reports, and support diagnostics.
- Workspace deletion and integration disconnect must include encrypted credential records and derived credential caches.
- Test backup restoration, key recovery, rotation interruption, and loss of a KEK before enabling integrations.

This document defines the intended baseline; it is not evidence that encryption or key recovery has already been implemented.
