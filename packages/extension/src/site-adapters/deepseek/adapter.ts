/**
 * FlyCode Note: DeepSeek site adapter
 * Keeps DeepSeek behavior independent from Qwen while preserving current MCP extraction flow.
 */
import type { SiteAdapter, AssistantBlock, AssistantBlockKind, SubmitOutcome } from "../common/types.js";
import { normalizeBlockText } from "../common/text-normalize.js";
import {
  DEEPSEEK_ASSISTANT_BLOCK_SELECTORS,
  DEEPSEEK_HOSTS,
  DEEPSEEK_INPUT_SELECTORS,
  DEEPSEEK_SEND_BUTTON_SELECTORS
} from "./selectors.js";

export class DeepSeekSiteAdapter implements SiteAdapter {
  readonly id = "deepseek" as const;

  matches(url: URL): boolean {
    return DEEPSEEK_HOSTS.includes(url.host);
  }

  findInput(): HTMLElement | null {
    for (const selector of DEEPSEEK_INPUT_SELECTORS) {
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

    let attempts = 0;
    const beforeText = this.getCurrentText().trim();

    attempts += 1;
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));

    if (await this.waitForTextMutation(beforeText, 480)) {
      return { ok: true, method: "enter", attempts };
    }

    const button = this.findEnabledSendButton();
    if (button) {
      attempts += 1;
      button.click();
      if (await this.waitForTextMutation(beforeText, 900)) {
        return { ok: true, method: "button", attempts };
      }
    }

    return { ok: false, method: button ? "button" : "enter", attempts };
  }

  conversationId(): string {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  collectAssistantBlocks(): AssistantBlock[] {
    const selectors = DEEPSEEK_ASSISTANT_BLOCK_SELECTORS.join(",");
    const nodes = Array.from(document.querySelectorAll(selectors));
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
        text,
        kind: detectBlockKind(text, el.className)
      });
    }
    return out;
  }

  applyMaskedSummary(node: HTMLElement, summary: string): void {
    const target = this.resolveMaskTarget(node);
    if (target.getAttribute("data-flycode-masked") === "1") {
      return;
    }
    target.textContent = summary;
    target.setAttribute("data-flycode-masked", "1");
    if (target !== node) {
      node.setAttribute("data-flycode-masked", "1");
    }
    target.style.setProperty("white-space", "pre-wrap", "important");
    target.style.setProperty("color", "#1f8f3a", "important");
    target.style.setProperty("font-size", "12px", "important");
    target.style.setProperty("line-height", "1.35", "important");
    target.style.setProperty("font-weight", "500", "important");
  }

  private resolveMaskTarget(node: HTMLElement): HTMLElement {
    if (node.tagName === "PRE") {
      const code = node.querySelector(":scope > code");
      if (code instanceof HTMLElement) {
        return code;
      }
    }
    return node;
  }

  private findEnabledSendButton(): HTMLButtonElement | null {
    for (const selector of DEEPSEEK_SEND_BUTTON_SELECTORS) {
      const button = document.querySelector(selector);
      if (!(button instanceof HTMLButtonElement)) {
        continue;
      }
      if (button.disabled) {
        continue;
      }
      return button;
    }
    return null;
  }

  private async waitForTextMutation(beforeText: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = this.getCurrentText().trim();
      if (beforeText && current !== beforeText) {
        return true;
      }
      await sleep(80);
    }
    return false;
  }
}

export function createDeepSeekAdapter(): SiteAdapter {
  return new DeepSeekSiteAdapter();
}

function detectBlockKind(text: string, className: string): AssistantBlockKind {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
