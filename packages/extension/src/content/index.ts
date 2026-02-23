import type { CommandResult } from "@flycode/shared-types";
import type { AutoToolCall } from "./auto-tool.js";
import { parseAutoToolCallFromBlock } from "./auto-tool.js";
import { installUploadLauncher } from "./upload-launcher.js";
import { parseCommand } from "../shared/parser.js";
import {
  DEFAULT_SETTINGS,
  type ExecuteCommandRequest,
  type ExecuteCommandResponse,
  type ExtensionSettings,
  type ParsedCommand
} from "../shared/types.js";
import { resolveSiteAdapter } from "../site-adapters/index.js";

const adapter = resolveSiteAdapter();

let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let manualBusy = false;
let autoBusy = false;
let scanTimer: number | undefined;
let resultMaskTimer: number | undefined;
let resultMaskRaf: number | undefined;
let resultMaskBurstToken = 0;
let processedBlocks: WeakSet<HTMLElement> = new WeakSet();
let processedFingerprints = new Set<string>();
let maskedResultBlocks: WeakSet<HTMLElement> = new WeakSet();
const fingerprintOrder: string[] = [];
let lastConversationId = adapter.getConversationId();
let autoChainCount = 0;
let lastAutoExecutionAt = 0;
const executionLedger = new Map<string, ExecutionLedgerEntry>();
const executionOrder: string[] = [];
const MAX_EXECUTION_LEDGER = 1200;
const MAX_MASK_CONTENT_LENGTH = 1_200_000;
const RESULT_MASK_BURST_DELAYS_MS = [0, 60, 180, 420, 900];
const DEBUG_BRIDGE_MESSAGE_TYPE = "FLYCODE_DEBUG_RUN_RESULT_MASK";

type ExecutionStatus = "started" | "success" | "failed" | "blocked" | "skipped-existing";

interface ExecutionIdentity {
  key: string;
  conversationId: string;
  callId: string;
  commandHash: string;
  rawCommand: string;
}

interface ExecutionLedgerEntry extends ExecutionIdentity {
  status: ExecutionStatus;
  createdAt: string;
  updatedAt: string;
}

void bootstrap();

async function bootstrap(): Promise<void> {
  await refreshSettings();
  loadExecutionLedger();
  debugLog("bootstrap", {
    href: location.href,
    site: adapter.id,
    autoToolEnabled: settings.autoToolEnabled
  });
  installUploadLauncher({
    getSettings: () => settings,
    onPayloadReady: (payload) => injectUploadPayload(payload),
    onStatus: (message, isError) => showFloatingStatus(message, isError)
  });
  installDebugApi();
  installPageDebugBridge();
  observeSettings();
  installManualListener();
  installAutoMutationObserver();
  primeExistingCalls();
  scheduleAutoScan(1200);
  scheduleResultMask(220);
}

async function refreshSettings(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get("flycodeSettings");
    settings = {
      ...DEFAULT_SETTINGS,
      ...(stored.flycodeSettings ?? {})
    };
    debugLog("settings loaded", settings);
  } catch {
    // Keep defaults if settings cannot be loaded.
    debugLog("settings load failed, using defaults");
  }
}

function observeSettings(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const next = changes.flycodeSettings?.newValue;
    if (!next || typeof next !== "object") {
      return;
    }

    settings = {
      ...DEFAULT_SETTINGS,
      ...(next as Partial<ExtensionSettings>)
    };
    debugLog("settings changed", settings);

    scheduleAutoScan(300);
    requestImmediateResultMask();
    scheduleResultMask(140);
  });
}

