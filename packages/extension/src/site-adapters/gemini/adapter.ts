/**
 * FlyCode Note: Gemini adapter placeholder
 * Reserved extension point. Keeps behavior minimal and isolated.
 */
import type { SiteAdapter, AssistantBlock, SubmitOutcome } from "../common/types.js";
import { normalizeBlockText } from "../common/text-normalize.js";

export class GeminiPlaceholderAdapter implements SiteAdapter {
  readonly id = "gemini" as const;

  matches(url: URL): boolean {
    return url.host === "gemini.google.com";
  }

  findInput(): HTMLElement | null {
    const node = document.querySelector("textarea, div[contenteditable='true']");
    return node instanceof HTMLElement ? node : null;
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
    const button = document.querySelector("button[data-testid='send-button'], button[aria-label*='Send']");
    if (button instanceof HTMLButtonElement && !button.disabled) {
      button.click();
      return { ok: true, method: "button", attempts: 1 };
    }
    return { ok: false, method: "none", attempts: 0 };
  }

  conversationId(): string {
    return `${location.pathname}${location.search}${location.hash}`;
  }

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

export function createGeminiPlaceholderAdapter(): SiteAdapter {
  return new GeminiPlaceholderAdapter();
}
