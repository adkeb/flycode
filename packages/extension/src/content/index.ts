/**
 * FlyCode Note: MCP-only content script
 * Watches AI output for mcp-request blocks, executes via background,
 * injects mcp-response back to chat, and compacts rendered result blocks.
 */
import type { ConfirmationEntry, McpRequestEnvelope, McpResponseEnvelope } from "@flycode/shared-types";
import { parseMcpRequestBlock } from "./mcp-parser.js";
import { installUploadLauncher } from "./upload-launcher.js";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "../shared/types.js";
import { resolveSiteAdapter } from "../site-adapters/registry.js";
import type { AssistantBlock } from "../site-adapters/common/types.js";
import {
  formatSummary,
  isFlycodeUploadPayload,
  parseFlycodeResultSummary,
  parseMcpResponseSummary
} from "../site-adapters/common/summary-protocol.js";

const adapter = resolveSiteAdapter();

let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let scanTimer: number | undefined;
let maskTimer: number | undefined;
let busy = false;
let processedBlocks = new WeakSet<HTMLElement>();
let lastConversationId = adapter.conversationId();
let pendingAutoSendTimer: number | undefined;
let pendingAutoSendId: string | null = null;
let pendingAutoSendRetries = 0;
type DebugStage =
  | "bootstrap"
  | "scan.start"
  | "scan.skip"
  | "scan.candidate"
  | "scan.parse"
  | "scan.execute"
  | "execute.result"
  | "inject"
  | "submit"
  | "mask";
type DebugEntry = {
  ts: string;
  stage: DebugStage;
  site: string;
  conversation: string;
  detail: string;
  data?: Record<string, unknown>;
};
const debugLog: DebugEntry[] = [];
const MAX_DEBUG_LOG = 500;
const executionLedger = new Set<string>();
const executionOrder: string[] = [];
const MAX_EXECUTION_LEDGER = 1500;
const executionMeta = new Map<string, { method: string; tool?: string }>();
const legacyNoticeConversations = new Set<string>();
const DEBUG_BRIDGE_REQ = "flycode-debug-req";
const DEBUG_BRIDGE_RES = "flycode-debug-res";

void bootstrap();

async function bootstrap(): Promise<void> {
  pushDebug("bootstrap", "content script bootstrap", { site: adapter.id });
  await loadSettings();
  loadLedger();

  installUploadLauncher({
    getSettings: () => settings,
    onPayloadReady: (payload) => {
      void injectToInput(payload);
    },
    onStatus: (message, isError) => showFloatingStatus(message, isError)
  });
  installPageDebugBridge();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.flycodeSettings) {
      return;
    }
    settings = {
      ...DEFAULT_SETTINGS,
      ...(changes.flycodeSettings.newValue as Partial<ExtensionSettings>)
    };
    scheduleScan(120);
    scheduleMask(120);
  });

  const observer = new MutationObserver(() => {
    scheduleScan(260);
    scheduleMask(220);
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  window.setInterval(() => {
    scheduleScan(400);
    scheduleMask(300);
  }, 1500);
  window.setInterval(() => {
    tryPendingAutoSend();
  }, 2000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleScan(80);
      scheduleMask(80);
      void tryPendingAutoSend();
    }
  });

  window.addEventListener("focus", () => {
    scheduleScan(80);
    scheduleMask(80);
    void tryPendingAutoSend();
  });

  primeExistingRequests();
  scheduleScan(500);
  scheduleMask(700);
  installDebugApi();
}

type DebugBridgeMessage = {
  channel: string;
  id: string;
  action: string;
};

function installPageDebugBridge(): void {
  window.addEventListener("message", (event: MessageEvent<DebugBridgeMessage>) => {
    if (event.source !== window || !event.data || event.data.channel !== DEBUG_BRIDGE_REQ) {
      return;
    }
    const { id, action } = event.data;
    void handleDebugBridgeAction(id, action);
  });

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-debug-bridge.js");
  script.async = false;
  script.onload = () => script.remove();
  (document.documentElement || document.head || document.body).appendChild(script);
}