function installManualListener(): void {
  document.addEventListener(
    "keydown",
    async (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
        return;
      }

      const inputEl = adapter.getInputEl();
      if (!inputEl || document.activeElement !== inputEl) {
        return;
      }

      prepareForNewUserTurn();

      const currentText = adapter.getCurrentText().trim();
      if (
        !currentText.startsWith("/fs.") &&
        !currentText.startsWith("/process.run") &&
        !currentText.startsWith("/shell.exec")
      ) {
        return;
      }

      if (manualBusy) {
        debugLog("manual command skipped: busy");
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      let parsed;
      try {
        parsed = parseCommand(currentText);
        if (!parsed) {
          return;
        }
        debugLog("manual command detected", parsed);
      } catch (error) {
        adapter.injectText(formatErrorBlock(currentText, (error as Error).message));
        debugLog("manual command parse error", (error as Error).message);
        return;
      }

      manualBusy = true;
      try {
        const response = await executeParsedCommand(parsed, parsed.raw);
        if (!response.ok || !response.result) {
          adapter.injectText(formatErrorBlock(currentText, response.message ?? "Unknown extension failure"));
          debugLog("manual command execute failed", response.message ?? "Unknown extension failure");
          return;
        }

        adapter.injectText(formatResultBlock(parsed.raw, response.result));
        debugLog("manual command execute success", {
          command: parsed.command,
          ok: response.result.ok,
          auditId: response.result.auditId
        });
      } catch (error) {
        adapter.injectText(formatErrorBlock(currentText, (error as Error).message));
        debugLog("manual command execute error", (error as Error).message);
      } finally {
        manualBusy = false;
      }
    },
    true
  );
}

