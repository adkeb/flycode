/**
 * FlyCode Note: DeepSeek site adapter
 * Strictly isolated to DeepSeek DOM; only message extraction is used in capture-only mode.
 */
import type { AssistantBlock, AssistantBlockSource, SiteAdapter, SubmitOutcome } from "../common/types.js";
import { normalizeBlockText } from "../common/text-normalize.js";
import {
  DEEPSEEK_HOSTS,
  DEEPSEEK_INPUT_SELECTORS,
  DEEPSEEK_MESSAGE_CONTENT_SELECTORS,
  DEEPSEEK_MESSAGE_ROOT_SELECTOR,
  DEEPSEEK_SEND_BUTTON_SELECTORS,
  DEEPSEEK_USER_MARKER_CLASS
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
      const previous = input.value;
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) {
        descriptor.set.call(input, text);
      } else {
        input.value = text;
      }
      const tracker = (input as HTMLTextAreaElement & { _valueTracker?: { setValue: (value: string) => void } })._valueTracker;
      if (tracker && typeof tracker.setValue === "function") {
        tracker.setValue(previous);
      }
      input.setSelectionRange(text.length, text.length);
    } else if (input.isContentEditable) {
      input.textContent = text;
    } else {
      return false;
    }
    try {
      input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: null }));
    } catch {
      input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true, cancelable: true }));
    return true;
  }

  async submitAuto(): Promise<SubmitOutcome> {
    const beforeUserCount = countDeepSeekUserMessages();
    const beforeText = this.getCurrentText();
    let attempts = 0;

    const delays = [40, 120, 260, 520, 900];
    for (const delay of delays) {
      if (delay > 0) {
        await sleep(delay);
      }
      const button = this.findEnabledSendButton();
      if (!button) {
        continue;
      }
      attempts += 1;
      triggerClick(button);
      if (await this.waitForSubmitSignal(beforeUserCount, beforeText, 5200)) {
        return { ok: true, method: "button", attempts };
      }
    }

    const input = this.findInput();
    if (input) {
      attempts += 1;
      input.focus();
      dispatchEnter(input);
      dispatchCtrlEnter(input);
      dispatchMetaEnter(input);
      if (await this.waitForSubmitSignal(beforeUserCount, beforeText, 4200)) {
        return { ok: true, method: "enter", attempts };
      }

      attempts += 1;
      if (submitClosestForm(input) && (await this.waitForSubmitSignal(beforeUserCount, beforeText, 3200))) {
        return { ok: true, method: "enter", attempts };
      }

      // Fallback: try clicking button again after Enter.
      const button = this.findEnabledSendButton();
      if (button) {
        attempts += 1;
        triggerClick(button);
      }
      if (await this.waitForSubmitSignal(beforeUserCount, beforeText, 5200)) {
        return { ok: true, method: "enter", attempts };
      }
    }

    return { ok: false, method: input ? "enter" : "none", attempts };
  }

  conversationId(): string {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  collectAssistantBlocks(): AssistantBlock[] {
    const modernRoots = Array.from(document.querySelectorAll(".ds-message._63c77b1")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement
    );
    const roots =
      modernRoots.length > 0
        ? modernRoots
        : Array.from(document.querySelectorAll(DEEPSEEK_MESSAGE_ROOT_SELECTOR)).filter(
            (node): node is HTMLElement => node instanceof HTMLElement
          );
    const out: AssistantBlock[] = [];
    const dedupe = new Set<HTMLElement>();

    for (const node of roots) {
      if (dedupe.has(node)) {
        continue;
      }
      dedupe.add(node);

      const extracted = this.extractMessage(node);
      if (!extracted?.text) {
        continue;
      }

      out.push({
        node,
        kind: "unknown",
        text: extracted.text,
        source: extracted.source,
        meta: extracted.meta
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

  private extractMessage(root: HTMLElement): { source: AssistantBlockSource; text: string; meta?: Record<string, unknown> } | null {
    if (isModernDeepSeekMessage(root)) {
      const userNode = root.querySelector(":scope > .fbb737a4");
      if (userNode instanceof HTMLElement) {
        const userText = normalizeBlockText(userNode.textContent ?? "");
        if (!userText) {
          return null;
        }
        return {
          source: "user",
          text: userText
        };
      }

      const thinkText = collectThinkText(root);
      const answerText = collectAnswerText(root);
      const answerMarkdown = collectAnswerMarkdown(root);
      const webReadSummary = collectWebReadSummary(root);
      const normalizedAnswer = normalizeBlockText(answerText);
      const normalizedThink = normalizeBlockText(thinkText);
      const fallback = normalizeBlockText(root.textContent ?? "");
      const finalText = normalizedAnswer || fallback;
      if (!finalText) {
        return null;
      }

      return {
        source: "assistant",
        text: finalText,
        meta:
          normalizedThink || normalizedAnswer || answerMarkdown || webReadSummary
            ? {
                ...(normalizedThink ? { thinkText: normalizedThink } : {}),
                ...(normalizedAnswer ? { answerText: normalizedAnswer } : {}),
                ...(answerMarkdown ? { answerMarkdown } : {}),
                ...(webReadSummary ? { webReadSummary } : {})
              }
            : undefined
      };
    }

    for (const selector of DEEPSEEK_MESSAGE_CONTENT_SELECTORS) {
      const content = root.querySelector(selector);
      if (content instanceof HTMLElement) {
        const text = normalizeBlockText(content.textContent ?? "");
        if (text) {
          return {
            source: resolveSource(root),
            text
          };
        }
      }
    }
    const fallback = normalizeBlockText(root.textContent ?? "");
    if (!fallback) {
      return null;
    }
    return {
      source: resolveSource(root),
      text: fallback
    };
  }

  private findEnabledSendButton(): HTMLElement | null {
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

    const candidates: HTMLElement[] = [];
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
          if (node instanceof HTMLButtonElement && node.disabled) {
            continue;
          }
          const className = typeof node.className === "string" ? node.className : "";
          if (className.includes("disabled")) {
            continue;
          }
          if (className.includes("f02f0e25")) {
            continue;
          }
          const label = `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`.toLowerCase();
          if (/(copy|复制|下载|download|upload|附件|attach)/.test(label)) {
            continue;
          }
          candidates.push(node);
        }
      }
    }
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => scoreSendButton(b) - scoreSendButton(a));
    return candidates[0] ?? null;
  }

  private async waitForSubmitSignal(beforeUserCount: number, beforeText: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    const normalizedBefore = normalizeBlockText(beforeText);
    while (Date.now() - start < timeoutMs) {
      const currentCount = countDeepSeekUserMessages();
      if (currentCount > beforeUserCount) {
        return true;
      }
      const current = normalizeBlockText(this.getCurrentText());
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

function resolveSource(node: HTMLElement): AssistantBlockSource {
  if (isModernDeepSeekMessage(node)) {
    return node.querySelector(":scope > .fbb737a4") ? "user" : "assistant";
  }
  const className = node.className || "";
  if (className.includes(DEEPSEEK_USER_MARKER_CLASS)) {
    return "user";
  }
  return "assistant";
}

function isModernDeepSeekMessage(node: HTMLElement): boolean {
  return node.classList.contains("ds-message");
}

function collectThinkText(root: HTMLElement): string {
  const thinkBlocks = Array.from(root.querySelectorAll("._74c0879 .ds-think-content .ds-markdown"));
  if (thinkBlocks.length === 0) {
    return "";
  }
  const chunks = thinkBlocks
    .map((node) => (node instanceof HTMLElement ? extractMarkdownParagraphs(node) : ""))
    .filter(Boolean);
  return normalizeBlockText(chunks.join("\n\n"));
}

function collectAnswerText(root: HTMLElement): string {
  const markdownNode = pickAnswerMarkdownNode(root);
  if (!markdownNode) {
    return "";
  }
  return normalizeBlockText(markdownNode.textContent ?? "");
}

function collectAnswerMarkdown(root: HTMLElement): string {
  const markdownNode = pickAnswerMarkdownNode(root);
  if (!markdownNode) {
    return "";
  }
  return normalizeBlockText(extractMarkdownParagraphs(markdownNode));
}

function pickAnswerMarkdownNode(root: HTMLElement): HTMLElement | null {
  const candidates = Array.from(root.querySelectorAll(":scope > .ds-markdown, :scope .ds-markdown"));
  const picked = candidates.filter((node) => !node.closest(".ds-think-content"));
  if (picked.length === 0) {
    return null;
  }
  const last = picked[picked.length - 1];
  return last instanceof HTMLElement ? last : null;
}

function collectWebReadSummary(root: HTMLElement): string {
  const direct = root.querySelector("._74c0879 .ffdab56b .d162f7b9");
  if (direct instanceof HTMLElement) {
    return normalizeBlockText(direct.textContent ?? "");
  }
  const alt = root.querySelector("._74c0879 .f93f59e4 ._669a677");
  if (alt instanceof HTMLElement) {
    const value = normalizeBlockText(alt.textContent ?? "");
    if (value) {
      return `已阅读 ${value}`;
    }
  }
  return "";
}

function extractMarkdownParagraphs(root: HTMLElement): string {
  const blocks: string[] = [];
  const children = Array.from(root.children);
  for (const child of children) {
    if (!(child instanceof HTMLElement)) {
      continue;
    }
    parseMarkdownBlock(child, blocks);
  }
  if (blocks.length > 0) {
    return normalizeBlockText(blocks.join("\n\n"));
  }
  return normalizeBlockText(renderInline(root));
}

function parseMarkdownBlock(node: HTMLElement, out: string[]): void {
  const tag = node.tagName.toLowerCase();
  if (node.classList.contains("md-code-block")) {
    const code = normalizeBlockText(node.querySelector("pre")?.textContent ?? "");
    if (!code) {
      return;
    }
    const lang = normalizeBlockText(node.querySelector(".d813de27")?.textContent ?? "");
    const fence = lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``;
    out.push(fence);
    return;
  }

  if (tag === "pre") {
    const code = normalizeBlockText(node.textContent ?? "");
    if (code) {
      out.push(`\`\`\`\n${code}\n\`\`\``);
    }
    return;
  }

  if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {
    const level = Number(tag.slice(1));
    const text = normalizeBlockText(renderInline(node));
    if (text) {
      out.push(`${"#".repeat(level)} ${text}`);
    }
    return;
  }

  if (tag === "ul" || tag === "ol") {
    const ordered = tag === "ol";
    const lines = renderList(node, ordered, 0);
    if (lines.length > 0) {
      out.push(lines.join("\n"));
    }
    return;
  }

  if (tag === "blockquote") {
    const lines = extractMarkdownParagraphs(node)
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
    if (normalizeBlockText(lines)) {
      out.push(lines);
    }
    return;
  }

  if (tag === "hr") {
    out.push("---");
    return;
  }

  const text = normalizeBlockText(renderInline(node));
  if (text) {
    out.push(text);
    return;
  }

  for (const child of Array.from(node.children)) {
    if (child instanceof HTMLElement) {
      parseMarkdownBlock(child, out);
    }
  }
}

function renderList(node: HTMLElement, ordered: boolean, depth: number): string[] {
  const out: string[] = [];
  const items = Array.from(node.children).filter((item): item is HTMLElement => item instanceof HTMLElement && item.tagName.toLowerCase() === "li");
  let index = 1;
  for (const item of items) {
    const marker = ordered ? `${index}.` : "-";
    index += 1;
    const indent = "  ".repeat(depth);
    const clone = item.cloneNode(true) as HTMLElement;
    for (const nested of Array.from(clone.querySelectorAll(":scope > ul, :scope > ol"))) {
      nested.remove();
    }
    const line = normalizeBlockText(renderInline(clone));
    if (line) {
      out.push(`${indent}${marker} ${line}`);
    }
    const nestedLists = Array.from(item.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && (child.tagName.toLowerCase() === "ul" || child.tagName.toLowerCase() === "ol")
    );
    for (const nested of nestedLists) {
      out.push(...renderList(nested, nested.tagName.toLowerCase() === "ol", depth + 1));
    }
  }
  return out;
}

function renderInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (!(node instanceof HTMLElement)) {
    return "";
  }
  const tag = node.tagName.toLowerCase();
  if (tag === "br") {
    return "\n";
  }

  const children = Array.from(node.childNodes).map((child) => renderInline(child)).join("");
  const text = children || node.textContent || "";

  if (tag === "strong" || tag === "b") {
    return `**${text}**`;
  }
  if (tag === "em" || tag === "i") {
    return `*${text}*`;
  }
  if (tag === "code") {
    return `\`${text}\``;
  }
  if (node.classList.contains("ds-markdown-cite")) {
    const cite = normalizeBlockText(node.textContent ?? "");
    return cite ? ` [${cite}]` : "";
  }
  if (tag === "a") {
    const href = node.getAttribute("href");
    const citeNode = node.querySelector(".ds-markdown-cite");
    if (citeNode instanceof HTMLElement) {
      const citeRaw = normalizeBlockText(citeNode.textContent ?? "");
      const cite = citeRaw.replace(/[^\d]/g, "");
      if (cite && href && /^https?:\/\//i.test(href)) {
        return `[${cite}](${href})`;
      }
      if (cite) {
        return `[${cite}]`;
      }
    }
    if (href && /^https?:\/\//i.test(href)) {
      return `[${normalizeBlockText(text) || href}](${href})`;
    }
    return text;
  }
  return text;
}

function countDeepSeekUserMessages(): number {
  const modern = Array.from(document.querySelectorAll(".ds-message._63c77b1")).filter((node) => {
    return node instanceof HTMLElement && node.querySelector(":scope > .fbb737a4");
  }).length;

  if (modern > 0) {
    return modern;
  }
  return document.querySelectorAll("._81e7b5e._19d617c").length;
}

function dispatchEnter(input: HTMLElement): void {
  const options: KeyboardEventInit = {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true
  };
  input.dispatchEvent(new KeyboardEvent("keydown", options));
  input.dispatchEvent(new KeyboardEvent("keypress", options));
  input.dispatchEvent(new KeyboardEvent("keyup", options));
}

function dispatchCtrlEnter(input: HTMLElement): void {
  const options: KeyboardEventInit = {
    key: "Enter",
    code: "Enter",
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  };
  input.dispatchEvent(new KeyboardEvent("keydown", options));
  input.dispatchEvent(new KeyboardEvent("keyup", options));
}

function dispatchMetaEnter(input: HTMLElement): void {
  const options: KeyboardEventInit = {
    key: "Enter",
    code: "Enter",
    metaKey: true,
    bubbles: true,
    cancelable: true
  };
  input.dispatchEvent(new KeyboardEvent("keydown", options));
  input.dispatchEvent(new KeyboardEvent("keyup", options));
}

function triggerClick(target: HTMLElement): void {
  if (typeof PointerEvent !== "undefined") {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse" }));
  }
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  target.click();
}

function submitClosestForm(input: HTMLElement): boolean {
  const form = input.closest("form");
  if (!form) {
    return false;
  }
  try {
    if (form instanceof HTMLFormElement && typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return true;
    }
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  } catch {
    return false;
  }
}

function scoreSendButton(node: HTMLElement): number {
  let score = 0;
  const className = String(node.className ?? "");
  const label = `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`.toLowerCase();

  if (className.includes("_7436101")) score += 100;
  if (className.includes("bcc55ca1")) score += 30;
  if (/(send|发送)/.test(label)) score += 60;
  if (/(upload|附件|attach|f02f0e25)/.test(`${label} ${className}`.toLowerCase())) score -= 120;

  const parent = node.parentElement;
  if (parent?.className && String(parent.className).includes("b13855df")) {
    score += 15;
    if (parent.lastElementChild === node) {
      score += 20;
    }
  }
  return score;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function createDeepSeekAdapter(): SiteAdapter {
  return new DeepSeekSiteAdapter();
}
