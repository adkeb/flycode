# FlyCode

FlyCode bridges local files with Qwen/DeepSeek web chats via browser extension and local service.

- Extension: Chrome/Edge Manifest V3
- Local service: Node.js on WSL2 (127.0.0.1:39393)
- Commands: /fs.ls, /fs.read, /fs.search, /fs.write

## Monorepo Layout
- packages/shared-types: shared types
- packages/local-service: file API with policy/audit
- packages/extension: command interceptor
- docs: documentation

## Quick Start
1. `npm install`
2. `npm run build`
3. Start service: `npm run dev -w @flycode/local-service` (WSL2)
4. Build extension: `npm run build -w @flycode/extension`
5. Load `packages/extension/dist` in Chrome/Edge (developer mode)
6. Pair: copy pair code from service terminal, enter in extension options.

## Command Syntax
- `/fs.ls <path> [--depth N] [--glob PATTERN]`
- `/fs.read <path> [--head N|--tail N|--range a:b]`
- `/fs.search <path> --query "..." [--regex] [--glob PATTERN] [--limit N]`
- `/fs.write <path> --mode overwrite|append --content "..." [--expectedSha256 HASH]`

Auto tool mode: AI can output `flycode-call` code block; extension executes and injects result.

## Policy & Audit
- Policy file: `~/.flycode/policy.yaml` (allowed_roots, deny_globs, site_allowlist, limits, redaction)
- Audit log: `~/.flycode/audit/YYYY-MM-DD.jsonl` (timestamp, site, command, path, result)

## Testing
`npm run test`

## Notes
- Service listens only on 127.0.0.1.
- Development mode only (not store packaged).
- OCR not implemented in v1 (interface reserved).
- See docs/ for troubleshooting, risks, usage guide (Chinese) and system prompt.
