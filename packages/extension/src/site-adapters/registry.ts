/**
 * FlyCode Note: Site adapter registry (V2)
 * Resolves host -> adapter and falls back to generic unknown adapter for diagnostics.
 */
import type { SiteId } from "@flycode/shared-types";
import type { AssistantBlock, SiteAdapter, SubmitOutcome } from "./common/types.js";
import { normalizeBlockText } from "./common/text-normalize.js";
import { createDeepSeekAdapter } from "./deepseek/index.js";
import { createGeminiPlaceholderAdapter } from "./gemini/index.js";
import { createQwenAdapter } from "./qwen/index.js";

const adapters: SiteAdapter[] = [createQwenAdapter(), createDeepSeekAdapter(), createGeminiPlaceholderAdapter()];

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
  if (hostname.includes("gemini")) return "gemini";
  return "unknown";
}

function createUnknownSiteAdapter(host: string): SiteAdapter {
  return {
    id: "unknown",
    matches(url) {
      return url.host === host;
    },
    findInput() {
      const node = document.querySelector("textarea, div[contenteditable='true']");
      return node instanceof HTMLElement ? node : null;
    },
    getCurrentText() {
      const input = this.findInput();
      if (!input) {
        return "";
      }
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        return input.value;
      }
      return input.textContent ?? "";
    },
    injectText(text) {
      const input = this.findInput();
      if (!input) {
        return false;
      }
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        input.value = text;
      } else if (input.isContentEditable) {
        input.textContent = text;
      } else {
        return false;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    async submitAuto(): Promise<SubmitOutcome> {
      const button = document.querySelector("button[data-testid='send-button'], button[aria-label*='Send'], button[aria-label*='发送']");
      if (button instanceof HTMLButtonElement && !button.disabled) {
        button.click();
        return { ok: true, method: "button", attempts: 1 };
      }
      return { ok: false, method: "none", attempts: 0 };
    },
    conversationId() {
      return `${location.pathname}${location.search}${location.hash}`;
    },
    collectAssistantBlocks(): AssistantBlock[] {
      const nodes = Array.from(document.querySelectorAll("pre code, pre, code"));
      const out: AssistantBlock[] = [];
      const dedupe = new Set<HTMLElement>();
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        let element = node;
        if (element.tagName === "CODE") {
          const pre = element.closest("pre");
          if (pre instanceof HTMLElement) {
            element = pre;
          }
        }
        if (dedupe.has(element)) {
          continue;
        }
        dedupe.add(element);
        out.push({
          node: element,
          kind: "unknown",
          text: normalizeBlockText(element.textContent ?? "")
        });
      }
      return out;
    },
    applyMaskedSummary(node, summary) {
      node.textContent = summary;
      node.setAttribute("data-flycode-masked", "1");
      node.style.setProperty("white-space", "pre-wrap", "important");
      node.style.setProperty("color", "#1f8f3a", "important");
      node.style.setProperty("font-size", "12px", "important");
      node.style.setProperty("line-height", "1.35", "important");
    }
  };
}
