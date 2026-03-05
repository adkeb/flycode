import { randomUUID } from "node:crypto";
import {
  type BridgeChatCaptureFrame,
  type BridgeChatSendAckFrame,
  type BridgeClientFrame,
  type BridgeMessageRecord,
  type BridgePendingToolDecision,
  type BridgeServerFrame,
  type BridgeSessionRef,
  type BridgeToolPendingResolveFrame,
  type McpRequestEnvelope,
  type McpResponseEnvelope,
  type SiteId
} from "@flycode/shared-types";
import type { BridgeHub, BridgeStateStore, McpGateway, ServiceContext } from "../types.js";
import { asAppError, toMcpError } from "./mcp-gateway.js";

type KnownSiteId = Exclude<SiteId, "unknown">;

type ConnectionRole = "web" | "app";

interface SocketLike {
  send(data: string): void;
  on(event: "message", listener: (raw: Buffer | string) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  close(): void;
  readyState: number;
}

interface BridgeConnection {
  id: string;
  role: ConnectionRole;
  socket: SocketLike;
  handshaken: boolean;
  sessionId?: string;
  site?: KnownSiteId;
  tabId?: number;
  windowId?: number;
  conversationId?: string;
}

interface PendingToolDecision {
  id: string;
  sessionId: string;
  site: KnownSiteId;
  envelope: McpRequestEnvelope;
  messageAnchor?: string;
  createdAt: string;
}

const SEND_OPEN = 1;
const BRIDGE_PROTOCOL_VERSION = 4;

export class DefaultBridgeHub implements BridgeHub {
  private readonly connections = new Map<string, BridgeConnection>();
  private readonly webConnectionsBySession = new Map<string, Set<string>>();
  private readonly appConnectionIds = new Set<string>();
  private readonly pendingToolDecisions = new Map<string, PendingToolDecision>();

  constructor(
    private readonly context: ServiceContext,
    private readonly stateStore: BridgeStateStore,
    private readonly mcpGateway: McpGateway
  ) {}

