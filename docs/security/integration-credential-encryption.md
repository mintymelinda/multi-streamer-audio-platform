# Integration credential envelope

The API implements version-1 envelope encryption in
`apps/api/src/security/integration-credential-crypto.ts`.

- Each credential encryption operation generates a fresh random 256-bit DEK.
- Credential payloads use AES-256-GCM with a fresh 96-bit nonce.
- Authenticated additional data binds ciphertext to workspace ID, provider,
  credential record ID, and format version.
- The DEK is wrapped with a versioned 256-bit KEK using AES-256-GCM and a
  separate fresh nonce. Wrapping AAD binds it to credential ID and KEK version.
- PostgreSQL stores only ciphertext, nonces, authentication tags, wrapped DEK,
  KEK version, and format version.
- Missing, malformed, or unknown keys fail closed. There is no plaintext
  fallback or development-key substitution.

## Key-ring file

The process receives the path through the bootstrap-only
`INTEGRATION_KEK_RING_FILE` setting. The protected file is JSON:

```json
{
  "currentVersion": "kek-2026-01",
  "keys": {
    "kek-2026-01": "<base64-encoded-32-byte-random-key>"
  }
}
```

Provision the file through the host/deployment secret mechanism with
permissions restricted to the service account. Never commit a real key ring.
Keep offline recovery copies separate from database backups.

## Rotation

Add a new version to the ring and make it current. New encryptions use the
current version; old envelopes remain decryptable while their version remains
in the ring. Rewrap DEKs in bounded batches before retiring an old KEK. The
envelope format supports this process; the rotation job and operational
recovery drill remain to be implemented before production credential use.

The implementation is a cryptographic primitive, not by itself approval to
enable a provider integration. Production key provisioning, backup recovery,
rotation verification, and provider-specific authorization flows remain
required.
