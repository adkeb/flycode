import { describe, expect, it } from "vitest";
import { BRIDGE_PROTOCOL_VERSION } from "@flycode/shared-types";
import { DefaultBridgeHub } from "../src/services/bridge-hub.js";

class FakeSocket {
  sent: string[] = [];
  closed = false;
  readyState = 1;

  private readonly handlers: {
    message: Array<(raw: Buffer | string) => void>;
    close: Array<() => void>;
    error: Array<(error: Error) => void>;
  } = {
    message: [],
    close: [],
    error: []
  };

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    for (const listener of this.handlers.close) {
      listener();
    }
  }

  on(event: "message" | "close" | "error", listener: any): void {
    this.handlers[event].push(listener);
  }

  emitMessage(frame: unknown): void {
    const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
    for (const listener of this.handlers.message) {
      listener(payload);
    }
  }
}

function createHub() {
  const context = {
    appConfigManager: {
      async load() {
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
            confirmationWaitTimeoutMs: 125000,
            confirmationPollIntervalMs: 1200
          }
        };
      }
    }
  } as any;
  const stateStore = {
    async loadSnapshot() {
      return {
        sessions: [],
        messagesBySession: {},
        dedupeLedger: [],
        pendingOutbound: {}
      };
    },
    async listSessions() {
      return [];
    },
    async listMessages() {
      return [];
    },
    async upsertSession() {},
    async appendMessage() {},
    async hasDedupeKey() {
      return false;
    },
    async rememberDedupeKey() {},
    async enqueueOutbound() {},
    async dequeueOutbound() {
      return [];
    }
  } as any;

  const gateway = {
    async dispatch() {
      throw new Error("not used");
    },
    classifyStatus() {
      return "failed" as const;
    }
  } as any;

  return new DefaultBridgeHub(context, stateStore, gateway);
}

describe("Bridge protocol hello", () => {
  it("rejects mismatched protocol version", async () => {
    const hub = createHub();
    const socket = new FakeSocket();

    await hub.bindWebsocket({
      socket,
      role: "app"
    });

    socket.emitMessage({
      type: "bridge.hello",
      role: "app",
      protocolVersion: BRIDGE_PROTOCOL_VERSION + 1
    });

    expect(socket.closed).toBe(true);
    const parsed = socket.sent.map((item) => JSON.parse(item));
    expect(parsed.some((item) => item.type === "bridge.error" && item.code === "PROTOCOL_VERSION_MISMATCH")).toBe(true);
  });

  it("accepts matching protocol version", async () => {
    const hub = createHub();
    const socket = new FakeSocket();

    await hub.bindWebsocket({
      socket,
      role: "app"
    });

    socket.emitMessage({
      type: "bridge.hello",
      role: "app",
      protocolVersion: BRIDGE_PROTOCOL_VERSION
    });

    const parsed = socket.sent.map((item) => JSON.parse(item));
    expect(parsed.some((item) => item.type === "bridge.hello.ok" && item.protocolVersion === BRIDGE_PROTOCOL_VERSION)).toBe(true);
  });
});
