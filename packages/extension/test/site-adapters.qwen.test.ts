// @vitest-environment jsdom
/**
 * FlyCode Note: Qwen adapter behavior tests
 * Covers MCP block extraction, summary replacement, and button-first auto submit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QwenSiteAdapter } from "../src/site-adapters/qwen/adapter.js";
import { parseMcpRequestBlock } from "../src/content/mcp-parser.js";
import { parseMcpResponseSummary } from "../src/site-adapters/common/summary-protocol.js";

describe("QwenSiteAdapter", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("extracts mcp-request block from qwen markdown code container", () => {
    document.body.innerHTML = `
      <pre class="qwen-markdown-code">
        <div class="qwen-markdown-code-header"><div>mcp-request</div></div>
        <div class="qwen-markdown-code-body mcp-request">
          <div class="view-line">{\"jsonrpc\":\"2.0\",\"id\":\"call-001\",\"method\":\"tools/call\",\"params\":{\"name\":\"fs.ls\",\"arguments\":{\"path\":\"/root/work/flycode\"}}}</div>
        </div>
      </pre>
    `;

    const adapter = new QwenSiteAdapter();
    const blocks = adapter.collectAssistantBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("mcp-request");

    const parsed = parseMcpRequestBlock(blocks[0]?.text ?? "");
    expect(parsed?.id).toBe("call-001");
    expect(parsed?.envelope.method).toBe("tools/call");
  });

  it("extracts mcp-response body and strips visual line prefixes", () => {
    document.body.innerHTML = `
      <pre class="qwen-markdown-code">
        <div class="qwen-markdown-code-header"><div>mcp-response</div></div>
        <div class="qwen-markdown-code-body mcp-response">
          <div class="view-line">1 {\"jsonrpc\":\"2.0\",\"id\":\"call-009\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}</div>
        </div>
      </pre>
    `;

    const adapter = new QwenSiteAdapter();
    const blocks = adapter.collectAssistantBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("mcp-response");
    expect(blocks[0]?.text.startsWith("{")).toBe(true);

    const parsed = parseMcpResponseSummary(blocks[0]?.text ?? "", blocks[0]?.kind ?? "unknown");
    expect(parsed?.id).toBe("call-009");
    expect(parsed?.status).toBe("成功");
  });

  it("extracts user-message fenced mcp-response block and marks as user source", () => {
    document.body.innerHTML = `
      <div class="qwen-chat-message qwen-chat-message-user">
        <p class="whitespace-pre-wrap user-message-content">
          <span>\`\`\`mcp-response
{"jsonrpc":"2.0","id":"call-028","result":{"content":[{"type":"text","text":"ok"}]}}
\`\`\`</span>
        </p>
      </div>
    `;

    const adapter = new QwenSiteAdapter();
    const blocks = adapter.collectAssistantBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("mcp-response");
    expect(blocks[0]?.source).toBe("user");

    const parsed = parseMcpResponseSummary(blocks[0]?.text ?? "", blocks[0]?.kind ?? "unknown");
    expect(parsed?.id).toBe("call-028");
    expect(parsed?.status).toBe("成功");
  });

  it("applies summary by hiding source block and creating one summary node", () => {
    document.body.innerHTML = `
      <pre id="source" class="qwen-markdown-code">
        <div class="qwen-markdown-code-header"><div>mcp-response</div></div>
        <div class="qwen-markdown-code-body mcp-response">
          <div class="view-line">{\"jsonrpc\":\"2.0\",\"id\":\"call-001\",\"result\":{\"content\":[]}}</div>
        </div>
      </pre>
    `;

    const adapter = new QwenSiteAdapter();
    const source = document.getElementById("source");
    expect(source instanceof HTMLElement).toBe(true);
    if (!(source instanceof HTMLElement)) {
      throw new Error("source block missing");
    }

    adapter.applyMaskedSummary(source, "状态：成功\\n命令：tools/call:fs.read");
    adapter.applyMaskedSummary(source, "状态：成功\\n命令：tools/call:fs.read");

    expect(source.getAttribute("data-flycode-masked")).toBe("1");
    expect(source.style.display).toBe("none");

    const summaries = document.querySelectorAll("[data-flycode-summary='1']");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.textContent).toContain("状态：成功");
    expect(summaries[0]?.textContent).toContain("命令：tools/call:fs.read");
  });

  it("submits via send button first with retry when button becomes enabled", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div>
        <textarea class="message-input-textarea"></textarea>
        <button class="send-button disabled" disabled>Send</button>
      </div>
    `;

    const adapter = new QwenSiteAdapter();
    const button = document.querySelector("button.send-button");
    const textarea = document.querySelector("textarea.message-input-textarea");
    expect(button instanceof HTMLButtonElement).toBe(true);
    expect(textarea instanceof HTMLTextAreaElement).toBe(true);
    if (!(button instanceof HTMLButtonElement) || !(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("test dom missing");
    }

    adapter.injectText("mcp response payload");
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
      textarea.value = "";
      const msg = document.createElement("div");
      msg.className = "qwen-chat-message-user";
      document.body.appendChild(msg);
    });

    window.setTimeout(() => {
      button.disabled = false;
      button.className = "send-button";
    }, 50);

    const task = adapter.submitAuto();
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await task;

    expect(outcome.ok).toBe(true);
    expect(outcome.method).toBe("button");
    expect(clicks).toBeGreaterThan(0);
  });
});
