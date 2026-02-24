// @vitest-environment jsdom
/**
 * FlyCode Note: Gemini adapter behavior tests
 * Covers model-block extraction, button-first submit, and compact summary replacement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiSiteAdapter } from "../src/site-adapters/gemini/adapter.js";
import { parseMcpRequestBlock } from "../src/content/mcp-parser.js";

describe("GeminiSiteAdapter", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("extracts model mcp-request blocks and ignores user-side blocks", () => {
    document.body.innerHTML = `
      <div data-message-author-role="user">
        <pre><code>mcp-request\n{"jsonrpc":"2.0","id":"user-001","method":"tools/list","params":{}}</code></pre>
      </div>
      <div data-message-author-role="model">
        <pre><code>mcp-request\n{"jsonrpc":"2.0","id":"call-201","method":"tools/call","params":{"name":"fs.ls","arguments":{"path":"/root/work/flycode"}}}</code></pre>
      </div>
    `;

    const adapter = new GeminiSiteAdapter();
    const blocks = adapter.collectAssistantBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("mcp-request");

    const parsed = parseMcpRequestBlock(blocks[0]?.text ?? "");
    expect(parsed?.id).toBe("call-201");
  });

  it("submits via enabled send button and clears input", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div>
        <div role="textbox" contenteditable="true">initial</div>
        <button aria-label="Send message">Send</button>
      </div>
    `;

    const adapter = new GeminiSiteAdapter();
    const input = document.querySelector("div[role='textbox']");
    const button = document.querySelector("button[aria-label='Send message']");
    expect(input instanceof HTMLElement).toBe(true);
    expect(button instanceof HTMLButtonElement).toBe(true);
    if (!(input instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error("test dom not ready");
    }

    adapter.injectText("new payload");
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
      input.textContent = "";
      const userNode = document.createElement("div");
      userNode.className = "user-message";
      document.body.appendChild(userNode);
    });

    const task = adapter.submitAuto();
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await task;

    expect(outcome.ok).toBe(true);
    expect(outcome.method).toBe("button");
    expect(clicks).toBeGreaterThan(0);
  });

  it("applies summary on block node", () => {
    document.body.innerHTML = `
      <pre id="target"><code>mcp-response\n{"jsonrpc":"2.0","id":"call-001","result":{"content":[]}}</code></pre>
    `;

    const adapter = new GeminiSiteAdapter();
    const node = document.getElementById("target");
    expect(node instanceof HTMLElement).toBe(true);
    if (!(node instanceof HTMLElement)) {
      throw new Error("target missing");
    }

    adapter.applyMaskedSummary(node, "状态：成功\n命令：tools/call:fs.read");
    expect(node.textContent).toContain("状态：成功");
    expect(node.textContent).toContain("命令：tools/call:fs.read");
    expect(node.getAttribute("data-flycode-masked")).toBe("1");
  });
});
