/**
 * FlyCode Note: Adapter resolver
 * Selects Qwen or DeepSeek DOM adapter by host and falls back to generic adapter on unknown hosts.
 */
import type { SiteId } from "@flycode/shared-types";
import { DomSiteAdapter } from "./base.js";
import type { SiteAdapter } from "./types.js";

const adapters: SiteAdapter[] = [
  new DomSiteAdapter("qwen", ["chat.qwen.ai"], [
    "textarea[data-testid='chat-input']",
    "textarea",
    "div[contenteditable='true'][role='textbox']"
  ]),
  new DomSiteAdapter("deepseek", ["chat.deepseek.com", "www.deepseek.com"], [
    "textarea[data-testid='chat-input']",
    "textarea",
    "div[contenteditable='true'][role='textbox']"
  ])
];

export function resolveSiteAdapter(): SiteAdapter {
  const current = new URL(window.location.href);
  for (const adapter of adapters) {
    if (adapter.matches(current)) {
      return adapter;
    }
  }

  return new DomSiteAdapter("unknown", [current.host], ["textarea", "div[contenteditable='true']"]);
}

export function resolveSiteId(hostname: string): SiteId {
  if (hostname.includes("qwen")) return "qwen";
  if (hostname.includes("deepseek")) return "deepseek";
  return "unknown";
}
