# FlyCode 使用文档（中文）

本文档覆盖 FlyCode 的完整使用流程：安装、配对、手动命令、自动工具模式、策略配置与排障。

## 1. 系统组成

FlyCode 由两部分组成：

1. 浏览器扩展（Chrome/Edge）
- 在 Qwen/DeepSeek 页面拦截命令。
- 调用本地服务并把结果注入输入框。

2. 本地服务（Node.js）
- 默认监听 `127.0.0.1:39393`。
- 执行鉴权、路径策略、脱敏、审计、写入确认。

## 2. 主要能力（当前版本）

- `fs.ls`：列目录
- `fs.mkdir`：创建目录（支持递归）
- `fs.read`：读文件（支持 `line/lines/range`、编码、元数据）
- `fs.search`：全文搜索（支持扩展名/大小/时间过滤与上下文）
- `fs.write`：单文件写入（prepare/commit）
- `fs.writeBatch`：批量写入（JSON-only，失败回滚）
- `fs.rm`：安全删除（目录需显式递归）
- `fs.mv`：移动/重命名（默认不覆盖）
- `fs.chmod`：修改权限（Windows 运行时返回 `NOT_SUPPORTED`）
- `fs.diff`：文件差异（文件-文件 / 文件-文本）
- `process.run`：白名单命令执行（参数数组）
- `shell.exec`：白名单命令执行（shell 字符串）

## 3. 环境要求

- Node.js 20+
- npm 10+
- Chrome 或 Edge
- 支持两种服务运行方式：
  - WSL2（推荐）
  - Windows 原生

## 4. 安装与启动

在项目根目录执行：

```bash
npm install
npm run build
```

启动本地服务：

```bash
npm run dev:service
```

构建扩展：

```bash
npm run build:extension
```

如果你要直接给 Windows Edge 加载扩展目录：

```bash
npm run build:extension:windows
```

## 5. 加载扩展与首次配对

1. 打开 `edge://extensions` 或 `chrome://extensions`
2. 打开“开发者模式”
3. 点击“加载解压缩扩展”
4. 选择 `packages/extension/dist`（或 Windows 同步目录）
5. 打开扩展 Options 页面
6. 填写 `Local Service URL`（默认 `http://127.0.0.1:39393`）
7. 输入服务日志输出的 6 位配对码
8. 点击 `Verify Pair Code`

配对成功后扩展会保存 Bearer Token，用于后续调用。

## 6. 路径规则（WSL2 与 Windows 双模式）

服务支持双模式绝对路径：

- Linux 路径：`/root/...`、`/home/...`、`/mnt/c/...`
- Windows 路径：`C:\\Users\\...`、`D:\\repo\\...`

说明：

- Windows 运行时输入 `/mnt/c/...` 会映射到 `C:\\...`。
- Linux/WSL2 运行时输入 `C:\\...` 会映射到 `/mnt/c/...`。
- 所有路径仍必须落在 `allowed_roots` 内。

## 7. 手动模式命令（用户输入）

在聊天输入框输入命令并发送。

### 7.1 目录与读取

1. 列目录

```text
/fs.ls <path> [--depth N] [--glob PATTERN]
```

2. 创建目录

```text
/fs.mkdir <path> [--parents]
```

3. 读取文件（增强）

```text
/fs.read <path> [--head N|--tail N|--range a:b|--line N|--lines a-b] [--encoding utf-8|base64|hex] [--no-meta]
```

说明：

- `--head/--tail/--range/--line/--lines` 互斥。
- 默认返回 `meta(size/mtime/ctime/mode)`，`--no-meta` 可关闭。
- `base64/hex` 适合二进制读取；`line/lines` 仅适用于 utf-8 文本模式。

### 7.2 搜索与差异

1. 搜索

```text
/fs.search <path> --query "..." [--regex] [--glob PATTERN] [--limit N] [--ext EXT|--extensions csv] [--min-bytes N] [--max-bytes N] [--mtime-from ISO] [--mtime-to ISO] [--context N]
```

说明：

- `--context` 取值会被限制在 `0~5`。
- 返回结果包含命中行及可选上下文行。

2. 差异对比

```text
/fs.diff <leftPath> [--right-path <path> | --right-content """..."""] [--context N]
```

### 7.3 写入与变更

1. 单文件写入

```text
/fs.write <path> --mode overwrite|append --content """...""" [--expectedSha256 HASH]
```

2. 删除

```text
/fs.rm <path> [--recursive] [--force]
```

说明：

- 删除目录必须显式 `--recursive`。
- 白名单根目录本身不可删除。

3. 移动/重命名

```text
/fs.mv <fromPath> <toPath> [--overwrite]
```

说明：

- 默认不覆盖；仅 `--overwrite` 才覆盖。

4. 权限

```text
/fs.chmod <path> --mode <octal>
```

说明：

- 模式必须是八进制（如 `644`、`0755`）。
- Windows 服务进程会返回 `NOT_SUPPORTED`。