  async bindWebsocket(input: {
    socket: SocketLike;
    role: "web" | "app";
    site?: KnownSiteId;
    tabId?: number;
    windowId?: number;
    conversationId?: string;
    url?: string;
    title?: string;
  }): Promise<void> {
    const connectionId = randomUUID();
    const connection: BridgeConnection = {
      id: connectionId,
      role: input.role,
      socket: input.socket,
      handshaken: false
    };

    if (input.role === "web") {
      const tabId = Number(input.tabId);
      const windowId = Number(input.windowId);
      if (!input.site || !Number.isFinite(tabId) || !Number.isFinite(windowId) || !input.conversationId) {
        throw new Error("Missing web bridge session query params");
      }

      const normalizedTabId = Math.floor(tabId);
      const normalizedWindowId = Math.floor(windowId);
      await this.closeConflictingWebConnections({
        site: input.site,
        tabId: normalizedTabId,
        windowId: normalizedWindowId
      });
      const sessionId = buildSessionId(input.site, normalizedTabId, input.conversationId);
      const now = new Date().toISOString();

      connection.site = input.site;
      connection.tabId = normalizedTabId;
      connection.windowId = normalizedWindowId;
      connection.conversationId = input.conversationId;
      connection.sessionId = sessionId;

      const session: BridgeSessionRef = {
        sessionId,
        site: input.site,
        tabId: normalizedTabId,
        windowId: normalizedWindowId,
        conversationId: input.conversationId,
        url: input.url,
        title: input.title,
        online: true,
        lastActiveAt: now
      };
      await this.stateStore.upsertSession(session);
      await this.markOtherTabSessionsOffline({
        site: input.site,
        tabId: normalizedTabId,
        windowId: normalizedWindowId,
        activeSessionId: sessionId
      });

      let set = this.webConnectionsBySession.get(sessionId);
      if (!set) {
        set = new Set();
        this.webConnectionsBySession.set(sessionId, set);
      }
      set.add(connectionId);
    } else {
      this.appConnectionIds.add(connectionId);
    }

    this.connections.set(connectionId, connection);

    connection.socket.on("message", (raw) => {
      void this.onSocketMessage(connectionId, raw);
    });

    connection.socket.on("close", () => {
      void this.onSocketClose(connectionId);
    });

    connection.socket.on("error", () => {
      // close path handles cleanup
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const normalized = String(sessionId ?? "").trim();
    if (!normalized) {
      return false;
    }

    const ids = [...(this.webConnectionsBySession.get(normalized) ?? [])];
    for (const id of ids) {
      const connection = this.connections.get(id);
      if (!connection) {
        continue;
      }
      await this.onSocketClose(id);
      try {
        connection.socket.close();
      } catch {
        // ignore close errors
      }
    }

    this.webConnectionsBySession.delete(normalized);
    return this.stateStore.deleteSession(normalized);
  }

  async handleFrame(connectionId: string, frame: BridgeClientFrame): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    if (frame.type === "bridge.ping") {
      this.sendFrame(connection, {
        type: "bridge.pong",
        now: new Date().toISOString()
      });
      return;
    }

    if (frame.type === "bridge.hello") {
      await this.handleHelloFrame(connection, frame);
      return;
    }

    if (!connection.handshaken) {
      this.sendFrame(connection, {
        type: "bridge.error",
        code: "HELLO_REQUIRED",
        message: "bridge.hello is required before other frames"
      });
      connection.socket.close();
      return;
    }

    if (frame.type === "bridge.pong" || frame.type === "bridge.ack") {
      return;
    }

    try {
      await this.handleTypedFrame(connection, frame);
      this.sendFrame(connection, {
        type: "bridge.ack",
        id: frame.id,
        ok: true
      });
    } catch (error) {
      this.sendFrame(connection, {
        type: "bridge.ack",
        id: frame.id,
        ok: false,
        message: (error as Error).message
      });
      this.sendFrame(connection, {
        type: "bridge.error",
        code: "FRAME_FAILED",
        message: (error as Error).message
      });
    }
  }

  private async handleHelloFrame(connection: BridgeConnection, frame: Extract<BridgeClientFrame, { type: "bridge.hello" }>): Promise<void> {
    if (connection.handshaken) {
      return;
    }

    if (frame.role !== connection.role) {
      this.sendFrame(connection, {
        type: "bridge.error",
        code: "ROLE_MISMATCH",
        message: `Hello role mismatch: expected ${connection.role}, got ${frame.role}`
      });
      connection.socket.close();
      return;
    }

    if (frame.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      this.sendFrame(connection, {
        type: "bridge.error",
        code: "PROTOCOL_VERSION_MISMATCH",
        message: `Bridge protocol mismatch: expected ${BRIDGE_PROTOCOL_VERSION}, got ${frame.protocolVersion}`
      });
      connection.socket.close();
      return;
    }

    connection.handshaken = true;
    this.sendFrame(connection, {
      type: "bridge.hello.ok",
      role: connection.role,
      now: new Date().toISOString(),
      protocolVersion: BRIDGE_PROTOCOL_VERSION
    });

    if (connection.role === "app") {
      await this.sendSnapshotToApp(connection);
      await this.flushAppOutbound(connection);
      return;
    }

    if (connection.sessionId) {
      const sessions = await this.stateStore.listSessions();
      const session = sessions.find((item) => item.sessionId === connection.sessionId);
      if (session) {
        await this.broadcastToApps(
          {
            type: "bridge.session.upsert",
            id: randomUUID(),
            payload: {
              session
            },
            createdAt: new Date().toISOString()
          },
          connection.sessionId
        );
      }
      await this.flushSessionOutbound(connection.sessionId, "web", connection);
    }
  }

  private async handleTypedFrame(connection: BridgeConnection, frame: BridgeClientFrame): Promise<void> {
    if (connection.role === "web") {
      await this.handleWebFrame(connection, frame);
      return;
    }
    await this.handleAppFrame(frame);
  }

  private async handleWebFrame(connection: BridgeConnection, frame: BridgeClientFrame): Promise<void> {
    if (frame.type === "bridge.chat.capture") {
      await this.handleWebChatCapture(connection, frame);
      return;
    }

    if (frame.type === "bridge.chat.send.ack") {
      const sessionId = connection.sessionId;
      if (!sessionId) {
        return;
      }
      const messageId = String(frame.payload.messageId ?? "").trim();
      const ok = frame.payload.ok === true;
      const reason = typeof frame.payload.reason === "string" && frame.payload.reason.trim() ? frame.payload.reason : undefined;

      if (messageId) {
        await this.stateStore.updateMessageStatus({
          sessionId,
          messageId,
          status: ok ? "sent" : "failed",
          reason
        });
      }

      const ackFrame: BridgeChatSendAckFrame = {
        ...frame,
        sessionId,
        payload: {
          sessionId,
          messageId: messageId || String(frame.payload.messageId ?? ""),
          ok,
          ...(reason ? { reason } : {})
        },
        createdAt: new Date().toISOString()
      };

      await this.broadcastToApps(ackFrame, sessionId);
      return;
    }

    throw new Error(`Unsupported web frame type: ${frame.type}`);
  }

  private async handleAppFrame(frame: BridgeClientFrame): Promise<void> {
    if (frame.type === "bridge.chat.send") {
      const sessionId = String(frame.payload.sessionId ?? frame.sessionId ?? "").trim();
      const text = normalizeText(String(frame.payload.text ?? ""));
      if (!sessionId || !text) {
        return;
      }

      const now = new Date().toISOString();
      const messageId = typeof frame.payload.messageId === "string" && frame.payload.messageId.trim() ? frame.payload.messageId : randomUUID();
      let site: KnownSiteId;
      try {
        site = parseSiteFromSessionId(sessionId);
      } catch {
        return;
      }

      const record: BridgeMessageRecord = {
        id: messageId,
        sessionId,
        site,
        source: "app",
        eventType: "bridge.chat.send",
        text,
        createdAt: now,
        status: "queued"
      };

      await this.stateStore.appendMessage(record);
      await this.sendToSessionWeb(sessionId, {
        type: "bridge.chat.send",
        id: randomUUID(),
        sessionId,
        payload: {
          sessionId,
          messageId,
          text
        },
        createdAt: now
      });

      await this.broadcastToApps(
        {
          type: "bridge.chat.message",
          id: randomUUID(),
          sessionId,
          payload: {
            sessionId,
            record
          },
          createdAt: now
        },
        sessionId
      );
      return;
    }

    if (frame.type === "bridge.tool.pending.resolve") {
      await this.handlePendingResolve(frame);
      return;
    }

    throw new Error(`Unsupported app frame type: ${frame.type}`);
  }

  private async handlePendingResolve(frame: BridgeToolPendingResolveFrame): Promise<void> {
    const pendingId = String(frame.payload.pendingId ?? "");
    const decision = String(frame.payload.decision ?? "");
    const pending = this.pendingToolDecisions.get(pendingId);
    if (!pending) {
      return;
    }

    this.pendingToolDecisions.delete(pendingId);

    if (decision !== "approve") {
      const rejected = buildRejectedEnvelope(pending.envelope.id);
      await this.emitToolResult(pending.sessionId, rejected);
      return;
    }

    let envelope = pending.envelope;
    const patched = frame.payload.envelope;
    if (patched && typeof patched === "object") {
      envelope = patched;
    }

    const response = await this.dispatchMcpAndResolveConfirmations(pending.site, envelope, `bridge-${randomUUID()}`);
    await this.emitToolResult(pending.sessionId, response);
  }

  private async handleWebChatCapture(connection: BridgeConnection, frame: BridgeChatCaptureFrame): Promise<void> {
    if (!connection.sessionId || !connection.site || connection.tabId === undefined || connection.windowId === undefined || !connection.conversationId) {
      return;
    }

    const source = frame.payload.source === "user" ? "user" : "assistant";
    const text = normalizeText(String(frame.payload.text ?? ""));
    const thinkText = normalizeText(String(frame.payload.thinkText ?? ""));
    const answerText = normalizeText(String(frame.payload.answerText ?? ""));
    const answerMarkdown = normalizeText(String(frame.payload.answerMarkdown ?? ""));
    const webReadSummary = normalizeText(String(frame.payload.webReadSummary ?? ""));
    const normalizedText = source === "assistant" ? answerText || text : text;
    const dedupeText = source === "assistant" && thinkText ? `${thinkText}\n\n${normalizedText}` : normalizedText;
    if (!normalizedText) {
      return;
    }

    const messageAnchor = String(frame.payload.messageAnchor ?? "").trim() || "(anchor)";
    const createdAt = new Date().toISOString();

    const messageDedupeKey = buildMessageDedupeKey({
      site: connection.site,
      tabId: connection.tabId,
      conversationId: connection.conversationId,
      messageAnchor,
      text: dedupeText
    });
    if (await this.stateStore.hasDedupeKey(messageDedupeKey)) {
      return;
    }
    await this.stateStore.rememberDedupeKey(messageDedupeKey);

    const session: BridgeSessionRef = {
      sessionId: connection.sessionId,
      site: connection.site,
      tabId: connection.tabId,
      windowId: connection.windowId,
      conversationId: connection.conversationId,
      url: frame.payload.url,
      title: frame.payload.title,
      online: true,
      lastActiveAt: createdAt
    };
    await this.stateStore.upsertSession(session);

    await this.broadcastToApps(
      {
        type: "bridge.session.upsert",
        id: randomUUID(),
        payload: {
          session
        },
        createdAt
      },
      connection.sessionId
    );

    const messageRecord: BridgeMessageRecord = {
      id: randomUUID(),
      sessionId: connection.sessionId,
      site: connection.site,
      source,
      eventType: "bridge.chat.message",
      text: normalizedText,
      createdAt,
      messageAnchor,
      status: "done",
      meta:
        source === "assistant"
          ? {
              ...(thinkText ? { thinkText } : {}),
              ...(answerText ? { answerText } : {}),
              ...(answerMarkdown ? { answerMarkdown } : {}),
              ...(webReadSummary ? { webReadSummary } : {})
            }
          : undefined
    };

    await this.stateStore.appendMessage(messageRecord);
    await this.broadcastToApps(
      {
        type: "bridge.chat.message",
        id: randomUUID(),
        sessionId: connection.sessionId,
        payload: {
          sessionId: connection.sessionId,
          record: messageRecord,
          session
        },
        createdAt
      },
      connection.sessionId
    );

    if (source !== "assistant") {
      return;
    }

    const parsed = parseMcpRequestBlock(text);
    if (!parsed) {
      return;
    }

    const toolDedupeKey = buildToolDedupeKey({
      site: connection.site,
      tabId: connection.tabId,
      conversationId: connection.conversationId,
      messageAnchor,
      requestId: parsed.id,
      requestHash: parsed.requestHash
    });

    if (await this.stateStore.hasDedupeKey(toolDedupeKey)) {
      return;
    }
    await this.stateStore.rememberDedupeKey(toolDedupeKey);

    const config = await this.context.appConfigManager.load();
    if (config.bridge.toolInterceptDefault === "manual") {
      const pendingId = randomUUID();
      const pendingItem: PendingToolDecision = {
        id: pendingId,
        sessionId: connection.sessionId,
        site: connection.site,
        envelope: parsed.envelope,
        messageAnchor,
        createdAt: new Date().toISOString()
      };
      this.pendingToolDecisions.set(pendingId, pendingItem);

      const pendingPayload: BridgePendingToolDecision = {
        pendingId,
        sessionId: connection.sessionId,
        envelope: parsed.envelope,
        messageAnchor,
        createdAt: pendingItem.createdAt
      };

      await this.broadcastToApps(
        {
          type: "bridge.tool.pending",
          id: randomUUID(),
          sessionId: connection.sessionId,
          payload: pendingPayload,
          createdAt: pendingItem.createdAt
        },
        connection.sessionId
      );
      return;
    }

    const response = await this.dispatchMcpAndResolveConfirmations(connection.site, parsed.envelope, `bridge-${randomUUID()}`);
    await this.emitToolResult(connection.sessionId, response);
  }

  private async dispatchMcpAndResolveConfirmations(
    site: KnownSiteId,
    envelope: McpRequestEnvelope,
    traceId: string
  ): Promise<McpResponseEnvelope> {
    const startedAt = Date.now();
    let response: McpResponseEnvelope;

    try {
      response = await this.mcpGateway.dispatch(site, envelope, traceId);
    } catch (error: unknown) {
      const appError = asAppError(error);
      response = {
        jsonrpc: "2.0",
        id: envelope?.id ?? null,
        error: toMcpError(appError)
      };
    }

    const pendingId = getPendingConfirmationId(response);
    if (pendingId) {
      response = await this.waitForConfirmationAndRetry(site, envelope, pendingId, response, traceId);
    }

    await this.context.consoleEventLogger.log({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      site,
      method: envelope.method,
      tool: envelope.method === "tools/call" ? (envelope.params as { name?: string } | undefined)?.name : undefined,
      status: this.mcpGateway.classifyStatus(response),
      durationMs: Date.now() - startedAt,
      request: envelope,
      response
    });

    return response;
  }

  private async waitForConfirmationAndRetry(
    site: KnownSiteId,
    envelope: McpRequestEnvelope,
    confirmationId: string,
    fallback: McpResponseEnvelope,
    traceId: string
  ): Promise<McpResponseEnvelope> {
    const appConfig = await this.context.appConfigManager.load();
    const waitTimeoutMs = Math.max(5_000, Math.min(600_000, appConfig.bridge.confirmationWaitTimeoutMs));
    const pollIntervalMs = Math.max(200, Math.min(10_000, appConfig.bridge.confirmationPollIntervalMs));
    const deadline = Date.now() + waitTimeoutMs;

    while (Date.now() < deadline) {
      const status = await this.context.confirmationManager.getById(confirmationId);
      if (status) {
        if (status.status === "approved") {
          try {
            return await this.mcpGateway.dispatch(site, withConfirmationId(envelope, confirmationId), traceId);
          } catch (error) {
            const appError = asAppError(error);
            return {
              jsonrpc: "2.0",
              id: envelope?.id ?? null,
              error: toMcpError(appError)
            };
          }
        }
        if (status.status === "rejected" || status.status === "timeout") {
          return {
            jsonrpc: "2.0",
            id: envelope?.id ?? null,
            error: {
              code: -32000,
              message: `Confirmation ${status.status}`
            }
          };
        }
      }
      await sleep(pollIntervalMs);
    }

    return fallback;
  }

  private async emitToolResult(sessionId: string, envelope: McpResponseEnvelope): Promise<void> {
    const now = new Date().toISOString();
    const text = formatMcpResponse(envelope);
    const site = parseSiteFromSessionId(sessionId);

    const record: BridgeMessageRecord = {
      id: randomUUID(),
      sessionId,
      site,
      source: "tool",
      eventType: "bridge.tool.result",
      text,
      createdAt: now,
      status: "done",
      meta: {
        envelope
      }
    };

    await this.stateStore.appendMessage(record);

    const frame: BridgeServerFrame = {
      type: "bridge.tool.result",
      id: randomUUID(),
      sessionId,
      payload: {
        sessionId,
        envelope,
        text,
        record
      },
      createdAt: now
    };

    await this.sendToSessionWeb(sessionId, {
      type: "bridge.chat.send",
      id: randomUUID(),
      sessionId,
      payload: {
        sessionId,
        messageId: randomUUID(),
        text,
        hiddenSend: true,
        preserveInput: true,
        source: "tool"
      },
      createdAt: now
    });
    await this.broadcastToApps(frame, sessionId);
  }

  private async sendSnapshotToApp(connection: BridgeConnection): Promise<void> {
    const snapshot = await this.stateStore.loadSnapshot();
    const appConfig = await this.context.appConfigManager.load();
    const replayLimit = appConfig.bridge.sessionReplayLimit;

    const messagesBySession: Record<string, BridgeMessageRecord[]> = {};
    for (const [sessionId, list] of Object.entries(snapshot.messagesBySession)) {
      messagesBySession[sessionId] = list.slice(-replayLimit);
    }

    this.sendFrame(connection, {
      type: "bridge.snapshot",
      sessions: snapshot.sessions,
      messagesBySession,
      pendingBySession: this.groupPendingBySession(),
      bridgeConfigSummary: {
        dedupeMaxEntries: appConfig.bridge.dedupeMaxEntries,
        sessionReplayLimit: appConfig.bridge.sessionReplayLimit,
        offlineQueuePerSession: appConfig.bridge.offlineQueuePerSession,
        toolInterceptDefault: appConfig.bridge.toolInterceptDefault
      }
    });
  }

  private groupPendingBySession(): Record<string, BridgePendingToolDecision[]> {
    const out: Record<string, BridgePendingToolDecision[]> = {};
    for (const item of this.pendingToolDecisions.values()) {
      if (!out[item.sessionId]) {
        out[item.sessionId] = [];
      }
      out[item.sessionId].push({
        pendingId: item.id,
        sessionId: item.sessionId,
        envelope: item.envelope,
        messageAnchor: item.messageAnchor,
        createdAt: item.createdAt
      });
    }

    for (const [sessionId, list] of Object.entries(out)) {
      out[sessionId] = list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }

    return out;
  }

  private async flushAppOutbound(connection: BridgeConnection): Promise<void> {
    const snapshot = await this.stateStore.loadSnapshot();
    for (const sessionId of Object.keys(snapshot.pendingOutbound)) {
      const frames = await this.stateStore.dequeueOutbound(sessionId, "app");
      for (const frame of frames) {
        if (!this.sendFrame(connection, frame)) {
          await this.stateStore.enqueueOutbound(sessionId, "app", frame);
        }
      }
    }
  }

  private async flushSessionOutbound(sessionId: string, targetRole: "web" | "app", connection?: BridgeConnection): Promise<void> {
    const frames = await this.stateStore.dequeueOutbound(sessionId, targetRole);
    if (frames.length === 0) {
      return;
    }

    if (targetRole === "web") {
      if (connection) {
        for (const frame of frames) {
          if (!this.sendFrame(connection, frame)) {
            await this.stateStore.enqueueOutbound(sessionId, "web", frame);
          }
        }
        return;
      }

      const ids = this.webConnectionsBySession.get(sessionId);
      if (!ids || ids.size === 0) {
        for (const frame of frames) {
          await this.stateStore.enqueueOutbound(sessionId, "web", frame);
        }
        return;
      }
      for (const frame of frames) {
        let delivered = false;
        for (const id of ids) {
          const item = this.connections.get(id);
          if (!item) continue;
          delivered = this.sendFrame(item, frame) || delivered;
        }
        if (!delivered) {
          await this.stateStore.enqueueOutbound(sessionId, "web", frame);
        }
      }
      return;
    }

    if (connection) {
      for (const frame of frames) {
        if (!this.sendFrame(connection, frame)) {
          await this.stateStore.enqueueOutbound(sessionId, "app", frame);
        }
      }
      return;
    }

    if (this.appConnectionIds.size === 0) {
      for (const frame of frames) {
        await this.stateStore.enqueueOutbound(sessionId, "app", frame);
      }
      return;
    }

    for (const frame of frames) {
      let delivered = false;
      for (const id of this.appConnectionIds) {
        const item = this.connections.get(id);
        if (!item) continue;
        delivered = this.sendFrame(item, frame) || delivered;
      }
      if (!delivered) {
        await this.stateStore.enqueueOutbound(sessionId, "app", frame);
      }
    }
  }

  private async sendToSessionWeb(sessionId: string, frame: BridgeServerFrame): Promise<void> {
    const ids = this.webConnectionsBySession.get(sessionId);
    if (!ids || ids.size === 0) {
      await this.stateStore.enqueueOutbound(sessionId, "web", frame);
      return;
    }

    let delivered = false;
    for (const id of ids) {
      const connection = this.connections.get(id);
      if (!connection) {
        continue;
      }
      delivered = this.sendFrame(connection, frame) || delivered;
    }

    if (!delivered) {
      await this.stateStore.enqueueOutbound(sessionId, "web", frame);
    }
  }

  private async broadcastToApps(frame: BridgeServerFrame, sessionId?: string): Promise<void> {
    if (this.appConnectionIds.size === 0) {
      if (sessionId) {
        await this.stateStore.enqueueOutbound(sessionId, "app", frame);
      }
      return;
    }

    let delivered = false;
    for (const id of this.appConnectionIds) {
      const connection = this.connections.get(id);
      if (!connection) {
        continue;
      }
      delivered = this.sendFrame(connection, frame) || delivered;
    }

    if (!delivered && sessionId) {
      await this.stateStore.enqueueOutbound(sessionId, "app", frame);
    }
  }

  private async onSocketMessage(connectionId: string, raw: Buffer | string): Promise<void> {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let frame: BridgeClientFrame;

    try {
      frame = JSON.parse(text) as BridgeClientFrame;
    } catch {
      const connection = this.connections.get(connectionId);
      if (connection) {
        this.sendFrame(connection, {
          type: "bridge.error",
          code: "INVALID_JSON",
          message: "Invalid JSON frame"
        });
      }
      return;
    }

    await this.handleFrame(connectionId, frame);
  }

  private async onSocketClose(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }
    this.connections.delete(connectionId);

    if (connection.role === "app") {
      this.appConnectionIds.delete(connectionId);
      return;
    }

    if (!connection.sessionId) {
      return;
    }

    const set = this.webConnectionsBySession.get(connection.sessionId);
    if (!set) {
      return;
    }

    set.delete(connectionId);
    if (set.size > 0) {
      return;
    }

    this.webConnectionsBySession.delete(connection.sessionId);

    const sessions = await this.stateStore.listSessions();
    const target = sessions.find((item) => item.sessionId === connection.sessionId);
    if (!target) {
      return;
    }

    const offlineAt = new Date().toISOString();
    await this.stateStore.upsertSession({
      ...target,
      online: false,
      lastActiveAt: offlineAt
    });

    await this.broadcastToApps(
      {
        type: "bridge.session.offline",
        id: randomUUID(),
        payload: {
          sessionId: connection.sessionId,
          lastActiveAt: offlineAt
        },
        createdAt: offlineAt
      },
      connection.sessionId
    );
  }