function installAutoMutationObserver(): void {
  if (!document.body) {
    return;
  }

  const observer = new MutationObserver(() => {
    scheduleAutoScan(700);
    requestImmediateResultMask();
    scheduleResultMask(160);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  window.setInterval(() => {
    scheduleAutoScan(1200);
    scheduleResultMask(260);
  }, 1800);
}

function scheduleAutoScan(delayMs: number): void {
  if (!settings.autoToolEnabled) {
    return;
  }

  if (scanTimer !== undefined) {
    window.clearTimeout(scanTimer);
  }

  scanTimer = window.setTimeout(() => {
    void runAutoScan();
  }, delayMs);
}

function scheduleResultMask(delayMs: number): void {
  if (!settings.compactResultDisplayEnabled) {
    return;
  }

  if (resultMaskTimer !== undefined) {
    window.clearTimeout(resultMaskTimer);
  }

  resultMaskTimer = window.setTimeout(() => {
    maskRenderedResultBlocks();
  }, delayMs);
}

function requestImmediateResultMask(): void {
  if (!settings.compactResultDisplayEnabled) {
    return;
  }

  if (resultMaskRaf !== undefined) {
    window.cancelAnimationFrame(resultMaskRaf);
  }

  resultMaskRaf = window.requestAnimationFrame(() => {
    resultMaskRaf = undefined;
    maskRenderedResultBlocks();
  });
}

function scheduleResultMaskBurst(): void {
  if (!settings.compactResultDisplayEnabled) {
    return;
  }

  resultMaskBurstToken += 1;
  const token = resultMaskBurstToken;

  for (const delay of RESULT_MASK_BURST_DELAYS_MS) {
    window.setTimeout(() => {
      if (token !== resultMaskBurstToken) {
        return;
      }
      maskRenderedResultBlocks();
    }, delay);
  }
}

async function runAutoScan(): Promise<void> {
  if (!settings.autoToolEnabled || autoBusy) {
    return;
  }

  maybeResetForConversationChange();
  debugLog("auto scan begin", {
    chainCount: autoChainCount,
    maxChain: settings.autoToolMaxCallsPerTurn,
    candidateBlocks: collectCandidateBlocks().length
  });

  autoBusy = true;
  let executed = 0;

  try {
    while (executed < 5) {
      const pending = findNextAutoCall();
      if (!pending) {
        debugLog("auto scan no pending flycode-call block");
        break;
      }

      const now = Date.now();
      if (now - lastAutoExecutionAt > 45_000) {
        autoChainCount = 0;
      }

      processedBlocks.add(pending.block);
      rememberFingerprint(pending.call.fingerprint);

      const execution = buildExecutionIdentity(pending.call);
      if (hasExecutionRecord(execution.key)) {
        debugLog("auto scan skip call: already recorded in sessionStorage", {
          key: execution.key,
          conversationId: execution.conversationId,
          callId: execution.callId,
          commandHash: execution.commandHash
        });
        continue;
      }

      if (hasExistingResultForCall(pending.call)) {
        recordExecutionStatus(execution, "skipped-existing");
        debugLog("auto scan skip call: result already exists", {
          callId: pending.call.callId,
          command: pending.call.rawCommand
        });
        continue;
      }

      if (autoChainCount >= settings.autoToolMaxCallsPerTurn) {
        injectAutoResult(formatAutoSystemBlock("Auto tool chain limit reached. Waiting for next user turn."));
        debugLog("auto scan chain limit reached");
        break;
      }

      if (
        (pending.call.parsedCommand.command === "fs.write" || pending.call.parsedCommand.command === "fs.writeBatch") &&
        !settings.autoToolAllowWrite
      ) {
        recordExecutionStatus(execution, "blocked");
        injectAutoResult(
          formatAutoSystemBlock(
            "Auto mode blocked write command. Run it manually or enable auto write in Options."
          )
        );
        debugLog("auto scan blocked write command", pending.call.rawCommand);
        executed += 1;
        continue;
      }

      if (!recordExecutionStart(execution)) {
        debugLog("auto scan skip call: execution start rejected by existing record", {
          key: execution.key
        });
        continue;
      }

      autoChainCount += 1;
      lastAutoExecutionAt = now;

      try {
        const response = await executeParsedCommand(pending.call.parsedCommand, pending.call.rawCommand);
        if (!response.ok || !response.result) {
          injectAutoResult(
            formatAutoErrorBlock(pending.call.rawCommand, response.message ?? "Unknown extension failure", pending.call.callId)
          );
          recordExecutionStatus(execution, "failed");
          debugLog("auto scan execute failed", {
            raw: pending.call.rawCommand,
            message: response.message ?? "Unknown extension failure"
          });
        } else {
          injectAutoResult(formatAutoResultBlock(pending.call.rawCommand, response.result, pending.call.callId));
          recordExecutionStatus(execution, "success");
          debugLog("auto scan execute success", {
            raw: pending.call.rawCommand,
            auditId: response.result.auditId
          });
        }
      } catch (error) {
        recordExecutionStatus(execution, "failed");
        throw error;
      }

      executed += 1;
    }
  } catch (error) {
    injectAutoResult(formatAutoSystemBlock(`Auto tool mode error: ${(error as Error).message}`));
    debugLog("auto scan error", (error as Error).message);
  } finally {
    autoBusy = false;
  }
}

function findNextAutoCall(): { block: HTMLElement; call: AutoToolCall } | null {
  const blocks = collectCandidateBlocks().reverse();

  for (const block of blocks) {
    if (!(block instanceof HTMLElement)) {
      continue;
    }

    if (processedBlocks.has(block)) {
      continue;
    }

    if (isInInputArea(block)) {
      processedBlocks.add(block);
      continue;
    }

    const text = block.textContent?.trim() ?? "";
    const parsed = parseAutoToolCallFromBlock(text);
    if (!parsed) {
      continue;
    }
    debugLog("auto scan parsed flycode-call", {
      fingerprint: parsed.fingerprint,
      callId: parsed.callId,
      command: parsed.rawCommand.slice(0, 180)
    });

    if (processedFingerprints.has(parsed.fingerprint)) {
      processedBlocks.add(block);
      debugLog("auto scan skip duplicate fingerprint", parsed.fingerprint);
      continue;
    }

    return { block, call: parsed };
  }

  return null;
}

function collectCandidateBlocks(): HTMLElement[] {
  const selector = [
    "pre",
    "code",
    "[data-testid*='code']",
    "[class*='code-block']",
    "[class*='language-']"
  ].join(",");

  const rawNodes = Array.from(document.querySelectorAll(selector));
  const unique = new Set<HTMLElement>();
  const out: HTMLElement[] = [];

  for (const node of rawNodes) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }

    let element = node;
    if (element.tagName === "CODE") {
      const pre = element.closest("pre");
      if (pre instanceof HTMLElement) {
        element = pre;
      }
    }

    const text = element.textContent?.trim() ?? "";
    if (text.length === 0 || text.length > 24_000) {
      continue;
    }

    if (!looksLikeAutoCallText(text)) {
      continue;
    }

    if (!unique.has(element)) {
      unique.add(element);
      out.push(element);
    }
  }

  return out;
}

function isInInputArea(node: HTMLElement): boolean {
  if (node.closest("textarea, input, [contenteditable='true']")) {
    return true;
  }

  const inputEl = adapter.getInputEl();
  return inputEl ? inputEl.contains(node) : false;
}

