# FlyCode

FlyCode 是一个面向 Qwen/DeepSeek 网页聊天的本地文件桥接系统。

- 浏览器侧：Chrome/Edge 扩展（Manifest V3）
- 本地侧：WSL2 中运行的 Node.js 服务（`127.0.0.1:39393`）
- 命令集合：`/fs.ls`、`/fs.mkdir`、`/fs.read`、`/fs.search`、`/fs.write`、`/fs.rm`、`/fs.mv`、`/fs.chmod`、`/fs.diff`、`/process.run`、`/shell.exec`

## Monorepo 目录结构

- `packages/shared-types`：前后端共享请求/响应类型
- `packages/local-service`：本地文件 API 服务（策略/鉴权/审计）
- `packages/extension`：浏览器扩展（拦截斜杠命令）
- `docs`：安装、使用和排障文档

## 快速开始（开发模式）

1. 安装依赖：

```bash
npm install
```

2. 构建全部包：

```bash
npm run build
```

3. 启动本地服务（WSL2 内）：

```bash
npm run dev -w @flycode/local-service
```

4. 构建扩展：

```bash
npm run build -w @flycode/extension
```

5. 在 Chrome/Edge 加载扩展：
- 打开 `chrome://extensions` 或 `edge://extensions`
- 开启“开发者模式”
- 点击“加载已解压的扩展程序”，选择 `packages/extension/dist`

6. 扩展与本地服务配对：
- 查看本地服务终端输出的 6 位配对码
- 打开扩展 Options 页面
- 填写服务地址（默认 `http://127.0.0.1:39393`）
- 输入配对码并点击 `Verify Pair Code`

## 命令语法

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

仅支持 JSON 调用的工具：
- `fs.writeBatch`（仅自动工具模式支持，v1 不支持斜杠语法）

示例：

```flycode-call
{"id":"call-001","tool":"fs.writeBatch","args":{"files":[{"path":"/project/index.html","mode":"overwrite","content":"<!doctype html><title>FlyCode</title>"},{"path":"/project/style.css","mode":"append","content":"\nbody{color:#090;}"}]}}
```

`fs.writeBatch` 在 v1 的执行语义：
- `prepare -> （可选确认）-> commit`
- 任一文件失败即停止，并回滚已写入文件

命令执行安全约束：
- `process.run`/`shell.exec` 为非交互、单次执行
- 命令首 token 必须在 `process.allowed_commands` 白名单内
- `cwd` 必须通过 `allowed_roots` 路径策略校验
- 超时与输出上限由策略强制控制

命令执行成功后，扩展会将输入框内容替换为结构化 `flycode` 结果块。

也支持自动工具模式：
- 在扩展 Options 中启用自动工具模式
- 让 AI 输出包含 `/fs.*` 命令的 `flycode-call` 代码块
- 扩展自动执行并将 `flycode-result` 注入聊天输入框

## 策略文件

服务会加载 `~/.flycode/policy.yaml`。

关键字段：

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

## 审计日志

每次操作都会写入：

- `~/.flycode/audit/YYYY-MM-DD.jsonl`

字段包含：时间戳、站点、命令、路径、结果、trace ID、audit ID。

## 测试

```bash
npm run test
```

## 说明

- 服务仅监听 `127.0.0.1`。
- 当前版本仅面向本地开发调试（未上架商店）。
- v1 未实现 OCR，仅在代码中预留 OCR Provider 接口。
- 更多信息见：`docs/wsl2-network-troubleshooting.md`、`docs/risk-notes.md`。
- 中文使用文档：`docs/usage-guide.zh-CN.md`。
- 中文严格系统提示词模板：`docs/system-prompt.strict.zh-CN.md`。
