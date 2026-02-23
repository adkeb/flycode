# FlyCode

FlyCode is a local bridge for Qwen/DeepSeek web chat pages.

- Browser side: Chrome/Edge extension (Manifest V3)
- Local side: Node.js service on WSL2 (`127.0.0.1:39393`)
- Commands: `/fs.ls`, `/fs.mkdir`, `/fs.read`, `/fs.search`, `/fs.write`, `/fs.rm`, `/fs.mv`, `/fs.chmod`, `/fs.diff`, `/process.run`, `/shell.exec`

## Monorepo Layout

- `packages/shared-types`: shared request/response types
- `packages/local-service`: local file API with policy/auth/audit
- `packages/extension`: browser extension that intercepts slash commands
- `docs`: setup and troubleshooting docs

## Quick Start (Development)

1. Install dependencies:

```bash
npm install
```

2. Build everything:

```bash
npm run build
```

3. Start local service (inside WSL2):

```bash
npm run dev -w @flycode/local-service
```

4. Build extension:

```bash
npm run build -w @flycode/extension
```

5. Load extension in Chrome/Edge:
- Open `chrome://extensions` or `edge://extensions`
- Enable `Developer mode`
- `Load unpacked` -> choose `packages/extension/dist`

6. Pair extension with local service:
- Read pair code printed by local service terminal
- Open extension options page
- Fill service URL (default `http://127.0.0.1:39393`)
- Enter pair code, click `Verify Pair Code`

## Command Syntax

- `/fs.ls <path> [--depth N] [--glob PATTERN]`
- `/fs.mkdir <path> [--parents]`
- `/fs.read <path> [--head N|--tail N|--range a:b|--line N|--lines a-b] [--encoding utf-8|base64|hex] [--no-meta]`
- `/fs.search <path> --query "..." [--regex] [--glob PATTERN] [--limit N] [--ext EXT|--extensions csv] [--min-bytes N] [--max-bytes N] [--mtime-from ISO] [--mtime-to ISO] [--context N]`
- `/fs.write <path> --mode overwrite|append --content """...""" [--expectedSha256 HASH]`
- `/fs.rm <path> [--recursive] [--force]`
- `/fs.mv <fromPath> <toPath> [--overwrite]`
- `/fs.chmod <path> --mode <octal>`
- `/fs.diff <leftPath> [--right-path <path> | --right-content """..."""] [--context N]`
- `/process.run <command> [--arg <arg>]... [--cwd <path>] [--timeout-ms N] [--env KEY=VALUE]`
- `/shell.exec --command "..." [--cwd <path>] [--timeout-ms N] [--env KEY=VALUE]`

JSON-only tool call:
- `fs.writeBatch` (auto tool mode only, no slash syntax in v1)

Example:

```flycode-call
{"id":"call-001","tool":"fs.writeBatch","args":{"files":[{"path":"/project/index.html","mode":"overwrite","content":"<!doctype html><title>FlyCode</title>"},{"path":"/project/style.css","mode":"append","content":"\nbody{color:#090;}"}]}}
```

`fs.writeBatch` semantics in v1:
- prepare -> (optional confirm) -> commit
- stop on first failure and rollback previously written files

Process execution safety:
- `process.run`/`shell.exec` are non-interactive single-shot executions
- first command token must be in `process.allowed_commands`
- `cwd` must pass `allowed_roots` path policy
- timeout and output limits are enforced by policy

When command execution succeeds, the extension replaces your input with a structured `flycode` block.

Auto tool mode is also available:
- Enable it in extension Options.
- Let AI output a `flycode-call` code block containing `/fs.*` command.
- Extension will execute and inject `flycode-result` back into the chat input.

## Policy File

The service loads `~/.flycode/policy.yaml`.

Important fields:

- `allowed_roots`
- `deny_globs`
- `site_allowlist`
- `limits.max_file_bytes`
- `limits.max_inject_tokens`
- `write.require_confirmation_default`
- `write.allow_disable_confirmation`
- `mutation.allow_rm`
- `mutation.allow_mv`
- `mutation.allow_chmod`
- `mutation.allow_write_batch`
- `process.enabled`
- `process.allowed_commands`
- `process.allowed_cwds`
- `process.default_timeout_ms`
- `process.max_timeout_ms`
- `process.max_output_bytes`
- `redaction.enabled`
- `redaction.rules`

## Audit Log

Each operation is written to:

- `~/.flycode/audit/YYYY-MM-DD.jsonl`

Fields include timestamp, site, command, path, result, trace ID, and audit ID.

## Testing

```bash
npm run test
```

## Notes

- Service listens only on `127.0.0.1`.
- First release is development-mode only (no store packaging).
- OCR is intentionally not implemented in v1; an OCR provider interface is reserved in code.
- See `docs/wsl2-network-troubleshooting.md` and `docs/risk-notes.md`.
- Chinese usage guide: `docs/usage-guide.zh-CN.md`.
- Strict system prompt template (Chinese): `docs/system-prompt.strict.zh-CN.md`.
