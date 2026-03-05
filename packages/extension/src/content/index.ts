/**
 * FlyCode Note: V4 bridge content script (capture-only)
 * Only captures Qwen/DeepSeek chat messages and reports them to desktop app.
 */
import type { BridgeChatCaptureFrame, BridgeClientFrame, BridgeServerFrame, SiteId } from "@flycode/shared-types";
import { DEFAULT_SETTINGS, type ExtensionSettings, type TabContextResponse } from "../shared/types.js";
import { resolveSiteAdapter } from "../site-adapters/registry.js";

const adapter = resolveSiteAdapter();
const BRIDGE_PROTOCOL_VERSION = 4;

const FRONT_DEDUPE_STORAGE_KEY = "flycode.bridge.frontDedupe.v1";

let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let tabContext: { tabId: number; windowId: number; url?: string; title?: string } | null = null;

let ws: WebSocket | null = null;
let reconnectTimer: number | undefined;
let pingTimer: number | undefined;
let reconnectAttempts = 0;

const outboundQueue: BridgeClientFrame[] = [];

let scanTimer: number | undefined;
let currentConversationId = "";

const frontDedupe = new Map<string, string[]>();
const frontDedupeSet = new Map<string, Set<string>>();
const recentTextDedupe = new Map<string, Map<string, number>>();
const hiddenToolEchoLedger = new Map<string, Array<{ fullHash: string; prefixHash: string; expiresAt: number }>>();
const hiddenToolEchoMuteUntil = new Map<string, number>();

void bootstrap();

async function bootstrap(): Promise<void> {
  await loadSettings();
  await loadTabContext();
  await loadFrontDedupe();

  currentConversationId = normalizeConversationKey(adapter.conversationId());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.flycodeSettings) {
      return;
    }
    settings = {
      ...DEFAULT_SETTINGS,
      ...(changes.flycodeSettings.newValue as Partial<ExtensionSettings>)
    };
    reconnectNow();
  });

  const observer = new MutationObserver(() => {
    scheduleScan(240);
    maybeReconnectOnConversationChange();
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  window.setInterval(() => {
    scheduleScan(360);
    maybeReconnectOnConversationChange();
  }, 1600);

  connectWebsocket();
  scheduleScan(600);
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

async function loadTabContext(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: "FLYCODE_GET_TAB_CONTEXT" })) as TabContextResponse;
    if (!response?.ok || typeof response.tabId !== "number" || typeof response.windowId !== "number") {
      throw new Error(response?.message ?? "tab context unavailable");
    }
    tabContext = {
      tabId: response.tabId,
      windowId: response.windowId,
      url: response.url,
      title: response.title
    };
  } catch {
    tabContext = null;
  }
}

async function loadFrontDedupe(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(FRONT_DEDUPE_STORAGE_KEY);
    const raw = stored[FRONT_DEDUPE_STORAGE_KEY] as Record<string, string[]> | undefined;
    if (!raw || typeof raw !== "object") {
      return;
    }
    for (const [sessionId, keys] of Object.entries(raw)) {
      if (!Array.isArray(keys)) continue;
      const filtered = keys
        .filter((item): item is string => typeof item === "string")
        .slice(-getFrontDedupeLimit());
      frontDedupe.set(sessionId, filtered);
      frontDedupeSet.set(sessionId, new Set(filtered));
    }
  } catch {
    // ignore
  }
}

function scheduleScan(delayMs: number): void {
  if (scanTimer !== undefined) {
    window.clearTimeout(scanTimer);
  }
  scanTimer = window.setTimeout(() => {
    void runScan();
  }, delayMs);
}

function maybeReconnectOnConversationChange(): void {
  const nextConversation = normalizeConversationKey(adapter.conversationId());
  if (nextConversation === currentConversationId) {
    return;
  }
  currentConversationId = nextConversation;
  reconnectNow();
}

function reconnectNow(): void {
  if (reconnectTimer !== undefined) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  closeWebsocket();
  connectWebsocket();
}

