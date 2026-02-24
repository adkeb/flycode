/**
 * FlyCode Note: Gemini site adapter
 * Implements Gemini-specific input handling, auto-submit, assistant block extraction,
 * and compact summary masking.
 */
import type { SiteAdapter, AssistantBlock, AssistantBlockKind, SubmitOutcome } from "../common/types.js";
import { normalizeBlockText } from "../common/text-normalize.js";
import {
  GEMINI_BLOCK_SELECTORS,
  GEMINI_HOSTS,
  GEMINI_INPUT_SELECTORS,
  GEMINI_MODEL_CONTAINER_SELECTORS,
  GEMINI_SEND_BUTTON_SELECTORS,
  GEMINI_USER_CONTAINER_SELECTORS,
  GEMINI_USER_MESSAGE_COUNT_SELECTORS
} from "./selectors.js";

export class GeminiSiteAdapter implements SiteAdapter {
  readonly id = "gemini" as const;

  matches(url: URL): boolean {
    return GEMINI_HOSTS.includes(url.host);
  }

  findInput(): HTMLElement | null {
    for (const selector of GEMINI_INPUT_SELECTORS) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        return node;
      }
    }
    return null;
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
      this.setNativeValue(input, text, input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype);
    } else if (input.isContentEditable) {
      input.textContent = text;
    } else {
      return false;
    }
    this.dispatchInputEvents(input);
    return true;
  }

  async submitAuto(): Promise<SubmitOutcome> {
    const input = this.findInput();
    if (!input) {
      return { ok: false, method: "none", attempts: 0 };
    }

    const beforeUserCount = this.countUserMessages();
    const beforeValue = this.getCurrentText().trim();

    let attempts = 0;
    const delays = [0, 80, 220];
    for (let i = 0; i < delays.length; i += 1) {
      const delay = delays[i];
      if (delay > 0) {
        await sleep(delay);
      }
      const button = this.findEnabledSendButton();
      if (!button) {
        continue;
      }
      attempts += 1;
      button.click();
      if (await this.waitForSubmitSignal(beforeUserCount, beforeValue, 450)) {
        return { ok: true, method: "button", attempts };
      }
    }

    attempts += 1;
    this.dispatchEnter(input);
    if (await this.waitForSubmitSignal(beforeUserCount, beforeValue, 1200)) {
      return { ok: true, method: "enter", attempts };
    }
    return { ok: false, method: "enter", attempts };
  }

  conversationId(): string {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  collectAssistantBlocks(): AssistantBlock[] {
    const nodes = Array.from(document.querySelectorAll(GEMINI_BLOCK_SELECTORS.join(",")));
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
      if (element.closest("textarea, [contenteditable='true'], input")) {
        continue;
      }
      if (this.isInsideUserContainer(element) && !this.isInsideModelContainer(element)) {
        continue;
      }
      dedupe.add(element);

      const text = normalizeBlockText(element.textContent ?? "");
      out.push({
        node: element,
        kind: detectBlockKind(text, element.className),
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
    node.style.setProperty("font-weight", "500", "important");
  }

  private setNativeValue<T extends HTMLInputElement | HTMLTextAreaElement>(
    input: T,
    value: string,
    prototype: object
  ): void {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(input, value);
      return;
    }
    input.value = value;
  }

  private dispatchInputEvents(input: HTMLElement): void {
    try {
      input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: null }));
    } catch {
      input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  }

  private dispatchEnter(input: HTMLElement): void {
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  }

  private findEnabledSendButton(): HTMLButtonElement | null {
    for (const selector of GEMINI_SEND_BUTTON_SELECTORS) {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLButtonElement)) {
        continue;
      }
      if (node.disabled) {
        continue;
      }
      if (node.getAttribute("aria-disabled") === "true") {
        continue;
      }
      return node;
    }
    return null;
  }

  private isInsideModelContainer(node: HTMLElement): boolean {
    return !!node.closest(GEMINI_MODEL_CONTAINER_SELECTORS.join(","));
  }

  private isInsideUserContainer(node: HTMLElement): boolean {
    return !!node.closest(GEMINI_USER_CONTAINER_SELECTORS.join(","));
  }

  private countUserMessages(): number {
    let max = 0;
    for (const selector of GEMINI_USER_MESSAGE_COUNT_SELECTORS) {
      const count = document.querySelectorAll(selector).length;
      if (count > max) {
        max = count;
      }
    }
    return max;
  }

  private async waitForSubmitSignal(beforeUserCount: number, beforeValue: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const userCount = this.countUserMessages();
      if (userCount > beforeUserCount) {
        return true;
      }

      const current = this.getCurrentText().trim();
      if (beforeValue && current.length < beforeValue.length && current.length <= Math.floor(beforeValue.length * 0.35)) {
        return true;
      }
      if (beforeValue && current.length === 0) {
        return true;
      }

      await sleep(80);
    }
    return false;
  }
}

export function createGeminiAdapter(): SiteAdapter {
  return new GeminiSiteAdapter();
}

// Keep compatibility with previous naming in registry imports.
export function createGeminiPlaceholderAdapter(): SiteAdapter {
  return createGeminiAdapter();
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