### 7.4 命令执行

1. 参数化执行

```text
/process.run <command> [--arg <arg>]... [--cwd <path>] [--timeout-ms N] [--env KEY=VALUE]
```

2. shell 字符串执行

```text
/shell.exec --command "..." [--cwd <path>] [--timeout-ms N] [--env KEY=VALUE]
```

说明：

- 仅支持非交互单次执行。
- 命令首 token 必须在白名单中。
- `cwd` 需在白名单目录范围内。
- 输出会脱敏并受字节/Token 上限截断。

## 8. 自动工具模式（AI 主动调用）

在 Options 中开启：

- `Enable auto tool mode`
- 可选：`Auto send tool results to chat`

默认行为：

- 自动模式默认允许高风险调用（`write/rm/mv/chmod/writeBatch/process/shell`）。
- 若关闭 `Allow auto mode to execute /fs.write`，则自动模式会拦截 `fs.write` 与 `fs.writeBatch`。

### 8.1 flycode-call 协议

AI 工具调用必须是单个代码块，语言标签 `flycode-call`。

支持两类格式：

1. 斜杠命令
```flycode-call
/fs.search /root/work/flycode --query "TODO" --glob "**/*.ts" --limit 20
```

2. JSON 工具对象
```flycode-call
{"id":"call-001","tool":"fs.read","args":{"path":"/root/work/flycode/README.md","head":1200}}
```

### 8.2 `fs.writeBatch`（JSON-only）

`fs.writeBatch` 第一版只能走 JSON，不支持 `/fs.writeBatch` 斜杠语法：

```flycode-call
{"id":"call-002","tool":"fs.writeBatch","args":{"files":[{"path":"/project/index.html","mode":"overwrite","content":"..."},{"path":"/project/style.css","mode":"append","content":"\n/* append */"}]}}
```

执行语义：

- `prepare -> (可选确认) -> commit`
- 任一文件失败立即停止并回滚已写项

## 9. 写入确认机制

默认写入流程（`fs.write` / `fs.writeBatch`）：

1. prepare
2. 扩展确认弹窗（可配置）
3. commit

如果你关闭了前端确认，但策略不允许关闭确认，服务端仍会强制要求确认。

## 10. policy.yaml 新字段说明

默认路径：`~/.flycode/policy.yaml`

```yaml
allowed_roots:
  - /root/work/flycode
  - /mnt/c/Users/a1881/Documents

deny_globs:
  - "**/.git/**"
  - "**/node_modules/**"
  - "**/.env*"

site_allowlist:
  - qwen
  - deepseek

limits:
  max_file_bytes: 5242880
  max_inject_tokens: 12000
  max_search_matches: 200

write:
  require_confirmation_default: true
  allow_disable_confirmation: true
  backup_on_overwrite: true
  pending_ttl_seconds: 600

mutation:
  allow_rm: true
  allow_mv: true
  allow_chmod: true
  allow_write_batch: true

process:
  enabled: true
  allowed_commands:
    - npm
    - node
    - git
    - rg
    - pnpm
    - yarn
  allowed_cwds: []
  default_timeout_ms: 30000
  max_timeout_ms: 120000
  max_output_bytes: 200000
  allow_env_keys:
    - CI
    - NODE_ENV

redaction:
  enabled: true
  rules:
    - name: openai_api_key
      pattern: "sk-[a-zA-Z0-9]{20,}"
      replacement: "***REDACTED***"

audit:
  enabled: true
  include_content_hash: true

auth:
  token_ttl_days: 30
  pair_code_ttl_minutes: 5
```

安全硬规则：

- 所有路径类操作都受 `allowed_roots + deny_globs` 限制。
- `fs.rm` 不允许删除白名单根目录本身。
- `process.run/shell.exec` 受命令白名单、cwd 白名单、超时、输出上限限制。

## 11. 审计日志

路径：`~/.flycode/audit/YYYY-MM-DD.jsonl`

记录字段包含：

- `timestamp`
- `site`
- `command`
- `path`
- `outcome`
- `bytes`
- `truncated`
- `userConfirm`
- `traceId`
- `auditId`
- `errorCode`
- `message`

排障建议：先在网页里拿 `auditId`，再去日志中定位同 ID 记录。

## 12. 常见问题

1. 报 `Missing token`
- 重新进入 Options 执行配对。

2. 报 `Path is outside allowed roots`
- 修改 `policy.yaml` 的 `allowed_roots`，确保目标路径在白名单内。

3. 自动模式不执行 `fs.writeBatch`
- 检查是否关闭了 `Allow auto mode to execute /fs.write`。

4. `fs.chmod` 失败
- Windows 原生服务返回 `NOT_SUPPORTED` 是预期行为。

5. 进程命令被拒绝
- 检查 `process.enabled`、`process.allowed_commands`、`cwd` 是否在允许范围。