function connectWebsocket(): void {
  if (!tabContext) {
    void loadTabContext().then(() => {
      if (!tabContext) {
        scheduleReconnect();
        return;
      }
      connectWebsocket();
    });
    return;
  }

  const site = adapter.id;
  if (site !== "qwen" && site !== "deepseek") {
    return;
  }

  const conversationId = normalizeConversationKey(adapter.conversationId());
  currentConversationId = conversationId;

  let wsUrl: URL;
  try {
    wsUrl = buildBridgeWsUrl(settings.appBaseUrl, {
      role: "web",
      site,
      tabId: tabContext.tabId,
      windowId: tabContext.windowId,
      conversationId,
      url: location.href,
      title: document.title
    });
  } catch (error) {
    showFloatingStatus(`Bridge 地址错误: ${(error as Error).message}`, true);
    scheduleReconnect();
    return;
  }

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    sendHelloFrame();
    flushOutboundQueue();
    startPingTimer();
  });

  ws.addEventListener("message", (event) => {
    void handleInboundMessage(event.data);
  });

  ws.addEventListener("close", () => {
    stopPingTimer();
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    stopPingTimer();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) {
    return;
  }
  reconnectAttempts += 1;
  const delay = Math.min(12000, 600 + reconnectAttempts * 800);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connectWebsocket();
  }, delay);
}

function closeWebsocket(): void {
  stopPingTimer();
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
}

function startPingTimer(): void {
  stopPingTimer();
  pingTimer = window.setInterval(() => {
    sendFrame({
      type: "bridge.ping",
      now: new Date().toISOString()
    });
  }, getPingIntervalMs());
}

function stopPingTimer(): void {
  if (pingTimer !== undefined) {
    window.clearInterval(pingTimer);
    pingTimer = undefined;
  }
}

function sendHelloFrame(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "bridge.hello",
      role: "web",
      protocolVersion: BRIDGE_PROTOCOL_VERSION
    })
  );
}

function sendFrame(frame: BridgeClientFrame): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
    return;
  }

  outboundQueue.push(frame);
  while (outboundQueue.length > getOutboundQueueLimit()) {
    outboundQueue.shift();
  }
}

function flushOutboundQueue(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  while (outboundQueue.length > 0) {
    const frame = outboundQueue.shift();
    if (!frame) {
      continue;
    }
    ws.send(JSON.stringify(frame));
  }
}

async function runScan(): Promise<void> {
  const site = adapter.id;
  if (site !== "qwen" && site !== "deepseek") {
    return;
  }

  const sessionId = resolveSessionId(site);
  if (!sessionId) {
    return;
  }

  const blocks = adapter.collectAssistantBlocks();
  let changed = false;

  for (const block of blocks) {
    const source = block.source === "user" ? "user" : "assistant";
    const text = normalizeText(block.text);
    const thinkText = typeof block.meta?.thinkText === "string" ? normalizeText(block.meta.thinkText) : "";
    const answerText = typeof block.meta?.answerText === "string" ? normalizeText(block.meta.answerText) : "";
    const answerMarkdown = typeof block.meta?.answerMarkdown === "string" ? normalizeText(block.meta.answerMarkdown) : "";
    const webReadSummary = typeof block.meta?.webReadSummary === "string" ? normalizeText(block.meta.webReadSummary) : "";
    if (!text) {
      continue;
    }
    if (source === "user" && shouldSuppressHiddenToolEcho(sessionId, text)) {
      continue;
    }

    const messageAnchor = deriveMessageAnchor(block.node);
    const key = hashText(`${source}|${messageAnchor}|${text}`);
    if (hasFrontDedupe(sessionId, key)) {
      continue;
    }
    if (hasRecentTextDuplicate(sessionId, source, text, messageAnchor)) {
      continue;
    }

    rememberFrontDedupe(sessionId, key);
    rememberRecentTextDedupe(sessionId, source, text, messageAnchor);
    changed = true;

    const frame: BridgeChatCaptureFrame = {
      type: "bridge.chat.capture",
      id: randomUUID(),
      sessionId,
      createdAt: new Date().toISOString(),
      payload: {
        source,
        text,
        ...(thinkText ? { thinkText } : {}),
        ...(answerText ? { answerText } : {}),
        ...(answerMarkdown ? { answerMarkdown } : {}),
        ...(webReadSummary ? { webReadSummary } : {}),
        messageAnchor,
        url: location.href,
        title: document.title
      }
    };

    sendFrame(frame);
  }

  if (changed) {
    await persistFrontDedupe();
  }
}