function injectAutoResult(text: string): void {
  const current = adapter.getCurrentText().trim();
  const next = current ? `${current}\n\n${text}` : text;
  adapter.injectText(next);
  debugLog("auto result injected", {
    autoSend: settings.autoToolAutoSend,
    preview: text.slice(0, 120)
  });

  if (settings.autoToolAutoSend) {
    window.setTimeout(() => {
      const submitted = adapter.submitCurrentInput();
      debugLog("auto result submit triggered", { submitted });
      requestImmediateResultMask();
      scheduleResultMaskBurst();
    }, 60);
  }

  requestImmediateResultMask();
  scheduleResultMaskBurst();
  scheduleResultMask(180);
}

function maybeResetForConversationChange(): void {
  const currentConversationId = adapter.getConversationId();
  if (currentConversationId === lastConversationId) {
    return;
  }

  debugLog("conversation changed", {
    from: lastConversationId,
    to: currentConversationId
  });
  lastConversationId = currentConversationId;
  resetAutoMemory();
  primeExistingCalls();
}

function prepareForNewUserTurn(): void {
  // Keep execution ledger; only reset DOM scan memory for the next assistant turn.
  debugLog("new user turn detected, resetting scan memory");
  resetAutoMemory();
  primeExistingCalls();
  maskedResultBlocks = new WeakSet();
}

function primeExistingCalls(): void {
  const blocks = Array.from(document.querySelectorAll("pre"));
  for (const block of blocks) {
    if (!(block instanceof HTMLElement)) {
      continue;
    }

    const parsed = parseAutoToolCallFromBlock(block.textContent?.trim() ?? "");
    if (!parsed) {
      continue;
    }

    processedBlocks.add(block);
    rememberFingerprint(parsed.fingerprint);
  }
}

function resetAutoChain(): void {
  autoChainCount = 0;
  lastAutoExecutionAt = 0;
}

function resetAutoMemory(): void {
  processedBlocks = new WeakSet();
  processedFingerprints = new Set();
  fingerprintOrder.length = 0;
  resetAutoChain();
}

function rememberFingerprint(fingerprint: string): void {
  if (processedFingerprints.has(fingerprint)) {
    return;
  }

  processedFingerprints.add(fingerprint);
  fingerprintOrder.push(fingerprint);

  while (fingerprintOrder.length > 300) {
    const oldest = fingerprintOrder.shift();
    if (oldest) {
      processedFingerprints.delete(oldest);
    }
  }
}

async function executeParsedCommand(parsed: ParsedCommand, rawCommand: string): Promise<ExecuteCommandResponse> {
  const request: ExecuteCommandRequest = {
    type: "FLYCODE_EXECUTE",
    command: parsed,
    site: adapter.id
  };

  debugLog("execute command request", request);
  const response = (await chrome.runtime.sendMessage(request)) as ExecuteCommandResponse;
  if (!response?.ok && !response?.message) {
    return {
      ok: false,
      message: `Execution failed for command: ${rawCommand}`
    };
  }

  debugLog("execute command response", response);
  return response;
}

function formatResultBlock(raw: string, result: CommandResult): string {
  const body = result.ok
    ? JSON.stringify(result.data ?? {}, null, 2)
    : JSON.stringify({ errorCode: result.errorCode, message: result.message }, null, 2);

  const truncated = result.truncated ? "true" : "false";

  return [
    "```flycode",
    `[command] ${raw}`,
    `[ok] ${String(result.ok)}`,
    `[truncated] ${truncated}`,
    `[auditId] ${result.auditId}`,
    "[data]",
    body,
    "```"
  ].join("\n");
}

function formatAutoResultBlock(raw: string, result: CommandResult, callId?: string): string {
  const body = result.ok
    ? JSON.stringify(result.data ?? {}, null, 2)
    : JSON.stringify({ errorCode: result.errorCode, message: result.message }, null, 2);

  const lines = [
    "```flycode-result",
    callId ? `[id] ${callId}` : "[id] (none)",
    `[command] ${raw}`,
    `[ok] ${String(result.ok)}`,
    `[truncated] ${String(result.truncated)}`,
    `[auditId] ${result.auditId}`,
    "[data]",
    body,
    "```"
  ];

  return lines.join("\n");
}

function formatAutoErrorBlock(raw: string, message: string, callId?: string): string {
  return [
    "```flycode-result",
    callId ? `[id] ${callId}` : "[id] (none)",
    `[command] ${raw}`,
    "[ok] false",
    `[error] ${message}`,
    "```"
  ].join("\n");
}