async function handleDebugBridgeAction(id: string, action: string): Promise<void> {
  try {
    let result: unknown;
    switch (action) {
      case "getSettings":
        result = { ...settings };
        break;
      case "runScan":
        await runScan();
        result = true;
        break;
      case "runMask":
      case "runResultMask":
        maskRenderedResponses();
        result = true;
        break;
      case "getExecutionLedger":
        result = [...executionOrder];
        break;
      case "getLogs":
        result = [...debugLog];
        break;
      case "clearLogs":
        debugLog.length = 0;
        result = true;
        break;
      case "dump":
        result = {
          site: adapter.id,
          conversationId: adapter.conversationId(),
          hidden: document.hidden,
          url: location.href,
          settings,
          executionLedgerSize: executionOrder.length,
          pendingAutoSendId,
          pendingAutoSendRetries,
          logs: [...debugLog]
        };
        break;
      default:
        throw new Error(`Unsupported debug action: ${action}`);
    }
    window.postMessage({ channel: DEBUG_BRIDGE_RES, id, ok: true, result }, "*");
  } catch (error) {
    window.postMessage(
      {
        channel: DEBUG_BRIDGE_RES,
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      "*"
    );
  }
}

async function loadSettings(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: "FLYCODE_GET_SETTINGS" })) as {
      ok: boolean;
      settings?: ExtensionSettings;
    };
    if (response?.ok && response.settings) {
      settings = { ...DEFAULT_SETTINGS, ...response.settings };
    }
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function scheduleScan(delayMs: number): void {
  if (!settings.autoToolEnabled) {
    return;
  }
  if (scanTimer !== undefined) {
    window.clearTimeout(scanTimer);
  }
  scanTimer = window.setTimeout(() => {
    void runScan();
  }, delayMs);
}

function scheduleMask(delayMs: number): void {
  if (!settings.compactResultDisplayEnabled) {
    return;
  }
  if (maskTimer !== undefined) {
    window.clearTimeout(maskTimer);
  }
  maskTimer = window.setTimeout(() => {
    maskRenderedResponses();
  }, delayMs);
}

function primeExistingRequests(): void {
  const blocks = adapter.collectAssistantBlocks();
  for (const block of blocks) {
    if (!shouldTryParseAsMcpRequest(block)) {
      continue;
    }
    const parsed = parseMcpRequestBlock(block.text);
    if (!parsed) {
      continue;
    }
    processedBlocks.add(block.node);
    // Cold start replay guard: mark existing history as consumed.
    rememberExecutionKey(buildExecutionKey(block.node, parsed.requestHash, parsed.id));
  }
}

async function runScan(): Promise<void> {
  if (!settings.autoToolEnabled || busy) {
    return;
  }

  maybeResetForConversationChange();
  busy = true;
  try {
    const blocks = adapter.collectAssistantBlocks();
    pushDebug("scan.start", "scan begin", { blockCount: blocks.length });

    // Iterate from latest to oldest and execute at most one unresolved request.
    for (let idx = blocks.length - 1; idx >= 0; idx -= 1) {
      const block = blocks[idx];
      if (!block || block.source === "user") {
        continue;
      }
      if (processedBlocks.has(block.node)) {
        continue;
      }
      pushDebug("scan.candidate", "candidate block", {
        index: idx,
        kind: block.kind,
        source: block.source,
        textHead: block.text.slice(0, 120)
      });

      if (!shouldTryParseAsMcpRequest(block)) {
        maybeEmitLegacyMigrationNotice(block);
        processedBlocks.add(block.node);
        continue;
      }

      const parsed = parseMcpRequestBlock(block.text);
      if (!parsed) {
        pushDebug("scan.parse", "parse failed", { index: idx });
        if (!mayContainMcpCallText(block.text)) {
          processedBlocks.add(block.node);
        }
        continue;
      }
      pushDebug("scan.parse", "parse ok", { id: parsed.id, method: parsed.envelope.method });

      processedBlocks.add(block.node);

      const executionKey = buildExecutionKey(block.node, parsed.requestHash, parsed.id);
      if (executionLedger.has(executionKey)) {
        pushDebug("scan.skip", "execution key already handled", { id: parsed.id });
        continue;
      }

      rememberExecutionKey(executionKey);
      executionMeta.set(parsed.id, {
        method: parsed.envelope.method,
        tool:
          parsed.envelope.method === "tools/call" &&
          parsed.envelope.params &&
          typeof parsed.envelope.params === "object"
            ? String((parsed.envelope.params as { name?: unknown }).name ?? "")
            : undefined
      });
      pushDebug("scan.execute", "executing request", { id: parsed.id, method: parsed.envelope.method });
      await executeMcpRequest(parsed.envelope);
      return;
    }
    pushDebug("scan.skip", "no executable mcp-request found");
  } finally {
    busy = false;
  }
}

