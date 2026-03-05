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

function createConfig(limit: number): AppConfigData {
  return {
    theme: "system",
    logRetentionDays: 30,
    servicePort: 39393,
    alwaysAllow: {},
    bridge: {
      dedupeMaxEntries: 100000,
      sessionReplayLimit: 500,
      offlineQueuePerSession: limit,
      toolInterceptDefault: "auto",
      confirmationWaitTimeoutMs: 125_000,
      confirmationPollIntervalMs: 1_200
    }
  };
}

describe("Bridge outbound queue", () => {
  it("keeps only latest offline queue entries within session limit", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "flycode-bridge-home-"));
    process.env.HOME = home;

    const store = new JsonBridgeStateStore(new TestAppConfigManager(createConfig(20)));
    const sessionId = "qwen:11:conv-a";

    for (let i = 0; i < 26; i += 1) {
      await store.enqueueOutbound(sessionId, "web", {
        type: "bridge.chat.send",
        id: `evt-${i}`,
        sessionId,
        payload: {
          sessionId,
          messageId: `m-${i}`,
          text: `msg-${i}`
        },
        createdAt: new Date().toISOString()
      });
    }

    const queued = await store.dequeueOutbound(sessionId, "web");
    expect(queued).toHaveLength(20);
    expect((queued[0] as { id: string }).id).toBe("evt-6");
    expect((queued[queued.length - 1] as { id: string }).id).toBe("evt-25");
  });
});