function formatAutoSystemBlock(message: string): string {
  return ["```flycode-result", "[system] auto-tool", `[message] ${message}`, "```"].join("\n");
}

function formatErrorBlock(raw: string, message: string): string {
  return ["```flycode", `[command] ${raw}`, "[ok] false", `[error] ${message}`, "```"].join("\n");
}

function injectUploadPayload(payload: string): void {
  const current = adapter.getCurrentText().trim();
  const next = current ? `${current}\n\n${payload}` : payload;
  const ok = adapter.injectText(next);

  if (!ok) {
    showFloatingStatus("无法注入上传内容：未找到聊天输入框", true);
    return;
  }

  showFloatingStatus("已将文件内容注入输入框，请检查后发送。", false);
  debugLog("upload payload injected", {
    chars: payload.length
  });
}

function maskRenderedResultBlocks(): void {
  const candidates = collectResultCandidates();
  if (candidates.length === 0) {
    return;
  }

  for (const node of candidates) {
    if (maskedResultBlocks.has(node)) {
      continue;
    }

    if (isInInputArea(node)) {
      continue;
    }

    const raw = normalizeMaskText(node.textContent ?? "");

    if (isMaskedSummaryBlock(raw)) {
      applyMaskedSummaryStyle(node);
      node.setAttribute("data-flycode-masked", "1");
      maskedResultBlocks.add(node);
      continue;
    }

    if (!isStrictFlycodeFenceBlock(raw)) {
      continue;
    }

    const maskedText = maskFlycodeFenceBlocks(raw);
    if (maskedText === raw) {
      continue;
    }

    // Hard safety guard: never flatten rich chat containers.
    if (node.childElementCount > 0) {
      debugLog("result mask skip non-leaf candidate", {
        tag: node.tagName,
        className: node.className
      });
      continue;
    }

    node.textContent = maskedText;
    applyMaskedSummaryStyle(node);
    node.setAttribute("data-flycode-masked", "1");
    node.title = "FlyCode 内容已隐藏（AI 接收内容不变）";

    maskedResultBlocks.add(node);
    debugLog("result block masked", {
      charsBefore: raw.length,
      charsAfter: maskedText.length
    });
  }
}

function applyMaskedSummaryStyle(node: HTMLElement): void {
  const applyStyle = (el: HTMLElement) => {
    el.style.setProperty("white-space", "pre-wrap", "important");
    el.style.setProperty("color", "#1f8f3a", "important");
    el.style.setProperty("font-size", "12px", "important");
    el.style.setProperty("line-height", "1.35", "important");
    el.style.setProperty("font-weight", "500", "important");
  };

  applyStyle(node);

  const descendants = Array.from(node.querySelectorAll<HTMLElement>("*"));
  for (const child of descendants) {
    applyStyle(child);
  }
}

function collectResultCandidates(): HTMLElement[] {
  const selector = ["pre code", "pre", "code", ".ds-message .fbb737a4", ".ds-message ._72b6158"].join(",");
  const nodes = Array.from(document.querySelectorAll(selector));
  const unique = new Set<HTMLElement>();
  const out: HTMLElement[] = [];

  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }

    const element = node;

    // For markdown blocks rendered as pre>code, use leaf `code` only.
    if (
      element.tagName === "PRE" &&
      element.childElementCount === 1 &&
      element.firstElementChild?.tagName === "CODE"
    ) {
      continue;
    }

    if (unique.has(element)) {
      continue;
    }

    if (isInInputArea(element)) {
      continue;
    }

    const text = normalizeMaskText(element.textContent ?? "");
    if (text.length === 0 || text.length > MAX_MASK_CONTENT_LENGTH) {
      continue;
    }

    const strictFence = isStrictFlycodeFenceBlock(text);
    const summaryBlock = isMaskedSummaryBlock(text);

    if (!strictFence && !summaryBlock) {
      continue;
    }

    // Only summary blocks may keep nested inline nodes after site markdown re-render.
    if (element.childElementCount > 0 && !summaryBlock) {
      continue;
    }

    unique.add(element);
    out.push(element);
  }

  return out;
}

function isStrictFlycodeFenceBlock(text: string): boolean {
  const normalized = normalizeMaskText(text);
  return /^```(flycode-result|flycode-upload)\s*\n[\s\S]*\n```$/i.test(normalized);
}