function deriveBlockAnchor(node: HTMLElement): string {
  const anchors = [
    node.closest("[id]"),
    node.closest("[data-message-id]"),
    node.closest("[data-id]"),
    node.closest("[data-msg-id]")
  ];
  for (const anchor of anchors) {
    if (!(anchor instanceof HTMLElement)) {
      continue;
    }
    if (anchor.id) {
      return `id:${anchor.id}`;
    }
    const dataMessageId = anchor.getAttribute("data-message-id");
    if (dataMessageId) {
      return `data-message-id:${dataMessageId}`;
    }
    const dataId = anchor.getAttribute("data-id");
    if (dataId) {
      return `data-id:${dataId}`;
    }
    const dataMsgId = anchor.getAttribute("data-msg-id");
    if (dataMsgId) {
      return `data-msg-id:${dataMsgId}`;
    }
  }

  const pathParts: string[] = [];
  let current: HTMLElement | null = node;
  let depth = 0;
  while (current && depth < 6) {
    const parentEl: HTMLElement | null = current.parentElement;
    if (!parentEl) {
      break;
    }
    const siblings = Array.from(parentEl.children);
    const index = siblings.indexOf(current);
    pathParts.push(`${current.tagName.toLowerCase()}:${index}`);
    current = parentEl;
    depth += 1;
  }
  return `path:${pathParts.join(">")}`;
}

function shouldTryParseAsMcpRequest(block: AssistantBlock): boolean {
  if (block.source === "user") {
    return false;
  }
  if (block.kind === "mcp-request") {
    return true;
  }
  if (block.kind !== "unknown") {
    return false;
  }
  const normalized = block.text.replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim().toLowerCase();
  return normalized.startsWith("```mcp-request") || normalized.startsWith("mcp-request");
}

function mayContainMcpCallText(text: string): boolean {
  const raw = text.toLowerCase();
  if (raw.includes("mcp-request")) {
    return true;
  }
  if (/"method"\s*:\s*"tools\/call"/i.test(raw)) {
    return true;
  }
  if (/"method"\s*:\s*"initialize"/i.test(raw)) {
    return true;
  }
  if (/"method"\s*:\s*"tools\/list"/i.test(raw)) {
    return true;
  }
  return false;
}

function maybeEmitLegacyMigrationNotice(block: AssistantBlock): void {
  if (block.source === "user") {
    return;
  }
  const text = block.text;
  if (!text.includes("flycode-call")) {
    return;
  }
  const conversation = adapter.conversationId();
  if (legacyNoticeConversations.has(conversation)) {
    return;
  }
  legacyNoticeConversations.add(conversation);
  void injectToInput(
    [
      "```mcp-response",
      JSON.stringify(
        {
          jsonrpc: "2.0",
          id: "migration-notice",
          error: {
            code: -32000,
            message: "FlyCode V2 已升级为 MCP-only，请改用 mcp-request 协议。"
          }
        },
        null,
        2
      ),
      "```"
    ].join("\n")
  );
}

