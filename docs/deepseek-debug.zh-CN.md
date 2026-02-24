# FlyCode DeepSeek 调试手册

本文用于排查 DeepSeek 页面出现以下问题：
- AI 输出了 `mcp-request` 但扩展未执行
- 扩展执行后未自动回传 `mcp-response`
- 需要定位是「识别失败」「执行失败」还是「发送失败」

## 1. 前置检查

1. 确认扩展已重载（`edge://extensions` -> 重新加载）。
2. 确认当前页面域名是 `https://chat.deepseek.com`。
3. 确认桌面端服务状态是「正在工作」。
4. 在页面控制台执行：

```js
window.__flycodeDebug?.getSettings?.()
```

重点检查：
- `autoToolEnabled: true`
- `autoToolAutoSend: true`（若希望自动发送）

## 2. 一键抓取完整调试快照

在 DeepSeek 页控制台执行：

```js
window.__flycodeDebug?.dump?.()
```

会返回完整对象：
- `site`：站点适配器 ID（应为 `deepseek`）
- `conversationId`：会话键
- `hidden`：当前标签页是否后台
- `executionLedgerSize`：去重账本大小
- `pendingAutoSendId / pendingAutoSendRetries`：是否处于自动重试发送
- `logs`：完整调试事件链

## 3. 调试事件含义（logs.stage）

- `scan.start`：开始扫描页面块
- `scan.candidate`：发现候选块
- `scan.parse`：尝试解析请求（成功/失败）
- `scan.execute`：已决定调用 MCP
- `execute.result`：后台执行结果（成功/失败）
- `inject`：向输入框注入回包
- `submit`：自动发送结果（包含 `ok/method/attempts/hidden`）
- `mask`：摘要隐藏执行
- `scan.skip`：跳过原因（例如已处理、无可执行块）

## 4. 常见故障定位

### 4.1 后台无请求记录

看 `logs` 是否有 `scan.execute`：
- 没有：说明卡在识别阶段，重点看最后几个 `scan.candidate` + `scan.parse`。
- 有：说明请求已发，去桌面控制台确认是否按站点 key 被拒绝。

### 4.2 有 execute.result 成功，但聊天窗口没回包

看 `inject` 和 `submit`：
- `inject` 失败：输入框定位失败。
- `submit.ok=false`：发送按钮/回车未触发；扩展会进入重试（看 `pendingAutoSendRetries`）。

### 4.3 后台页（非前台）不发送

看 `submit` 事件里的 `hidden`：
- `hidden=true` 且持续失败：说明页面节流严重，保持页面打开并等待重试，或手动发送。

## 5. 导出日志给开发排查

```js
const data = window.__flycodeDebug?.dump?.();
copy(JSON.stringify(data, null, 2));
```

把复制内容发给开发者即可。

## 6. 快速自检脚本

```js
(async () => {
  const dbg = window.__flycodeDebug;
  if (!dbg) {
    console.log('flycode debug api missing');
    return;
  }
  await dbg.runScan();
  await new Promise((r) => setTimeout(r, 300));
  dbg.runMask();
  console.log(dbg.dump());
})();
```