function hasFrontDedupe(sessionId: string, key: string): boolean {
  const set = frontDedupeSet.get(sessionId);
  return set ? set.has(key) : false;
}

function rememberFrontDedupe(sessionId: string, key: string): void {
  let list = frontDedupe.get(sessionId);
  let set = frontDedupeSet.get(sessionId);

  if (!list) {
    list = [];
    frontDedupe.set(sessionId, list);
  }
  if (!set) {
    set = new Set();
    frontDedupeSet.set(sessionId, set);
  }

  if (set.has(key)) {
    return;
  }

  list.push(key);
  set.add(key);

  while (list.length > getFrontDedupeLimit()) {
    const removed = list.shift();
    if (!removed) continue;
    set.delete(removed);
  }
}

function hasRecentTextDuplicate(sessionId: string, source: "assistant" | "user", text: string, messageAnchor: string): boolean {
  const bucket = recentTextDedupe.get(sessionId);
  if (!bucket) {
    return false;
  }
  const now = Date.now();
  const recentWindowMs = 6000;
  for (const [itemKey, ts] of bucket.entries()) {
    if (now - ts > recentWindowMs) {
      bucket.delete(itemKey);
    }
  }
  const anchor = String(messageAnchor ?? "").trim() || "(anchor)";
  const key = `${source}|${anchor}|${hashText(text)}`;
  const ts = bucket.get(key);
  return typeof ts === "number" && now - ts <= recentWindowMs;
}

function rememberRecentTextDedupe(sessionId: string, source: "assistant" | "user", text: string, messageAnchor: string): void {
  let bucket = recentTextDedupe.get(sessionId);
  if (!bucket) {
    bucket = new Map<string, number>();
    recentTextDedupe.set(sessionId, bucket);
  }
  const anchor = String(messageAnchor ?? "").trim() || "(anchor)";
  bucket.set(`${source}|${anchor}|${hashText(text)}`, Date.now());
}

function getFrontDedupeLimit(): number {
  return clampNumber(settings.bridgeFrontDedupeLimit, 200, 20000, 3000);
}

function getOutboundQueueLimit(): number {
  return clampNumber(settings.bridgeOutboundQueueLimit, 20, 1000, 200);
}