function isMaskedSummaryBlock(text: string): boolean {
  const normalized = normalizeMaskText(text);
  return /^状态：(?:成功|失败|已隐藏)\n命令：.+$/u.test(normalized);
}

function normalizeMaskText(text: string): string {
  return text
    .replace(/\u200b/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function buildMaskSummary(tag: string, body: string): string {
  if (tag === "flycode-upload") {
    return ["状态：成功", "命令：文件/目录上传"].join("\n");
  }

  if (tag === "flycode-result") {
    const okMatch = body.match(/\[ok\]\s*(true|false)/i);
    const cmdMatch = body.match(/\[command\]\s*([^\n]+)/i);

    const status = okMatch?.[1]?.toLowerCase() === "true" ? "成功" : "失败";
    const command = cmdMatch?.[1]?.trim() ?? "(unknown command)";
    return [`状态：${status}`, `命令：${command}`].join("\n");
  }

  return ["状态：已隐藏", `命令：${tag}`].join("\n");
}

function maskFlycodeFenceBlocks(raw: string): string {
  const source = normalizeMaskText(raw);
  if (!source) {
    return raw;
  }

  const match = source.match(/^```(flycode-result|flycode-upload)\s*\n([\s\S]*?)\n```$/i);
  if (!match) {
    return raw;
  }

  return buildMaskSummary(match[1].toLowerCase(), match[2]);
}

function hasExistingResultForCall(call: AutoToolCall): boolean {
  const callId = call.callId?.trim();
  if (!callId) {
    return false;
  }

  const resultBlocks = collectResultCandidates();
  if (resultBlocks.length === 0) {
    return false;
  }

  const normalizedCallIdKey = normalizeForCompare(`id: ${callId}`);
  const normalizedJsonCallIdKey = normalizeForCompare(`"id":"${callId}"`);

  for (const block of resultBlocks) {
    const rawText = block.textContent ?? "";
    if (!rawText) {
      continue;
    }

    const text = normalizeForCompare(rawText);
    if (text.includes(normalizedCallIdKey) || text.includes(normalizedJsonCallIdKey)) {
      return true;
    }
  }

  return false;
}

function buildExecutionIdentity(call: AutoToolCall): ExecutionIdentity {
  const conversationId = normalizeConversationId(adapter.getConversationId());
  const callId = normalizeCallId(call.callId);
  const commandHash = call.commandHash || hashCommandForExecution(call.rawCommand);
  const key = `${conversationId}|${callId}|${commandHash}`;

  return {
    key,
    conversationId,
    callId,
    commandHash,
    rawCommand: call.rawCommand.trim()
  };
}

function hasExecutionRecord(key: string): boolean {
  return executionLedger.has(key);
}

function recordExecutionStart(identity: ExecutionIdentity): boolean {
  if (executionLedger.has(identity.key)) {
    return false;
  }

  const now = new Date().toISOString();
  const entry: ExecutionLedgerEntry = {
    ...identity,
    status: "started",
    createdAt: now,
    updatedAt: now
  };

  executionLedger.set(identity.key, entry);
  executionOrder.push(identity.key);
  trimExecutionLedger();
  persistExecutionLedger();
  return true;
}

function recordExecutionStatus(identity: ExecutionIdentity, status: Exclude<ExecutionStatus, "started">): void {
  const now = new Date().toISOString();
  const existing = executionLedger.get(identity.key);

  if (existing) {
    existing.status = status;
    existing.updatedAt = now;
    executionLedger.set(identity.key, existing);
    persistExecutionLedger();
    return;
  }

  const entry: ExecutionLedgerEntry = {
    ...identity,
    status,
    createdAt: now,
    updatedAt: now
  };
  executionLedger.set(identity.key, entry);
  executionOrder.push(identity.key);
  trimExecutionLedger();
  persistExecutionLedger();
}

function loadExecutionLedger(): void {
  try {
    const raw = sessionStorage.getItem(executionStorageKey());
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as ExecutionLedgerEntry[];
    if (!Array.isArray(parsed)) {
      return;
    }

    for (const item of parsed.slice(-MAX_EXECUTION_LEDGER)) {
      if (!isValidExecutionLedgerEntry(item)) {
        continue;
      }

      if (executionLedger.has(item.key)) {
        continue;
      }

      executionLedger.set(item.key, item);
      executionOrder.push(item.key);
    }

    trimExecutionLedger();
  } catch {
    // Ignore malformed session cache.
  }
}

function persistExecutionLedger(): void {
  try {
    const entries = executionOrder
      .map((key) => executionLedger.get(key))
      .filter((entry): entry is ExecutionLedgerEntry => Boolean(entry))
      .slice(-MAX_EXECUTION_LEDGER);
    sessionStorage.setItem(executionStorageKey(), JSON.stringify(entries));
  } catch {
    // Ignore storage failures.
  }
}

function executionStorageKey(): string {
  return "flycode.executionLedger.v1";
}

function trimExecutionLedger(): void {
  while (executionOrder.length > MAX_EXECUTION_LEDGER) {
    const oldest = executionOrder.shift();
    if (oldest) {
      executionLedger.delete(oldest);
    }
  }
}

function isValidExecutionLedgerEntry(value: unknown): value is ExecutionLedgerEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<ExecutionLedgerEntry>;
  return (
    typeof item.key === "string" &&
    typeof item.conversationId === "string" &&
    typeof item.callId === "string" &&
    typeof item.commandHash === "string" &&
    typeof item.rawCommand === "string" &&
    typeof item.status === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  );
}

function normalizeConversationId(value: string): string {
  const trimmed = value.trim();
  return trimmed || "(unknown-conversation)";
}

function normalizeCallId(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed || "(no-call-id)";
}

function hashCommandForExecution(command: string): string {
  let hash = 2166136261;
  const normalized = command
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[|\]|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
  box.style.lineHeight = "1.35";
  box.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.16)";

  document.body.appendChild(box);
  window.setTimeout(() => {
    box.remove();
  }, 3800);
}

