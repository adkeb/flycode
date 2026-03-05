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

function createConfig(): AppConfigData {
  return {
    theme: "system",
    logRetentionDays: 30,
    servicePort: 39393,
    alwaysAllow: {},
    bridge: {
      dedupeMaxEntries: 100000,
      sessionReplayLimit: 500,
      offlineQueuePerSession: 200,
      toolInterceptDefault: "auto",
      confirmationWaitTimeoutMs: 125_000,
      confirmationPollIntervalMs: 1_200
    }
  };
}

describe("Bridge session isolation", () => {
  it("stores messages per session without cross-session mixing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "flycode-bridge-home-"));
    process.env.HOME = home;

    const store = new JsonBridgeStateStore(new TestAppConfigManager(createConfig()));

    await store.appendMessage({
      id: "m1",
      sessionId: "qwen:1:conv-a",
      site: "qwen",
      source: "assistant",
      eventType: "bridge.chat.message",
      text: "hello-a",
      createdAt: new Date().toISOString()
    });

    await store.appendMessage({
      id: "m2",
      sessionId: "qwen:2:conv-b",
      site: "qwen",
      source: "assistant",
      eventType: "bridge.chat.message",
      text: "hello-b",
      createdAt: new Date().toISOString()
    });

    const a = await store.listMessages("qwen:1:conv-a");
    const b = await store.listMessages("qwen:2:conv-b");

    expect(a).toHaveLength(1);
    expect(a[0]?.text).toBe("hello-a");
    expect(b).toHaveLength(1);
    expect(b[0]?.text).toBe("hello-b");
  });
});
