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
const executionLedger = new Set<string>();
const executionOrder: string[] = [];
const MAX_EXECUTION_LEDGER = 1500;
const executionMeta = new Map<string, { method: string; tool?: string }>();
const legacyNoticeConversations = new Set<string>();

void bootstrap();

async function bootstrap(): Promise<void> {
  await loadSettings();
  loadLedger();

  installUploadLauncher({
    getSettings: () => settings,
    onPayloadReady: (payload) => {
      void injectToInput(payload);
    },
    onStatus: (message, isError) => showFloatingStatus(message, isError)
  });

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

  primeExistingRequests();
  scheduleScan(500);
  scheduleMask(700);
  installDebugApi();
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
  for (const block of adapter.collectAssistantBlocks()) {
    if (block.kind !== "mcp-request") {
      continue;
    }
    const parsed = parseMcpRequestBlock(block.text);
    if (!parsed) {
      continue;
    }
    processedBlocks.add(block.node);
    rememberExecutionKey(buildExecutionKey(parsed.id, parsed.requestHash));
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
    for (const block of blocks) {
      if (processedBlocks.has(block.node)) {
        continue;
      }

      if (block.kind !== "mcp-request") {
        maybeEmitLegacyMigrationNotice(block);
        continue;
      }

      const parsed = parseMcpRequestBlock(block.text);
      if (!parsed) {
        continue;
      }

      processedBlocks.add(block.node);

      const executionKey = buildExecutionKey(parsed.id, parsed.requestHash);
      if (executionLedger.has(executionKey)) {
        continue;
      }

      rememberExecutionKey(executionKey);
      executionMeta.set(parsed.id, {
        method: parsed.envelope.method,
        tool:
          parsed.envelope.method === "tools/call" && parsed.envelope.params && typeof parsed.envelope.params === "object"
            ? String((parsed.envelope.params as { name?: unknown }).name ?? "")
            : undefined
      });
      await executeMcpRequest(parsed.envelope);
    }
  } finally {
    busy = false;
  }
}

function maybeEmitLegacyMigrationNotice(block: AssistantBlock): void {
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
    await injectToInput(formatErrorResponse(envelope.id, response?.message ?? "MCP execute failed"));
    return;
  }

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
  const ok = adapter.injectText(next);
  if (!ok) {
    showFloatingStatus("未找到输入框，无法注入结果。", true);
    return;
  }

  if (settings.autoToolAutoSend) {
    await sleep(40);
    const outcome = await adapter.submitAuto();
    if (!outcome.ok) {
      showFloatingStatus("结果已注入输入框，但未自动发送，请手动点击发送。", true);
    }
  }

  scheduleMask(80);
  scheduleMask(280);
  scheduleMask(700);
}

function maskRenderedResponses(): void {
  const blocks = adapter.collectAssistantBlocks();
  for (const block of blocks) {
    if (block.node.getAttribute("data-flycode-masked") === "1") {
      continue;
    }
    const summary = summarizeAssistantBlock(block);
    if (!summary) {
      continue;
    }
    adapter.applyMaskedSummary(block.node, summary);
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
}

function buildExecutionKey(callId: string, requestHash: string): string {
  const conversationId = adapter.conversationId().trim() || "(unknown-conversation)";
  return `${conversationId}|${callId}|${requestHash}`;
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

function installDebugApi(): void {
  const globalRef = window as unknown as {
    __flycodeDebug?: unknown;
  };

  globalRef.__flycodeDebug = {
    getSettings: () => ({ ...settings }),
    runScan: () => runScan(),
    runMask: () => maskRenderedResponses(),
    runResultMask: () => maskRenderedResponses(),
    getExecutionLedger: () => [...executionOrder]
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
