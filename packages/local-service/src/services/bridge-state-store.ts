import fs from "node:fs/promises";
import path from "node:path";
import type { BridgeMessageRecord, BridgeServerFrame, BridgeSessionRef } from "@flycode/shared-types";
import { getFlycodeHomeDir } from "../config/policy.js";
import type { AppConfigManager, BridgeStateSnapshot, BridgeStateStore } from "../types.js";

interface DiskBridgeState extends BridgeStateSnapshot {}

const BRIDGE_STATE_FILE = "bridge-state.json";

export class JsonBridgeStateStore implements BridgeStateStore {
  private state: DiskBridgeState | null = null;
  private readonly dedupeSet = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly appConfigManager: AppConfigManager) {}

  async loadSnapshot(): Promise<BridgeStateSnapshot> {
    const state = await this.ensureStateLoaded();
    return cloneState(state);
  }

  async listSessions(): Promise<BridgeSessionRef[]> {
    const state = await this.ensureStateLoaded();
    return state.sessions.map((item) => ({ ...item }));
  }

  async listMessages(sessionId: string, limit?: number): Promise<BridgeMessageRecord[]> {
    const state = await this.ensureStateLoaded();
    const all = state.messagesBySession[sessionId] ?? [];
    if (!limit || !Number.isFinite(limit) || limit <= 0) {
      return all.map((item) => ({ ...item, meta: item.meta ? { ...item.meta } : undefined }));
    }
    return all.slice(-Math.floor(limit)).map((item) => ({ ...item, meta: item.meta ? { ...item.meta } : undefined }));
  }

  async upsertSession(session: BridgeSessionRef): Promise<void> {
    await this.withState(async (state) => {
      const index = state.sessions.findIndex((item) => item.sessionId === session.sessionId);
      if (index >= 0) {
        state.sessions[index] = {
          ...state.sessions[index],
          ...session,
          lastActiveAt: session.lastActiveAt
        };
      } else {
        state.sessions.push({ ...session });
      }
      state.sessions.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
      if (state.sessions.length > 5000) {
        state.sessions = state.sessions.slice(0, 5000);
      }
    });
  }

  async appendMessage(record: BridgeMessageRecord): Promise<void> {
    await this.withState(async (state) => {
      const config = await this.appConfigManager.load();
      const replayLimit = Math.max(20, Math.min(2000, config.bridge.sessionReplayLimit));
      const list = state.messagesBySession[record.sessionId] ?? [];
      list.push({ ...record, meta: record.meta ? { ...record.meta } : undefined });
      while (list.length > replayLimit) {
        list.shift();
      }
      state.messagesBySession[record.sessionId] = list;

      const index = state.sessions.findIndex((item) => item.sessionId === record.sessionId);
      if (index >= 0) {
        state.sessions[index] = {
          ...state.sessions[index],
          lastActiveAt: record.createdAt
        };
      }
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    let deleted = false;
    await this.withState(async (state) => {
      const normalized = String(sessionId ?? "").trim();
      if (!normalized) {
        return;
      }

      const beforeSessions = state.sessions.length;
      state.sessions = state.sessions.filter((item) => item.sessionId !== normalized);

      const hadMessages = Object.prototype.hasOwnProperty.call(state.messagesBySession, normalized);
      if (hadMessages) {
        delete state.messagesBySession[normalized];
      }

      const hadPending = Object.prototype.hasOwnProperty.call(state.pendingOutbound, normalized);
      if (hadPending) {
        delete state.pendingOutbound[normalized];
      }

      deleted = beforeSessions !== state.sessions.length || hadMessages || hadPending;
      if (!deleted) {
        return;
      }

      const dedupeNeedle = dedupeNeedleForSession(normalized);
      if (dedupeNeedle) {
        state.dedupeLedger = state.dedupeLedger.filter((item) => !item.includes(dedupeNeedle));
      }
      this.dedupeSet.clear();
      for (const key of state.dedupeLedger) {
        this.dedupeSet.add(key);
      }
    });
    return deleted;
  }

  async updateMessageStatus(input: { sessionId: string; messageId: string; status: "queued" | "sent" | "failed" | "done"; reason?: string }): Promise<void> {
    await this.withState(async (state) => {
      const sessionId = String(input.sessionId ?? "").trim();
      const messageId = String(input.messageId ?? "").trim();
      if (!sessionId || !messageId) {
        return;
      }

      const list = state.messagesBySession[sessionId];
      if (!Array.isArray(list) || list.length === 0) {
        return;
      }

      for (let index = 0; index < list.length; index += 1) {
        const row = list[index];
        if (row.id !== messageId) {
          continue;
        }

        const meta = { ...(row.meta ?? {}) };
        if (input.reason) {
          meta.reason = input.reason;
        } else {
          delete meta.reason;
        }

        list[index] = {
          ...row,
          status: input.status,
          meta: Object.keys(meta).length > 0 ? meta : undefined
        };
      }
    });
  }

  async hasDedupeKey(key: string): Promise<boolean> {
    await this.ensureStateLoaded();
    return this.dedupeSet.has(key);
  }

  async rememberDedupeKey(key: string): Promise<void> {
    await this.withState(async (state) => {
      if (this.dedupeSet.has(key)) {
        return;
      }

      this.dedupeSet.add(key);
      state.dedupeLedger.push(key);

      const config = await this.appConfigManager.load();
      const maxEntries = Math.max(1000, Math.min(1_000_000, config.bridge.dedupeMaxEntries));
      while (state.dedupeLedger.length > maxEntries) {
        const removed = state.dedupeLedger.shift();
        if (removed) {
          this.dedupeSet.delete(removed);
        }
      }
    });
  }

  async enqueueOutbound(sessionId: string, targetRole: "web" | "app", frame: BridgeServerFrame): Promise<void> {
    await this.withState(async (state) => {
      const config = await this.appConfigManager.load();
      const maxQueue = Math.max(20, Math.min(1000, config.bridge.offlineQueuePerSession));
      const target = ensurePendingBucket(state, sessionId);
      const list = target[targetRole];
      list.push(cloneFrame(frame));
      while (list.length > maxQueue) {
        list.shift();
      }
    });
  }

  async dequeueOutbound(sessionId: string, targetRole: "web" | "app"): Promise<BridgeServerFrame[]> {
    let out: BridgeServerFrame[] = [];
    await this.withState(async (state) => {
      const bucket = ensurePendingBucket(state, sessionId);
      out = bucket[targetRole].map((item) => cloneFrame(item));
      bucket[targetRole] = [];
    });
    return out;
  }

  private async withState(fn: (state: DiskBridgeState) => Promise<void>): Promise<void> {
    const run = async () => {
      const state = await this.ensureStateLoaded();
      await fn(state);
      await this.persist(state);
    };

    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }

  private async ensureStateLoaded(): Promise<DiskBridgeState> {
    if (this.state) {
      return this.state;
    }

    const filePath = getBridgeStateFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DiskBridgeState>;
      this.state = normalizeState(parsed);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.state = defaultState();
      await this.persist(this.state);
    }

    this.dedupeSet.clear();
    for (const key of this.state.dedupeLedger) {
      this.dedupeSet.add(key);
    }

    return this.state;
  }

  private async persist(state: DiskBridgeState): Promise<void> {
    const filePath = getBridgeStateFilePath();
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  }
}