  private async closeConflictingWebConnections(input: { site: KnownSiteId; tabId: number; windowId: number }): Promise<void> {
    const conflicts = [...this.connections.values()].filter(
      (item) => item.role === "web" && item.site === input.site && item.tabId === input.tabId && item.windowId === input.windowId
    );
    for (const conflict of conflicts) {
      await this.onSocketClose(conflict.id);
      try {
        conflict.socket.close();
      } catch {
        // ignore close errors from stale browser sockets
      }
    }
  }

  private async markOtherTabSessionsOffline(input: {
    site: KnownSiteId;
    tabId: number;
    windowId: number;
    activeSessionId: string;
  }): Promise<void> {
    const sessions = await this.stateStore.listSessions();
    const offlineAt = new Date().toISOString();
    for (const session of sessions) {
      if (session.site !== input.site || session.tabId !== input.tabId || session.windowId !== input.windowId) {
        continue;
      }
      if (session.sessionId === input.activeSessionId || !session.online) {
        continue;
      }

      await this.stateStore.upsertSession({
        ...session,
        online: false,
        lastActiveAt: offlineAt
      });
      await this.broadcastToApps(
        {
          type: "bridge.session.offline",
          id: randomUUID(),
          payload: {
            sessionId: session.sessionId,
            lastActiveAt: offlineAt
          },
          createdAt: offlineAt
        },
        session.sessionId
      );
    }
  }

