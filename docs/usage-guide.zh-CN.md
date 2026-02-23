# FlyCode V2 使用指南（中文）

## 1. 架构说明

FlyCode V2 = `桌面应用（主控） + 浏览器扩展（网页注入） + 本地服务（MCP 工具执行）`。

- 桌面应用负责：服务生命周期、确认中心、配置中心、控制台
- 扩展负责：读取网页 AI 输出的 `mcp-request`，调用本地 MCP，回填 `mcp-response`
- 本地服务负责：策略校验、工具执行、审计、脱敏

## 2. 首次安装

1. 安装依赖：`npm install`
2. 构建：`npm run build`
3. 启动桌面应用：`npm run dev -w @flycode/desktop-app`
4. 安装扩展：在 `chrome://extensions` 或 `edge://extensions` 加载 `packages/extension/dist`

## 3. 扩展设置（Options）

扩展 Options 页面仅保留连接与诊断：

1. 检查 `FlyCode Desktop 服务地址`（默认 `http://127.0.0.1:39393`）
2. 点击 `检测应用连接`
3. 点击 `同步站点密钥`
4. 可选：开启/关闭自动发送、结果摘要显示、调试日志

## 4. MCP 调用格式（必须）

网页 AI 需要输出以下代码块之一。

### 4.1 列工具

```mcp-request
{"jsonrpc":"2.0","id":"call-001","method":"tools/list","params":{}}
```

### 4.2 调工具

```mcp-request
{"jsonrpc":"2.0","id":"call-002","method":"tools/call","params":{"name":"fs.search","arguments":{"path":"/root/work/flycode","query":"TODO","glob":"**/*.ts","limit":20}}}
```

### 4.3 读取文件

```mcp-request
{"jsonrpc":"2.0","id":"call-003","method":"tools/call","params":{"name":"fs.read","arguments":{"path":"/root/work/flycode/README.md","head":1200}}}
```

## 5. 高风险操作确认流

高风险工具（如 `fs.write`、`fs.rm`、`process.run`）默认触发确认：

1. 扩展收到 `pendingConfirmationId`
2. 桌面应用“确认中心”出现待审批项
3. 你可选择：`Approve` / `Reject` / `Always Allow`
4. 批准后扩展自动重试并回填最终 `mcp-response`
5. 超时（120 秒）默认拒绝

## 6. 常见问题

### 6.1 扩展不执行 `mcp-request`

检查：

1. 代码块语言标签是否是 `mcp-request`
2. JSON 是否合法，是否包含 `jsonrpc/id/method`
3. `id` 是否重复（同会话 + 同 hash 会去重）
4. 扩展是否已同步站点 key

### 6.2 返回 403

常见原因：

1. 路由站点与 Bearer key 不匹配
2. `policy.yaml` 的 `site_allowlist` 未放行该站点
3. 路径不在 `allowed_roots`

### 6.3 写入或命令执行卡住

通常是等待确认。打开桌面应用确认中心处理待审批项。

## 7. 关键文件

- `~/.flycode/policy.yaml`
- `~/.flycode/site-keys.json`
- `~/.flycode/app-config.json`
- `~/.flycode/audit/YYYY-MM-DD.jsonl`
- `~/.flycode/console/YYYY-MM-DD.jsonl`