function debugLog(message: string, payload?: unknown): void {
  if (!settings.debugLoggingEnabled) {
    return;
  }

  if (payload === undefined) {
    console.info("[FlyCode][content]", message);
    return;
  }

  console.info("[FlyCode][content]", message, payload);
}

function looksLikeAutoCallText(text: string): boolean {
  return (
    text.includes("flycode-call") ||
    text.includes("/fs.") ||
    text.includes("/process.run") ||
    text.includes("/shell.exec") ||
    text.includes("process.run") ||
    text.includes("shell.exec") ||
    text.includes("\"tool\"") ||
    text.includes("'tool'") ||
    text.includes("\"command\"") ||
    text.includes("'command'")
  );
}

function installPageDebugBridge(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data as { type?: string } | null;
    if (!data || data.type !== DEBUG_BRIDGE_MESSAGE_TYPE) {
      return;
    }

    maskRenderedResultBlocks();
  });

  const root = document.documentElement || document.head || document.body;
  if (!root) {
    return;
  }

  const script = document.createElement("script");
  script.textContent = `
(() => {
  const bridgeType = "${DEBUG_BRIDGE_MESSAGE_TYPE}";
  const runResultMask = () => window.postMessage({ type: bridgeType }, "*");
  const current = (typeof window.__flycodeDebug === "object" && window.__flycodeDebug) ? window.__flycodeDebug : {};
  window.__flycodeDebug = { ...current, runResultMask };
})();
`;

  root.appendChild(script);
  script.remove();
}

function installDebugApi(): void {
  const globalRef = window as unknown as { __flycodeDebug?: unknown };
  globalRef.__flycodeDebug = {
    getSettings: () => ({ ...settings }),
    getExecutionLedger: () =>
      executionOrder
        .map((key) => executionLedger.get(key))
        .filter((item): item is ExecutionLedgerEntry => Boolean(item)),
    collectCandidateBlocks: () =>
      collectCandidateBlocks().map((el) => ({
        tag: el.tagName,
        className: el.className,
        preview: (el.textContent ?? "").trim().slice(0, 240)
      })),
    collectResultCandidates: () =>
      collectResultCandidates().map((el) => ({
        tag: el.tagName,
        className: el.className,
        preview: (el.textContent ?? "").trim().slice(0, 240)
      })),
    parseBlockText: (text: string) => parseAutoToolCallFromBlock(text),
    runAutoScan: () => runAutoScan(),
    runResultMask: () => maskRenderedResultBlocks()
  };
}