function defaultState(): DiskBridgeState {
  return {
    sessions: [],
    messagesBySession: {},
    dedupeLedger: [],
    pendingOutbound: {}
  };
}

function normalizeState(input: Partial<DiskBridgeState>): DiskBridgeState {
  const sessions = Array.isArray(input.sessions)
    ? input.sessions.filter(isSession).map((item) => ({ ...item, online: false }))
    : [];

  const messagesBySession: Record<string, BridgeMessageRecord[]> = {};
  if (input.messagesBySession && typeof input.messagesBySession === "object") {
    for (const [sessionId, messages] of Object.entries(input.messagesBySession)) {
      if (!Array.isArray(messages)) {
        continue;
      }
      messagesBySession[sessionId] = messages.filter(isMessageRecord).map((item) => ({ ...item }));
    }
  }

  const dedupeLedger = Array.isArray(input.dedupeLedger)
    ? input.dedupeLedger.filter((item): item is string => typeof item === "string")
    : [];

  const pendingOutbound: Record<string, { web: BridgeServerFrame[]; app: BridgeServerFrame[] }> = {};
  if (input.pendingOutbound && typeof input.pendingOutbound === "object") {
    for (const [sessionId, value] of Object.entries(input.pendingOutbound)) {
      const web = Array.isArray(value?.web) ? value.web.map((item) => cloneFrame(item as BridgeServerFrame)) : [];
      const app = Array.isArray(value?.app) ? value.app.map((item) => cloneFrame(item as BridgeServerFrame)) : [];
      pendingOutbound[sessionId] = { web, app };
    }
  }

  return {
    sessions,
    messagesBySession,
    dedupeLedger,
    pendingOutbound
  };
}