  private sendFrame(connection: BridgeConnection, frame: BridgeServerFrame): boolean {
    if (connection.socket.readyState !== SEND_OPEN) {
      return false;
    }
    try {
      connection.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }
}

function buildSessionId(site: KnownSiteId, tabId: number, conversationId: string): string {
  return `${site}:${Math.floor(tabId)}:${conversationId}`;
}

function parseSiteFromSessionId(sessionId: string): KnownSiteId {
  const site = sessionId.split(":", 1)[0];
  if (site === "qwen" || site === "deepseek" || site === "gemini") {
    return site;
  }
  throw new Error(`Invalid site in sessionId: ${sessionId}`);
}

function parseMcpRequestBlock(raw: string): { id: string; envelope: McpRequestEnvelope; requestHash: string } | null {
  const normalized = normalizeText(raw);
  if (!normalized) {
    return null;
  }

  const payload = extractPayload(normalized);
  if (!payload) {
    return null;
  }

  let envelope: McpRequestEnvelope;
  try {
    envelope = JSON.parse(payload) as McpRequestEnvelope;
  } catch {
    return null;
  }

  if (
    envelope.jsonrpc !== "2.0" ||
    (envelope.method !== "initialize" && envelope.method !== "tools/list" && envelope.method !== "tools/call")
  ) {
    return null;
  }

  const id = typeof envelope.id === "string" || typeof envelope.id === "number" ? String(envelope.id) : "";
  if (!id) {
    return null;
  }

  const canonical = JSON.stringify({
    jsonrpc: envelope.jsonrpc,
    id: envelope.id,
    method: envelope.method,
    params: envelope.params ?? null
  });

  return {
    id,
    envelope,
    requestHash: hashText(canonical)
  };
}

function extractPayload(text: string): string | null {
  const fenced = text.match(/^`{3,}\s*mcp-request\s*\n([\s\S]*?)\n`{3,}\s*$/i);
  if (fenced) {
    return normalizeJsonPayload(fenced[1]);
  }

  const openFenceOnly = text.match(/^`{3,}\s*mcp-request\s*\n([\s\S]+)$/i);
  if (openFenceOnly) {
    return normalizeJsonPayload(openFenceOnly[1]);
  }

  const plainHeader = text.match(/^mcp-request\s*\n([\s\S]+)$/i);
  if (plainHeader) {
    return normalizeJsonPayload(plainHeader[1]);
  }

  return normalizeJsonPayload(text);
}

function normalizeJsonPayload(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const jsonLang = trimmed.match(/^json\s*\n([\s\S]+)$/i);
  if (jsonLang) {
    return normalizeJsonPayload(jsonLang[1]);
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function buildMessageDedupeKey(input: {
  site: KnownSiteId;
  tabId: number;
  conversationId: string;
  messageAnchor: string;
  text: string;
}): string {
  return `msg:${input.site}|${input.tabId}|${input.conversationId}|${input.messageAnchor}|${hashText(input.text)}`;
}

function buildToolDedupeKey(input: {
  site: KnownSiteId;
  tabId: number;
  conversationId: string;
  messageAnchor: string;
  requestId: string;
  requestHash: string;
}): string {
  return `tool:${input.site}|${input.tabId}|${input.conversationId}|${input.messageAnchor}|${input.requestId}|${input.requestHash}`;
}

function formatMcpResponse(response: McpResponseEnvelope): string {
  return ["```mcp-response", JSON.stringify(response, null, 2), "```"].join("\n");
}

function getPendingConfirmationId(response: McpResponseEnvelope): string | null {
  const result = response.result as { meta?: { pendingConfirmationId?: unknown } } | undefined;
  if (!result || !result.meta || typeof result.meta.pendingConfirmationId !== "string") {
    return null;
  }
  return result.meta.pendingConfirmationId;
}

function withConfirmationId(envelope: McpRequestEnvelope, confirmationId: string): McpRequestEnvelope {
  if (envelope.method !== "tools/call") {
    return envelope;
  }
  const params =
    envelope.params && typeof envelope.params === "object" ? (envelope.params as Record<string, unknown>) : {};

  return {
    ...envelope,
    params: {
      ...params,
      confirmationId
    }
  };
}

function buildRejectedEnvelope(id: string | number): McpResponseEnvelope {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: "Manual tool decision rejected"
    }
  };
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim();
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