async function executeMcpRequest(envelope: McpRequestEnvelope): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: "FLYCODE_MCP_EXECUTE",
    site: adapter.id,
    envelope
  })) as { ok: boolean; response?: McpResponseEnvelope; message?: string };

  if (!response?.ok || !response.response) {
    pushDebug("execute.result", "mcp execute failed", { id: envelope.id, message: response?.message ?? "unknown" });
    await injectToInput(formatErrorResponse(envelope.id, response?.message ?? "MCP execute failed"));
    return;
  }
  pushDebug("execute.result", "mcp execute success", { id: envelope.id });

  let finalResponse = response.response;
  const pendingId = getPendingConfirmationId(finalResponse);
  if (pendingId) {
    finalResponse = await waitForConfirmationAndRetry(envelope, pendingId, finalResponse);
  }

  await injectToInput(formatResponse(finalResponse));
}

async function waitForConfirmationAndRetry(
  envelope: McpRequestEnvelope,
  confirmationId: string,
  currentResponse: McpResponseEnvelope
): Promise<McpResponseEnvelope> {
  const timeoutAt = Date.now() + 125_000;
  while (Date.now() < timeoutAt) {
    const status = (await chrome.runtime.sendMessage({
      type: "FLYCODE_CONFIRMATION_GET",
      id: confirmationId
    })) as { ok: boolean; confirmation?: ConfirmationEntry };

    if (status?.ok && status.confirmation) {
      const state = status.confirmation.status;
      if (state === "approved") {
        const retryEnvelope = withConfirmationId(envelope, confirmationId);
        const retried = (await chrome.runtime.sendMessage({
          type: "FLYCODE_MCP_EXECUTE",
          site: adapter.id,
          envelope: retryEnvelope
        })) as { ok: boolean; response?: McpResponseEnvelope; message?: string };
        if (retried?.ok && retried.response) {
          return retried.response;
        }
        return errorEnvelope(envelope.id, retried?.message ?? "Retry after confirmation failed");
      }
      if (state === "rejected" || state === "timeout") {
        return errorEnvelope(envelope.id, `Confirmation ${state}`);
      }
    }
    await sleep(1200);
  }
  return currentResponse;
}

function withConfirmationId(envelope: McpRequestEnvelope, confirmationId: string): McpRequestEnvelope {
  if (envelope.method !== "tools/call") {
    return envelope;
  }
  const params = (envelope.params && typeof envelope.params === "object" ? envelope.params : {}) as Record<string, unknown>;
  return {
    ...envelope,
    params: {
      ...params,
      confirmationId
    }
  };
}

function formatResponse(response: McpResponseEnvelope): string {
  return ["```mcp-response", JSON.stringify(response, null, 2), "```"].join("\n");
}

function formatErrorResponse(id: string | number, message: string): string {
  return formatResponse(errorEnvelope(id, message));
}

function errorEnvelope(id: string | number, message: string): McpResponseEnvelope {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message
    }
  };
}

function getPendingConfirmationId(response: McpResponseEnvelope): string | null {
  const result = response.result as { meta?: { pendingConfirmationId?: unknown } } | undefined;
  if (!result || !result.meta || typeof result.meta.pendingConfirmationId !== "string") {
    return null;
  }
  return result.meta.pendingConfirmationId;
}

async function injectToInput(text: string): Promise<void> {
  const current = adapter.getCurrentText().trim();
  const next = current ? `${current}\n\n${text}` : text;
  pushDebug("inject", "inject response to input", {
    hasCurrentInput: Boolean(current),
    textHead: text.slice(0, 120)
  });
  const ok = adapter.injectText(next);
  if (!ok) {
    pushDebug("inject", "inject failed: input not found");
    showFloatingStatus("未找到输入框，无法注入结果。", true);
    return;
  }

  if (settings.autoToolAutoSend) {
    await sleep(40);
    const outcome = await adapter.submitAuto();
    pushDebug("submit", "submit outcome", {
      ok: outcome.ok,
      method: outcome.method,
      attempts: outcome.attempts,
      hidden: document.hidden
    });
    if (!outcome.ok) {
      markPendingAutoSend(next);
      showFloatingStatus("结果已注入输入框，但未自动发送，请手动点击发送。", true);
    } else {
      clearPendingAutoSend();
    }
  }

  scheduleMask(80);
  scheduleMask(280);
  scheduleMask(700);
}