function isSession(value: unknown): value is BridgeSessionRef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Partial<BridgeSessionRef>;
  return (
    typeof v.sessionId === "string" &&
    (v.site === "qwen" || v.site === "deepseek" || v.site === "gemini") &&
    typeof v.tabId === "number" &&
    typeof v.windowId === "number" &&
    typeof v.conversationId === "string" &&
    typeof v.lastActiveAt === "string" &&
    typeof v.online === "boolean"
  );
}

function isMessageRecord(value: unknown): value is BridgeMessageRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Partial<BridgeMessageRecord>;
  return (
    typeof v.id === "string" &&
    typeof v.sessionId === "string" &&
    (v.site === "qwen" || v.site === "deepseek" || v.site === "gemini") &&
    typeof v.text === "string" &&
    typeof v.createdAt === "string" &&
    (v.source === "assistant" || v.source === "user" || v.source === "app" || v.source === "tool")
  );
}

function ensurePendingBucket(
  state: DiskBridgeState,
  sessionId: string
): { web: BridgeServerFrame[]; app: BridgeServerFrame[] } {
  const current = state.pendingOutbound[sessionId];
  if (current) {
    return current;
  }
  const next = { web: [], app: [] };
  state.pendingOutbound[sessionId] = next;
  return next;
}

function cloneState(state: DiskBridgeState): BridgeStateSnapshot {
  return {
    sessions: state.sessions.map((item) => ({ ...item })),
    messagesBySession: Object.fromEntries(
      Object.entries(state.messagesBySession).map(([key, list]) => [
        key,
        list.map((item) => ({ ...item, meta: item.meta ? { ...item.meta } : undefined }))
      ])
    ),
    dedupeLedger: [...state.dedupeLedger],
    pendingOutbound: Object.fromEntries(
      Object.entries(state.pendingOutbound).map(([key, value]) => [
        key,
        {
          web: value.web.map((item) => cloneFrame(item)),
          app: value.app.map((item) => cloneFrame(item))
        }
      ])
    )
  };
}

function cloneFrame(frame: BridgeServerFrame): BridgeServerFrame {
  return JSON.parse(JSON.stringify(frame)) as BridgeServerFrame;
}

function dedupeNeedleForSession(sessionId: string): string | null {
  const parts = sessionId.split(":");
  if (parts.length < 3) {
    return null;
  }
  const site = parts[0];
  const tabId = parts[1];
  const conversationId = parts.slice(2).join(":");
  if (!site || !tabId || !conversationId) {
    return null;
  }
  return `${site}|${tabId}|${conversationId}|`;
}

function getBridgeStateFilePath(): string {
  return path.join(getFlycodeHomeDir(), BRIDGE_STATE_FILE);
}
