/**
 * FlyCode Note: Generic DOM adapter base
 * Provides fallback defaults for unknown hosts. Qwen/DeepSeek use dedicated adapters.
 */
import type { SiteId } from "@flycode/shared-types";
import type { AssistantBlock, AssistantBlockKind, SiteAdapter, SubmitOutcome } from "./types.js";
import { normalizeBlockText } from "./text-normalize.js";

export class DomSiteAdapter implements SiteAdapter {
  constructor(
    public readonly id: SiteId,
    private readonly hosts: string[],
    private readonly inputSelectors: string[],
    private readonly assistantBlockSelectors: string[]
  ) {}

  matches(url: URL): boolean {
    return this.hosts.includes(url.host);
  }

  findInput(): HTMLElement | null {
    for (const selector of this.inputSelectors) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        return node;
      }
    }
    const fallback = document.querySelector("textarea, div[contenteditable='true']");
    return fallback instanceof HTMLElement ? fallback : null;
  }

  getCurrentText(): string {
    const input = this.findInput();
    if (!input) {
      return "";
    }
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      return input.value;
    }
    if (input.isContentEditable) {
      return input.textContent ?? "";
    }
    return "";
  }

  injectText(text: string): boolean {
    const input = this.findInput();
    if (!input) {
      return false;
    }
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      input.value = text;
    } else if (input.isContentEditable) {
      input.textContent = text;
    } else {
      return false;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  async submitAuto(): Promise<SubmitOutcome> {
    const input = this.findInput();
    if (!input) {
      return { ok: false, method: "none", attempts: 0 };
    }
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));

    const sendButton = document.querySelector<HTMLElement>(
      "button[data-testid='send-button'], button[aria-label*='Send'], button[aria-label*='发送']"
    );
    if (!sendButton) {
      return { ok: true, method: "enter", attempts: 1 };
    }
    sendButton.click();
    return { ok: true, method: "button", attempts: 2 };
  }

  conversationId(): string {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  collectAssistantBlocks(): AssistantBlock[] {
    const selectors = this.assistantBlockSelectors.length > 0 ? this.assistantBlockSelectors : ["pre code", "pre", "code"];
    const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
    const out: AssistantBlock[] = [];
    const dedupe = new Set<HTMLElement>();

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      let el = node;
      if (el.tagName === "CODE") {
        const pre = el.closest("pre");
        if (pre instanceof HTMLElement) {
          el = pre;
        }
      }
      if (dedupe.has(el)) {
        continue;
      }
      if (el.closest("textarea, [contenteditable='true'], input")) {
        continue;
      }
      dedupe.add(el);
      const text = normalizeBlockText(el.textContent ?? "");
      out.push({
        node: el,
        kind: detectKind(text, el.className),
        text
      });
    }
    return out;
  }

  applyMaskedSummary(node: HTMLElement, summary: string): void {
    node.textContent = summary;
    node.setAttribute("data-flycode-masked", "1");
    node.style.setProperty("white-space", "pre-wrap", "important");
    node.style.setProperty("color", "#1f8f3a", "important");
    node.style.setProperty("font-size", "12px", "important");
    node.style.setProperty("line-height", "1.35", "important");
  }
}

function detectKind(text: string, className: string): AssistantBlockKind {
  const raw = text.toLowerCase();
  const klass = className.toLowerCase();
  if (klass.includes("mcp-request") || raw.includes("```mcp-request") || raw.startsWith("mcp-request\n")) {
    return "mcp-request";
  }
  if (klass.includes("mcp-response") || raw.includes("```mcp-response") || raw.startsWith("mcp-response\n")) {
    return "mcp-response";
  }
  if (klass.includes("flycode-result") || raw.includes("```flycode-result") || raw.startsWith("flycode-result\n")) {
    return "flycode-result";
  }
  if (klass.includes("flycode-upload") || raw.includes("```flycode-upload") || raw.startsWith("flycode-upload\n")) {
    return "flycode-upload";
  }
  return "unknown";
}
