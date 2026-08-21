# Security

The current release is designed for localhost or a trusted private network.

## Current controls

- Provider credentials are server-side and management responses expose metadata only.
- Client API keys are stored as SHA-256 hashes and shown once at creation.
- Administrator passwords use salted `scrypt` hashes in SQLite.
- Prompt previews in usage logs are truncated and redacted.
- Risk mode can block likely private-key or API-key leakage.
- Wiki compiler output is checked for secrets and path traversal before staging.
- File imports have format, encoding, size, and path boundaries.

## Production gaps

The project does not yet provide public administrator SSO/RBAC, CSRF protection, TLS termination, complete egress/DNS-rebinding controls, or application-level encryption for Provider secrets. Use a reverse proxy, network egress policy, encrypted storage, and restricted binding before public exposure.