function markPendingAutoSend(injectedText: string): void {
  pendingAutoSendId = extractResponseId(injectedText);
  pendingAutoSendRetries = 0;
  schedulePendingAutoSendRetry(1800);
}

function clearPendingAutoSend(): void {
  pendingAutoSendId = null;
  pendingAutoSendRetries = 0;
  if (pendingAutoSendTimer !== undefined) {
    window.clearTimeout(pendingAutoSendTimer);
    pendingAutoSendTimer = undefined;
  }
}

function schedulePendingAutoSendRetry(delayMs: number): void {
  if (pendingAutoSendTimer !== undefined) {
    window.clearTimeout(pendingAutoSendTimer);
  }
  pendingAutoSendTimer = window.setTimeout(() => {
    pendingAutoSendTimer = undefined;
    void tryPendingAutoSend();
  }, delayMs);
}

function extractResponseId(text: string): string | null {
  const match = text.match(/"id"\s*:\s*"([^"\n\r]+)"/);
  if (match?.[1]) {
    return match[1];
  }
  return null;
}

function inputContainsPendingResponse(current: string): boolean {
  const normalized = current.trim();
  if (!normalized) {
    return false;
  }
  if (!normalized.includes("mcp-response")) {
    return false;
  }
  if (pendingAutoSendId && !normalized.includes(pendingAutoSendId)) {
    return false;
  }
  return true;
}

async function tryPendingAutoSend(): Promise<void> {
  if (!settings.autoToolAutoSend || !pendingAutoSendId) {
    return;
  }
  const current = adapter.getCurrentText();
  if (!inputContainsPendingResponse(current)) {
    clearPendingAutoSend();
    return;
  }
  const outcome = await adapter.submitAuto();
  if (outcome.ok) {
    clearPendingAutoSend();
    return;
  }

  pendingAutoSendRetries += 1;
  // Background tabs can be timer-throttled; keep retrying with bounded cadence.
  const delay = Math.min(4000 + pendingAutoSendRetries * 400, 12000);
  schedulePendingAutoSendRetry(delay);
}

function maskRenderedResponses(): void {
  const blocks = adapter.collectAssistantBlocks();
  let masked = 0;
  for (const block of blocks) {
    if (block.node.getAttribute("data-flycode-masked") === "1") {
      continue;
    }
    const summary = summarizeAssistantBlock(block);
    if (!summary) {
      continue;
    }
    adapter.applyMaskedSummary(block.node, summary);
    masked += 1;
  }
  if (masked > 0) {
    pushDebug("mask", "masked summary blocks", { masked });
  }
}

function summarizeAssistantBlock(block: AssistantBlock): string | null {
  const mcp = parseMcpResponseSummary(block.text, block.kind);
  if (mcp) {
    const requestMeta = mcp.id ? executionMeta.get(mcp.id) : undefined;
    const command = requestMeta?.tool ? `${requestMeta.method}:${requestMeta.tool}` : requestMeta?.method ?? "mcp";
    return formatSummary(mcp.status, command);
  }

  const flycode = parseFlycodeResultSummary(block.text, block.kind);
  if (flycode) {
    return formatSummary(flycode.status, flycode.command);
  }

  if (isFlycodeUploadPayload(block.text, block.kind)) {
    return formatSummary("成功", "文件/目录上传");
  }

  return null;
}

