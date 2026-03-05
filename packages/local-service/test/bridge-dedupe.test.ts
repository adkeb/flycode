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

describe("Bridge dedupe persistence", () => {
  it("retains dedupe keys across store re-initialization", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "flycode-bridge-home-"));
    process.env.HOME = home;

    const appConfigManager = new TestAppConfigManager(createConfig());
    const first = new JsonBridgeStateStore(appConfigManager);
    await first.rememberDedupeKey("tool:qwen|1|c1|a1|req|hash");

    const second = new JsonBridgeStateStore(appConfigManager);
    expect(await second.hasDedupeKey("tool:qwen|1|c1|a1|req|hash")).toBe(true);
  });
});
