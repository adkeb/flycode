# Risk Notes

## Threat Model (v1)

- Browser extension can call localhost service.
- Service can read/write only inside configured whitelist roots.
- Token theft in browser context is still a risk; rotate token if compromised.

## Implemented Controls

- Localhost-only bind (`127.0.0.1`)
- Pair code exchange with expiry and one-time use
- Bearer token with expiry
- Path normalization + allow-root enforcement
- Deny glob patterns
- Redaction before response returns to browser
- Full audit logging for read/write/search operations

## Remaining Risks

- Regex redaction can miss unknown secret formats.
- DOM changes on target sites may break command interception.
- User can disable extension-level write confirmation; service policy still applies.

## Recommended Hardening (next iteration)

- Native Messaging mode for stricter browser-to-host trust boundary
- Per-site token scopes and short-lived session tokens
- Optional policy signature or checksum verification
- Add optional out-of-process malware scan hook for write targets