function getPingIntervalMs(): number {
  return clampNumber(settings.bridgePingIntervalMs, 2000, 120000, 15000);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const raw = Number(value ?? fallback);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

async function persistFrontDedupe(): Promise<void> {
  const payload: Record<string, string[]> = {};
  for (const [sessionId, list] of frontDedupe.entries()) {
    payload[sessionId] = [...list];
  }
  await chrome.storage.local.set({
    [FRONT_DEDUPE_STORAGE_KEY]: payload
  });
}

async function handleInboundMessage(raw: unknown): Promise<void> {
  let frame: BridgeServerFrame;
  try {
    const value = typeof raw === "string" ? raw : String(raw);
    frame = JSON.parse(value) as BridgeServerFrame;
  } catch {
    return;
  }

  if (frame.type === "bridge.ping") {
    sendFrame({
      type: "bridge.pong",
      now: new Date().toISOString()
    });
    return;
  }

  if (frame.type === "bridge.error") {
    showFloatingStatus(`Bridge 错误: ${frame.message}`, true);
    return;
  }

  if (frame.type === "bridge.chat.send") {
    const expectedSessionId = resolveSessionId(adapter.id);
    const sessionId = String(frame.sessionId ?? frame.payload?.sessionId ?? expectedSessionId ?? "");
    const messageId = String(frame.payload?.messageId ?? randomUUID());
    const text = String(frame.payload?.text ?? "");
    let ok = false;
    let reason: string | undefined;
    const hiddenSend = frame.payload?.hiddenSend === true;
    const preserveInput = frame.payload?.preserveInput === true;
    const sourceTag = String(frame.payload?.source ?? "");

    if (!expectedSessionId || !sessionId || expectedSessionId !== sessionId) {
      reason = "session_mismatch";
    } else {
      try {
        if (hiddenSend && sourceTag === "tool") {
          rememberHiddenToolEcho(sessionId, text);
        }
        ok = await injectAndSubmit(text, { hiddenSend, preserveInput });
        if (!ok) {
          reason = "inject_or_submit_failed";
        }
      } catch (error) {
        const message = error instanceof Error ? error.message.trim() : "";
        reason = message ? `inject_exception:${message.slice(0, 160)}` : "inject_exception";
      }
    }

    sendFrame({
      type: "bridge.chat.send.ack",
      id: randomUUID(),
      sessionId,
      createdAt: new Date().toISOString(),
      payload: {
        sessionId,
        messageId,
        ok,
        ...(ok ? {} : { reason })
      }
    });
    return;
  }

  if (frame.type === "bridge.tool.result") {
    const expectedSessionId = resolveSessionId(adapter.id);
    const sessionId = String(frame.sessionId ?? frame.payload?.sessionId ?? expectedSessionId ?? "");
    const text = String(frame.payload?.text ?? "");

    if (!expectedSessionId || !sessionId || expectedSessionId !== sessionId) {
      return;
    }

    try {
      const ok = await injectAndSubmit(text);
      if (!ok) {
        showFloatingStatus("工具结果已注入输入框，请手动发送", true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : "";
      showFloatingStatus(message ? `工具结果回填失败: ${message}` : "工具结果回填失败", true);
    }
    return;
  }
}

async function injectAndSubmit(
  text: string,
  options?: {
    hiddenSend?: boolean;
    preserveInput?: boolean;
  }
): Promise<boolean> {
  const trimmed = normalizeText(text);
  if (!trimmed) {
    return false;
  }
  const hiddenSend = options?.hiddenSend === true;
  const preserveInput = options?.preserveInput === true;
  const rawCurrent = adapter.getCurrentText();
  const current = normalizeText(rawCurrent);
  const next = hiddenSend ? trimmed : current ? `${current}\n\n${trimmed}` : trimmed;
  const injected = adapter.injectText(next);
  if (!injected) {
    showFloatingStatus("未找到网页输入框", true);
    return false;
  }

  const outcome = await adapter.submitAuto();
  if (hiddenSend && preserveInput) {
    try {
      adapter.injectText(rawCurrent ?? "");
    } catch {
      // ignore restore errors
    }
  }
  if (!outcome.ok) {
    showFloatingStatus("消息已注入输入框，请手动发送", true);
  }
  return outcome.ok;
}

function resolveSessionId(site: SiteId): string | null {
  if (!tabContext) {
    return null;
  }
  if (site !== "qwen" && site !== "deepseek") {
    return null;
  }
  const conversationId = normalizeConversationKey(adapter.conversationId());
  return `${site}:${tabContext.tabId}:${conversationId}`;
}

function buildBridgeWsUrl(
  base: string,
  input: {
    role: "web" | "app";
    site?: "qwen" | "deepseek";
    tabId?: number;
    windowId?: number;
    conversationId?: string;
    url?: string;
    title?: string;
  }
): URL {
  const baseUrl = new URL(base);
  baseUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  baseUrl.pathname = "/v1/bridge/ws";
  baseUrl.searchParams.set("role", input.role);

  if (input.role === "web") {
    if (!input.site || input.tabId === undefined || input.windowId === undefined || !input.conversationId) {
      throw new Error("Missing web websocket query params");
    }
    baseUrl.searchParams.set("site", input.site);
    baseUrl.searchParams.set("tabId", String(input.tabId));
    baseUrl.searchParams.set("windowId", String(input.windowId));
    baseUrl.searchParams.set("conversationId", input.conversationId);
    if (input.url) {
      baseUrl.searchParams.set("url", input.url);
    }
    if (input.title) {
      baseUrl.searchParams.set("title", input.title);
    }
  }

  return baseUrl;
}

function normalizeConversationKey(value: string): string {
  const key = String(value ?? "").trim();
  return key || "(unknown-conversation)";
}

function rememberHiddenToolEcho(sessionId: string, text: string): void {
  const normalized = normalizeText(text);
  if (!sessionId || !normalized) {
    return;
  }
  const list = hiddenToolEchoLedger.get(sessionId) ?? [];
  const prefix = normalized.slice(0, 240);
  list.push({
    fullHash: hashText(normalized),
    prefixHash: hashText(prefix),
    expiresAt: Date.now() + 180_000
  });
  while (list.length > 30) {
    list.shift();
  }
  hiddenToolEchoLedger.set(sessionId, list);
  hiddenToolEchoMuteUntil.set(sessionId, Date.now() + 45_000);
}

function shouldSuppressHiddenToolEcho(sessionId: string, text: string): boolean {
  const list = hiddenToolEchoLedger.get(sessionId);
  const now = Date.now();
  const normalized = normalizeText(text);
  let matched = false;

  if (list && list.length > 0) {
    const fullHash = hashText(normalized);
    const prefixHash = hashText(normalized.slice(0, 240));
    const next = list.filter((item) => {
      if (item.expiresAt <= now) {
        return false;
      }
      if (!matched && (item.fullHash === fullHash || item.prefixHash === prefixHash)) {
        matched = true;
        return false;
      }
      return true;
    });
    if (next.length === 0) {
      hiddenToolEchoLedger.delete(sessionId);
    } else {
      hiddenToolEchoLedger.set(sessionId, next);
    }
  }

  const muteUntil = hiddenToolEchoMuteUntil.get(sessionId) ?? 0;
  if (muteUntil <= now) {
    hiddenToolEchoMuteUntil.delete(sessionId);
  } else if (!matched && looksLikeToolEchoPayload(normalized)) {
    matched = true;
  }
  return matched;
}

function looksLikeToolEchoPayload(text: string): boolean {
  const normalized = normalizeText(text);
  if (normalized.length < 260) {
    return false;
  }
  const hasJsonrpc = /"jsonrpc"\s*:\s*"2\.0"/i.test(normalized);
  if (!hasJsonrpc) {
    return false;
  }
  const hasToolBody = /"result"\s*:|"error"\s*:|"content"\s*:/i.test(normalized);
  if (!hasToolBody) {
    return false;
  }
  const hasCodeFence = /```mcp-response|```json|```/i.test(normalized);
  const hasLargeEscapedText = /\\n|\\t|\\\"/.test(normalized);
  return hasCodeFence || hasLargeEscapedText || normalized.length > 1200;
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim();
}

function deriveMessageAnchor(node: HTMLElement): string {
  const messageRoot = node.closest("[data-message-id], [data-msg-id], [data-id], ._81e7b5e, .qwen-chat-message-assistant, .qwen-chat-message-user");
  if (messageRoot instanceof HTMLElement) {
    const id = messageRoot.getAttribute("data-message-id");
    if (id) return `msg:data-message-id:${id}`;
    const msgId = messageRoot.getAttribute("data-msg-id");
    if (msgId) return `msg:data-msg-id:${msgId}`;
    const dataId = messageRoot.getAttribute("data-id");
    if (dataId) return `msg:data-id:${dataId}`;
    if (messageRoot.id) return `msg:id:${messageRoot.id}`;
    return `msg:${deriveBlockAnchor(messageRoot)}`;
  }
  return `msg:${deriveBlockAnchor(node)}`;
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

function randomUUID(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
