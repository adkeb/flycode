/**
 * FlyCode Note: Site adapter registry (Qwen + DeepSeek only)
 */
import type { SiteId } from "@flycode/shared-types";
import type { AssistantBlock, SiteAdapter, SubmitOutcome } from "./common/types.js";
import { createDeepSeekAdapter } from "./deepseek/index.js";
import { createQwenAdapter } from "./qwen/index.js";

const adapters: SiteAdapter[] = [createQwenAdapter(), createDeepSeekAdapter()];

export function resolveSiteAdapter(urlValue: string = window.location.href): SiteAdapter {
  const url = new URL(urlValue);
  for (const adapter of adapters) {
    if (adapter.matches(url)) {
      return adapter;
    }
  }

  return createUnknownSiteAdapter(url.host);
}

export function resolveSiteId(hostname: string): SiteId {
  if (hostname.includes("qwen")) return "qwen";
  if (hostname.includes("deepseek")) return "deepseek";
  return "unknown";
}

function createUnknownSiteAdapter(host: string): SiteAdapter {
  return {
    id: "unknown",
    matches(url) {
      return url.host === host;
    },
    findInput() {
      return null;
    },
    getCurrentText() {
      return "";
    },
    injectText() {
      return false;
    },
    async submitAuto(): Promise<SubmitOutcome> {
      return { ok: false, method: "none", attempts: 0 };
    },
    conversationId() {
      return `${location.pathname}${location.search}${location.hash}`;
    },
    collectAssistantBlocks(): AssistantBlock[] {
      return [];
    },
    applyMaskedSummary() {
      // no-op
    }
  };
}
