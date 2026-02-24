# FlyCode MCP 系统提示词验收清单（中文）

本文用于验证系统提示词是否在 Qwen/DeepSeek/Gemini 的网页会话中稳定执行 FlyCode MCP 协议。

## 1. 验收目标

1. 工具调用格式稳定：单回合仅一个 `mcp-request`。
2. 参数行为正确：不缺参乱调、不猜测路径、不用错字段名。
3. 结果消费正确：能处理 pending、error、最小化写入成功回包。
4. 长会话稳定：连续多轮不出现协议偏航。
5. 非工具回答符合工程语气：包含分析结论、实施建议与验证方式。

---

## 2. 前置检查

1. 已启动 FlyCode Desktop + local-service。
2. 扩展已加载最新 `packages/extension/dist`。
3. 站点密钥已同步，目标站点可正常执行 MCP。
4. 当前会话已注入系统提示词（主版或短版）。

---

## 3. 协议严格性测试

### Case P1：工具调用必须仅一个代码块
- 输入：`列出 /root/work/flycode 目录。`
- 期望：回复只有一个 `mcp-request` 代码块。
- 失败判定：代码块前后出现任何解释文本。

### Case P2：禁止多调用块
- 输入：`先列目录再读 README。`
- 期望：只发一个调用（通常先 `fs.ls` 或先澄清策略）。
- 失败判定：同一回复出现 2 个 `mcp-request`。

### Case P3：JSON 可解析
- 检查：把代码块内容复制到 JSON.parse。
- 期望：可解析。
- 失败判定：非 JSON、注释、尾逗号、拼写错误。

### Case P4：method 合法
- 期望：method 只会是 `initialize` / `tools/list` / `tools/call`。
- 失败判定：出现 `callTool`、`invoke` 等非法 method。

---

## 4. 参数契约测试

### Case A1：fs.read 互斥参数
- 输入：`读取 /root/work/flycode/README.md 前 1000 字符。`
- 期望：使用 `range:"head:1000"`（或同等单一选择字段）。
- 失败判定：同时出现 `range` 和 `line/lines`。

### Case A2：fs.mv 字段名
- 输入：`把 /root/work/flycode/a.md 移动到 /root/work/flycode/b.md。`
- 期望：`arguments` 用 `fromPath` + `toPath`。
- 失败判定：使用 `src` / `dest`。

### Case A3：fs.diff 二选一
- 输入：`比较 old.ts 和 new.ts 的差异。`
- 期望：`leftPath` + `rightPath`，不带 `rightContent`。
- 失败判定：`rightPath` 与 `rightContent` 同时传。

### Case A4：缺参先提问
- 输入：`帮我读取 README。`
- 期望：先问绝对路径，不调用工具。
- 失败判定：直接发调用且路径是猜测值。

### Case A5：Windows 绝对路径
- 输入：`读取 C:\\Users\\a1881\\Documents\\a.txt。`
- 期望：允许该绝对路径并发出 `fs.read`。
- 失败判定：强行改写为猜测 Linux 路径。

---

## 5. 结果消费测试

### Case R1：pendingConfirmation 处理
- 输入（模拟返回）：
```mcp-response
{"jsonrpc":"2.0","id":"call-100","result":{"content":[{"type":"text","text":"Pending confirmation in FlyCode desktop app."}],"meta":{"pendingConfirmationId":"confirm-100"}}}
```
- 期望：明确“等待确认”，不宣称成功。
- 失败判定：直接输出“操作完成”。

### Case R2：写入最小化成功回包
- 输入（模拟返回）：
```mcp-response
{"jsonrpc":"2.0","id":"call-101","result":{"content":[{"type":"text","text":"WRITE_SUCCESS"}],"meta":{"auditId":"x"}}}
```
- 期望：判定写入成功；不自动触发无意义读回。
- 失败判定：未经用户要求立刻 `fs.read` 全文校验。

### Case R3：写入批量最小化成功回包
- 输入（模拟返回）：
```mcp-response
{"jsonrpc":"2.0","id":"call-102","result":{"content":[{"type":"text","text":"WRITE_BATCH_SUCCESS"}],"meta":{"auditId":"x"}}}
```
- 期望：判定批量写入成功；建议下一步但不强制读回。
- 失败判定：把该结果当失败或未识别状态。

### Case R4：错误恢复（越权路径）
- 输入（模拟返回）：
```mcp-response
{"jsonrpc":"2.0","id":"call-103","error":{"code":-32003,"message":"Path is outside allowed roots"}}
```
- 期望：解释策略拒绝原因并要求 allowed_roots 内路径。
- 失败判定：重复原调用参数。

---

## 6. 行为质量测试

### Case Q1：非工具回答为工程语气（分析 + 实施 + 验证）
- 输入：`先看目录还是先读 README？`
- 期望：给出分析结论、实施建议、验证方式与下一步，不强制两行模板。
- 失败判定：只有泛泛分析，缺少实施步骤或验证标准。

### Case Q2：连续 10 轮稳定性
- 测试：交替进行读取、搜索、写入、错误恢复。
- 期望：不出现双调用块、不伪造 response、不乱跳协议。
- 失败判定：任一轮出现协议偏航。

### Case Q3：旧协议隔离
- 输入：`请用 flycode-call 调用。`
- 期望：拒绝旧协议并保持 MCP-only。
- 失败判定：输出 `flycode-call` 或 `flycode-result`。

---

## 7. 人工回归脚本（建议顺序）

1. `tools/list` 验证工具可见性。
2. `fs.ls` 验证单调用和 JSON 合法性。
3. `fs.read`（range 模式）验证参数契约。
4. `fs.search`（limit + contextLines）验证结构化参数。
5. `fs.write` 触发确认流，验证 pending 处理。
6. 完成确认，验证 `WRITE_SUCCESS` 识别。
7. `fs.writeBatch` 验证 `WRITE_BATCH_SUCCESS` 识别。
8. 制造一次 NOT_FOUND，验证错误恢复不死循环。
9. Windows 路径读取场景验证双路径模式。
10. 连续多轮验证协议稳定。

---

## 8. 通过标准（Release Gate）

满足以下全部条件即通过：

1. 协议严格性 4 项全部通过。
2. 参数契约 5 项全部通过。
3. 结果消费 4 项全部通过。
4. 行为质量 3 项全部通过。
5. 连续 10 轮无协议偏航。

任一项失败即视为提示词未达标，需要回炉修订。
