# FlyCode V2

FlyCode V2 是一个“桌面应用主导 + 浏览器扩展协同”的本地文件桥接系统：

- `desktop-app`：启动即托管本地服务，提供确认中心、请求控制台、配置中心、主题切换（Renderer 使用 React + Vite + Mantine）
- `local-service`：本地工具执行层，提供 MCP Streamable HTTP、策略校验、审计日志
- `extension`：网页拦截与注入层，识别 `mcp-request`、执行并回填 `mcp-response`
- `shared-types`：跨包共享协议类型

V2 为 **MCP-only** 协议，旧 `flycode-call/result` 仅作为历史兼容文档，不再执行。

## 目录结构

- `packages/desktop-app`：Electron 桌面应用（开发模式运行）
- `packages/local-service`：本地服务（MCP + 文件/进程工具）
- `packages/extension`：Chrome/Edge 扩展
- `packages/shared-types`：共享类型
- `docs`：提示词、使用说明、风险说明

## 核心能力

- MCP 方法：`initialize`、`tools/list`、`tools/call`
- MCP 路由：`POST /mcp/{siteId}`（`qwen`、`deepseek`、`gemini`）
- 工具集合：
  - 文件：`fs.ls` `fs.mkdir` `fs.read` `fs.search` `fs.write` `fs.writeBatch` `fs.rm` `fs.mv` `fs.chmod` `fs.diff`
  - 进程：`process.run` `shell.exec`
- 分站点密钥：`~/.flycode/site-keys.json`
- 确认中心：高风险工具默认进入 `PENDING_CONFIRMATION`，应用内审批
- 控制台日志：`~/.flycode/console/YYYY-MM-DD.jsonl`（默认保留 30 天）

## 快速开始（开发模式）

1. 安装依赖

```bash
npm install
```

2. 构建全部包

```bash
npm run build
```

3. 启动桌面应用（会自动拉起本地服务，开发模式含 Vite 热更新）

```bash
npm run dev -w @flycode/desktop-app
```

说明：
- `dev` 会并行启动 `local-service + vite + electron`
- 若 Electron 本体损坏，`dev` 会自动降级为“Web 预览模式”（Vite + local-service 仍保持运行）
- 修复 Electron 可执行：
  - `npm rebuild electron -w @flycode/desktop-app`

4. 构建并安装扩展

```bash
npm run build -w @flycode/extension
```

在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，加载 `packages/extension/dist`。

5. 扩展 Options 页面点击“同步站点密钥”，确保拿到 `qwen/deepseek` key。

## MCP 对话协议（网页 AI）

AI 调用工具时应输出：

```mcp-request
{"jsonrpc":"2.0","id":"call-001","method":"tools/call","params":{"name":"fs.read","arguments":{"path":"/root/work/flycode/README.md"}}}
```

扩展执行后注入：

```mcp-response
{"jsonrpc":"2.0","id":"call-001","result":{"content":[{"type":"text","text":"..."}],"meta":{"auditId":"...","truncated":false}}}
```

若需人工确认：

- `result.meta.pendingConfirmationId` 会返回确认 ID
- 扩展显示等待状态，并轮询确认结果
- 桌面应用批准后，扩展自动重试同一调用

## 配置文件

- `~/.flycode/policy.yaml`：策略主配置（路径白名单、命令白名单、脱敏、限制）
- `~/.flycode/site-keys.json`：站点桥接 key
- `~/.flycode/app-config.json`：主题、日志保留、应用偏好
- `~/.flycode/audit/YYYY-MM-DD.jsonl`：审计日志
- `~/.flycode/console/YYYY-MM-DD.jsonl`：控制台事件

## 运行与测试

```bash
npm run typecheck
npm run test
```

## 打包成应用程序

1. 打包桌面应用（当前平台，输出 unpacked 目录）

```bash
npm run pack:desktop
```

2. 生成安装包

```bash
npm run dist:desktop
```

3. 按平台打包

```bash
# Windows（需在 Windows 环境执行，或准备好 wine）
npm run dist:desktop:win

# Linux
npm run dist:desktop:linux
```

产物默认在 `packages/desktop-app/release/`。

## 说明

- 服务仅监听 `127.0.0.1`
- V2 首版为开发运行模式（不强制安装包）
- 支持站点：DeepSeek + Qwen；Gemini 当前为预留适配位
- 风险与限制见 `docs/risk-notes.md`
