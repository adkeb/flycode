/**
 * FlyCode Note: Qwen site adapter
 * Implements Qwen-specific block extraction, controlled-textarea injection, button-first auto submit,
 * and summary masking without mutating Monaco internals.
 */
import type { SiteAdapter, AssistantBlock, AssistantBlockKind, SubmitOutcome } from "../common/types.js";
import { normalizeBlockText, normalizeLines } from "../common/text-normalize.js";
import {
  QWEN_ASSISTANT_BLOCK_SELECTOR,
  QWEN_CODE_BODY_LINE_SELECTOR,
  QWEN_CODE_BODY_SELECTOR,
  QWEN_CODE_HEADER_SELECTOR,
  QWEN_HOSTS,
  QWEN_INPUT_SELECTORS,
  QWEN_SEND_BUTTON_SELECTORS
} from "./selectors.js";

export class QwenSiteAdapter implements SiteAdapter {
  readonly id = "qwen" as const;

  matches(url: URL): boolean {
    if (QWEN_HOSTS.includes(url.host)) {
      return true;
    }
    return url.host.endsWith(".qwen.ai");
  }

  findInput(): HTMLElement | null {
    for (const selector of QWEN_INPUT_SELECTORS) {
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

    if (input instanceof HTMLTextAreaElement) {
      this.setNativeValue(input, text, HTMLTextAreaElement.prototype);
    } else if (input instanceof HTMLInputElement) {
      this.setNativeValue(input, text, HTMLInputElement.prototype);
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
    const beforeUserCount = document.querySelectorAll(".qwen-chat-message-user").length;
    const beforeValue = this.getCurrentText();

    let attempts = 0;
    const buttonDelays = [0, 80, 220];
    for (let i = 0; i < buttonDelays.length; i += 1) {
      const delay = buttonDelays[i];
      if (delay > 0) {
        await sleep(delay);
      }
      const button = this.findEnabledSendButton();
      if (!button) {
        continue;
      }
      attempts += 1;
      button.click();
      if (await this.waitForSubmitSignal(beforeUserCount, beforeValue, 420)) {
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
    const nodes = Array.from(document.querySelectorAll(QWEN_ASSISTANT_BLOCK_SELECTOR));
    const blocks: AssistantBlock[] = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      if (node.closest("textarea, [contenteditable='true'], input")) {
        continue;
      }

      const headerText = normalizeBlockText(node.querySelector(QWEN_CODE_HEADER_SELECTOR)?.textContent ?? "");
      const bodyNode = node.querySelector(QWEN_CODE_BODY_SELECTOR);
      const text = this.extractCodeText(bodyNode instanceof HTMLElement ? bodyNode : node);
      const kind = detectQwenBlockKind({
        headerText,
        bodyClassName: bodyNode instanceof HTMLElement ? bodyNode.className : "",
        text
      });

      blocks.push({
        node,
        kind,
        text
      });
    }
    return blocks;
  }

  applyMaskedSummary(node: HTMLElement, summary: string): void {
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
    summaryNode.style.setProperty("white-space", "pre-wrap", "important");
    summaryNode.style.setProperty("color", "#1f8f3a", "important");
    summaryNode.style.setProperty("font-size", "12px", "important");
    summaryNode.style.setProperty("line-height", "1.35", "important");
    summaryNode.style.setProperty("font-weight", "500", "important");
    summaryNode.style.setProperty("padding", "8px 10px", "important");
    summaryNode.style.setProperty("border-radius", "10px", "important");
    summaryNode.style.setProperty("background", "rgba(232, 245, 234, 0.65)", "important");
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

  private findEnabledSendButton(): HTMLButtonElement | null {
    for (const selector of QWEN_SEND_BUTTON_SELECTORS) {
      const button = document.querySelector(selector);
      if (!(button instanceof HTMLButtonElement)) {
        continue;
      }
      if (button.disabled) {
        continue;
      }
      const className = typeof button.className === "string" ? button.className : "";
      if (className.includes("disabled")) {
        continue;
      }
      return button;
    }
    return null;
  }

  private extractCodeText(root: HTMLElement): string {
    const lineNodes = Array.from(root.querySelectorAll(QWEN_CODE_BODY_LINE_SELECTOR));
    if (lineNodes.length > 0) {
      const lines = lineNodes.map((line) => line.textContent ?? "");
      const byLine = normalizeLines(lines);
      if (byLine) {
        return byLine;
      }
    }
    return normalizeBlockText(root.textContent ?? "");
  }

  private async waitForSubmitSignal(beforeUserCount: number, beforeValue: string, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    const normalizedBefore = beforeValue.trim();
    while (Date.now() - started < timeoutMs) {
      const userCount = document.querySelectorAll(".qwen-chat-message-user").length;
      if (userCount > beforeUserCount) {
        return true;
      }
      const current = this.getCurrentText().trim();
      if (normalizedBefore && current.length < normalizedBefore.length && current.length <= Math.floor(normalizedBefore.length * 0.35)) {
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

export function createQwenAdapter(): SiteAdapter {
  return new QwenSiteAdapter();
}

function detectQwenBlockKind(input: { headerText: string; bodyClassName: string; text: string }): AssistantBlockKind {
  const header = input.headerText.toLowerCase();
  const className = input.bodyClassName.toLowerCase();
  const text = input.text.toLowerCase();

  if (header.includes("mcp-request") || className.includes("mcp-request") || text.startsWith("mcp-request\n")) {
    return "mcp-request";
  }
  if (header.includes("mcp-response") || className.includes("mcp-response") || text.startsWith("mcp-response\n")) {
    return "mcp-response";
  }
  if (header.includes("flycode-result") || className.includes("flycode-result") || text.startsWith("flycode-result\n")) {
    return "flycode-result";
  }
  if (header.includes("flycode-upload") || className.includes("flycode-upload") || text.startsWith("flycode-upload\n")) {
    return "flycode-upload";
  }
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
