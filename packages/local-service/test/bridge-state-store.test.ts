import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfigData, AppConfigManager } from "../src/types.js";
import { JsonBridgeStateStore } from "../src/services/bridge-state-store.js";

class TestAppConfigManager implements AppConfigManager {
  constructor(private readonly config: AppConfigData) {}

  async load(): Promise<AppConfigData> {
    return this.config;
  }

  async save(next: AppConfigData): Promise<AppConfigData> {
    return next;
  }

  async updateAlwaysAllow(): Promise<AppConfigData> {
    return this.config;
  }
}

function createConfig(overrides?: Partial<AppConfigData["bridge"]>): AppConfigData {
  return {
    theme: "system",
    logRetentionDays: 30,
    servicePort: 39393,
    alwaysAllow: {},
    bridge: {
      dedupeMaxEntries: overrides?.dedupeMaxEntries ?? 1000,
      sessionReplayLimit: overrides?.sessionReplayLimit ?? 500,
      offlineQueuePerSession: overrides?.offlineQueuePerSession ?? 200,
      toolInterceptDefault: overrides?.toolInterceptDefault ?? "auto",
      confirmationWaitTimeoutMs: 125_000,
      confirmationPollIntervalMs: 1_200
    }
  };
}

describe("JsonBridgeStateStore", () => {
  it("enforces dedupe ledger max entries with LRU behavior", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "flycode-bridge-home-"));
    process.env.HOME = home;

    const store = new JsonBridgeStateStore(new TestAppConfigManager(createConfig({ dedupeMaxEntries: 1000 })));

    for (let i = 0; i < 1008; i += 1) {
      await store.rememberDedupeKey(`k${i}`);
    }

    const snapshot = await store.loadSnapshot();
    expect(snapshot.dedupeLedger).toHaveLength(1000);
    expect(snapshot.dedupeLedger[0]).toBe("k8");
    expect(snapshot.dedupeLedger[snapshot.dedupeLedger.length - 1]).toBe("k1007");
  });

  it("deletes session data including messages and pending queues", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "flycode-bridge-home-"));
    process.env.HOME = home;

    const store = new JsonBridgeStateStore(new TestAppConfigManager(createConfig({ dedupeMaxEntries: 1000 })));
    const sessionId = "qwen:123:/a/chat/s/demo";

    await store.upsertSession({
      sessionId,
      site: "qwen",
      tabId: 123,
      windowId: 456,
      conversationId: "/a/chat/s/demo",
      online: true,
      lastActiveAt: new Date().toISOString()
    });
    await store.appendMessage({
      id: "m1",
      sessionId,
      site: "qwen",
      source: "assistant",
      eventType: "bridge.chat.message",
      text: "hello",
      createdAt: new Date().toISOString(),
      status: "done"
    });
    await store.enqueueOutbound(sessionId, "app", {
      type: "bridge.ack",
      id: "ack-1",
      ok: true
    });

    const deleted = await store.deleteSession(sessionId);
    expect(deleted).toBe(true);

    const snapshot = await store.loadSnapshot();
    expect(snapshot.sessions.some((item) => item.sessionId === sessionId)).toBe(false);
    expect(snapshot.messagesBySession[sessionId]).toBeUndefined();
    expect(snapshot.pendingOutbound[sessionId]).toBeUndefined();
  });
});
