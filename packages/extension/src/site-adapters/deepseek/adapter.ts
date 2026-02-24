/**
 * FlyCode Note: DeepSeek site adapter
 * Keeps DeepSeek behavior independent from Qwen while preserving current MCP extraction flow.
 */
import type {
  SiteAdapter,
  AssistantBlock,
  AssistantBlockKind,
  AssistantBlockSource,
  SubmitOutcome
} from "../common/types.js";
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
    const beforeText = this.getCurrentText();
    const beforeUserCount = document.querySelectorAll("._81e7b5e").length;
    const hiddenTab = document.hidden;
    const buttonWaitMs = hiddenTab ? 2600 : 520;
    const enterWaitMs = hiddenTab ? 9000 : 1200;

    // Button first: avoid Enter introducing a newline and creating false-positive submit.
    const delays = [0, 80, 220];
    for (const delay of delays) {
      if (delay > 0) {
        await sleep(delay);
      }
      const button = this.findEnabledSendButton();
      if (!button) {
        continue;
      }
      attempts += 1;
      button.click();
      if (await this.waitForSubmitSignal(beforeUserCount, beforeText, buttonWaitMs)) {
        return { ok: true, method: "button", attempts };
      }
    }

    attempts += 1;
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    if (await this.waitForSubmitSignal(beforeUserCount, beforeText, enterWaitMs)) {
      return { ok: true, method: "enter", attempts };
    }

    return { ok: false, method: "enter", attempts };
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
      const mdBlock = el.closest(".md-code-block");
      if (mdBlock instanceof HTMLElement) {
        el = mdBlock;
      }
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
      if ((el.tagName === "PRE" || el.tagName === "CODE") && el.closest(".md-code-block")) {
        // md-code-block handled at wrapper level.
        continue;
      }
      dedupe.add(el);
      const { text, headerHint } = this.extractBlockText(el);
      if (!text) {
        continue;
      }
      const source = resolveBlockSource(el);
      let kind = detectBlockKind(text, `${el.className} ${headerHint}`);
      if (source === "user" && kind === "mcp-request") {
        // Never execute user-side echoed request blocks.
        kind = "unknown";
      }
      out.push({
        node: el,
        text,
        kind,
        source
      });
    }
    return out;
  }

  applyMaskedSummary(node: HTMLElement, summary: string): void {
    if (node.classList.contains("md-code-block")) {
      if (node.getAttribute("data-flycode-masked") === "1") {
        return;
      }
      node.style.setProperty("display", "none", "important");
      node.setAttribute("data-flycode-masked", "1");
      let summaryNode: HTMLElement | null =
        node.nextElementSibling instanceof HTMLElement ? node.nextElementSibling : null;
      if (!summaryNode || summaryNode.getAttribute("data-flycode-summary") !== "1") {
        summaryNode = document.createElement("div");
        summaryNode.setAttribute("data-flycode-summary", "1");
        node.insertAdjacentElement("afterend", summaryNode);
      }
      summaryNode.textContent = summary;
      applySummaryStyles(summaryNode);
      return;
    }

    const target = this.resolveMaskTarget(node);
    if (target.getAttribute("data-flycode-masked") === "1") {
      return;
    }
    target.textContent = summary;
    target.setAttribute("data-flycode-masked", "1");
    if (target !== node) {
      node.setAttribute("data-flycode-masked", "1");
    }
    applySummaryStyles(target);
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
    const input = this.findInput();
    const roots: ParentNode[] = [];
    if (input) {
      const nearby = input.closest("form, .b13855df, .aaff8b8f, ._020ab5b, ._24fad49");
      if (nearby) {
        roots.push(nearby);
      }
      if (input.parentElement) {
        roots.push(input.parentElement);
      }
    }
    roots.push(document);

    for (const root of roots) {
      for (const selector of DEEPSEEK_SEND_BUTTON_SELECTORS) {
        const nodes = Array.from(root.querySelectorAll(selector));
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }
          if (node.getAttribute("aria-disabled") === "true") {
            continue;
          }
          const className = typeof node.className === "string" ? node.className : "";
          if (className.includes("disabled")) {
            continue;
          }
          if (node instanceof HTMLButtonElement && node.disabled) {
            continue;
          }
          return node as unknown as HTMLButtonElement;
        }
      }
    }
    return null;
  }

  private extractBlockText(node: HTMLElement): { text: string; headerHint: string } {
    if (node.classList.contains("md-code-block")) {
      const header = normalizeBlockText(node.querySelector(".d813de27")?.textContent ?? "");
      const pre = node.querySelector("pre");
      const body = normalizeBlockText((pre instanceof HTMLElement ? pre.textContent : node.textContent) ?? "");
      const text = header ? `${header}\n${body}` : body;
      return { text, headerHint: header };
    }
    return { text: normalizeBlockText(node.textContent ?? ""), headerHint: "" };
  }

  private async waitForSubmitSignal(beforeUserCount: number, beforeText: string, timeoutMs: number): Promise<boolean> {
    const normalizedBefore = beforeText.trim();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const currentCount = document.querySelectorAll("._81e7b5e").length;
      if (currentCount > beforeUserCount) {
        return true;
      }

      const current = this.getCurrentText().trim();
      if (normalizedBefore && current.length < normalizedBefore.length && current.length <= Math.floor(normalizedBefore.length * 0.4)) {
        return true;
      }
      if (normalizedBefore && current.length === 0) {
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

function resolveBlockSource(node: HTMLElement): AssistantBlockSource {
  if (
    node.closest(".ds-message, .ds-message--assistant, [data-role='assistant'], [data-message-author-role='assistant'], .assistant-message")
  ) {
    return "assistant";
  }
  if (
    node.closest(".ds-message--user, [data-role='user'], [data-message-author-role='user'], .user-message")
  ) {
    return "user";
  }
  const legacyBubble = node.closest("._81e7b5e");
  if (legacyBubble instanceof HTMLElement) {
    const className = legacyBubble.className || "";
    if (className.includes("_19d617c") || /\buser\b/i.test(className)) {
      return "user";
    }
    return "assistant";
  }
  return "unknown";
}

function detectBlockKind(text: string, className: string): AssistantBlockKind {
  const raw = normalizeBlockText(text).toLowerCase();
  const klass = className.toLowerCase();
  if (klass.includes("mcp-request") || /^`{3,}\s*mcp-request\b/.test(raw) || /^mcp-request\s*\n/.test(raw)) {
    return "mcp-request";
  }
  if (klass.includes("mcp-response") || /^`{3,}\s*mcp-response\b/.test(raw) || /^mcp-response\s*\n/.test(raw)) {
    return "mcp-response";
  }
  if (klass.includes("flycode-result") || /^`{3,}\s*flycode-result\b/.test(raw) || /^flycode-result\s*\n/.test(raw)) {
    return "flycode-result";
  }
  if (klass.includes("flycode-upload") || /^`{3,}\s*flycode-upload\b/.test(raw) || /^flycode-upload\s*\n/.test(raw)) {
    return "flycode-upload";
  }
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function applySummaryStyles(target: HTMLElement): void {
  target.style.setProperty("white-space", "pre-wrap", "important");
  target.style.setProperty("color", "#1f8f3a", "important");
  target.style.setProperty("font-size", "12px", "important");
  target.style.setProperty("line-height", "1.35", "important");
  target.style.setProperty("font-weight", "500", "important");
}
