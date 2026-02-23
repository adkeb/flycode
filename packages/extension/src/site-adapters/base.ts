/**
 * FlyCode Note: DOM adapter implementation
 * Locates chat input elements, injects text, submits messages, and provides conversation identity for dedupe.
 */
import type { SiteAdapter } from "./types.js";
import type { SiteId } from "@flycode/shared-types";

export class DomSiteAdapter implements SiteAdapter {
  constructor(
    public readonly id: SiteId,
    private readonly hosts: string[],
    private readonly selectors: string[]
  ) {}

  matches(url: URL): boolean {
    return this.hosts.includes(url.host);
  }

  getInputEl(): HTMLElement | null {
    for (const selector of this.selectors) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        return node;
      }
    }

    const fallback = document.querySelector("textarea, div[contenteditable='true']");
    return fallback instanceof HTMLElement ? fallback : null;
  }

  getCurrentText(): string {
    const el = this.getInputEl();
    if (!el) {
      return "";
    }

    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      return el.value;
    }

    if (el.isContentEditable) {
      return el.textContent ?? "";
    }

    return "";
  }

  submitCurrentInput(): boolean {
    const el = this.getInputEl();
    if (!el) {
      return false;
    }

    el.focus();

    const keydown = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true
    });
    const keyup = new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      bubbles: true
    });

    const dispatched = el.dispatchEvent(keydown);
    el.dispatchEvent(keyup);

    if (dispatched) {
      return true;
    }

    const sendButton = document.querySelector<HTMLElement>(
      "button[data-testid='send-button'], button[aria-label*='Send'], button[aria-label*='发送'], button[title*='Send'], button[title*='发送']"
    );
    if (!sendButton) {
      return false;
    }

    sendButton.click();
    return true;
  }

  injectText(text: string): boolean {
    const el = this.getInputEl();
    if (!el) {
      return false;
    }

    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      el.focus();
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    if (el.isContentEditable) {
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    return false;
  }

  getConversationId(): string {
    const path = location.pathname || "/";
    const search = location.search || "";
    const hash = location.hash || "";
    return `${path}${search}${hash}`;
  }
}