function showFloatingStatus(message: string, isError = false): void {
  const existing = document.getElementById("flycode-floating-status");
  if (existing) {
    existing.remove();
  }
  const box = document.createElement("div");
  box.id = "flycode-floating-status";
  box.textContent = message;
  box.style.position = "fixed";
  box.style.right = "18px";
  box.style.bottom = "70px";
  box.style.zIndex = "2147483000";
  box.style.maxWidth = "420px";
  box.style.background = isError ? "#ffe9e9" : "#e9f2ff";
  box.style.color = isError ? "#8b1e1e" : "#1d3e8a";
  box.style.border = isError ? "1px solid #f4b5b5" : "1px solid #b9cef6";
  box.style.borderRadius = "10px";
  box.style.padding = "10px 12px";
  box.style.fontSize = "12px";
  box.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.16)";
  document.body.appendChild(box);
  window.setTimeout(() => box.remove(), 3800);
}

function maybeResetForConversationChange(): void {
  const current = adapter.conversationId();
  if (current === lastConversationId) {
    return;
  }
  lastConversationId = current;
  processedBlocks = new WeakSet();
  executionMeta.clear();
}

function buildExecutionKey(node: HTMLElement, requestHash: string, requestId: string): string {
  const conversationId = normalizeConversationKey(lastConversationId || adapter.conversationId());
  const blockAnchor = deriveBlockAnchor(node);
  return `${conversationId}|${blockAnchor}|${requestId}|${requestHash}`;
}

function rememberExecutionKey(key: string): void {
  if (executionLedger.has(key)) {
    return;
  }
  executionLedger.add(key);
  executionOrder.push(key);
  while (executionOrder.length > MAX_EXECUTION_LEDGER) {
    const oldest = executionOrder.shift();
    if (oldest) {
      executionLedger.delete(oldest);
    }
  }
  persistLedger();
}

function persistLedger(): void {
  try {
    sessionStorage.setItem("flycode.mcp.execution.v1", JSON.stringify(executionOrder));
  } catch {
    // ignore
  }
}

function loadLedger(): void {
  try {
    const raw = sessionStorage.getItem("flycode.mcp.execution.v1");
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) {
      return;
    }
    for (const key of parsed.slice(-MAX_EXECUTION_LEDGER)) {
      if (typeof key !== "string") {
        continue;
      }
      executionLedger.add(key);
      executionOrder.push(key);
    }
  } catch {
    // ignore
  }
}

function normalizeConversationKey(conversationId: string): string {
  const key = conversationId.trim();
  return key || "(unknown-conversation)";
}

function installDebugApi(): void {
  const globalRef = window as unknown as {
    __flycodeDebug?: unknown;
  };

  globalRef.__flycodeDebug = {
    getSettings: () => ({ ...settings }),
    runScan: () => runScan(),
    runMask: () => maskRenderedResponses(),
    runResultMask: () => maskRenderedResponses(),
    getExecutionLedger: () => [...executionOrder],
    getLogs: () => [...debugLog],
    clearLogs: () => {
      debugLog.length = 0;
    },
    dump: () => {
      const payload = {
        site: adapter.id,
        conversationId: adapter.conversationId(),
        hidden: document.hidden,
        url: location.href,
        settings,
        executionLedgerSize: executionOrder.length,
        pendingAutoSendId,
        pendingAutoSendRetries,
        logs: [...debugLog]
      };
      try {
        console.log("[flycode-debug]", payload);
      } catch {
        // ignore
      }
      return payload;
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function pushDebug(stage: DebugStage, detail: string, data?: Record<string, unknown>): void {
  const entry: DebugEntry = {
    ts: new Date().toISOString(),
    stage,
    site: adapter.id,
    conversation: adapter.conversationId(),
    detail,
    data
  };
  debugLog.push(entry);
  if (debugLog.length > MAX_DEBUG_LOG) {
    debugLog.splice(0, debugLog.length - MAX_DEBUG_LOG);
  }
  try {
    console.debug("[flycode]", entry);
  } catch {
    // ignore
  }
}
