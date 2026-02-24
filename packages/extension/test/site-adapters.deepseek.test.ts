// @vitest-environment jsdom
/**
 * FlyCode Note: DeepSeek adapter behavior tests
 * Verifies MCP block extraction from current DeepSeek markdown containers and summary masking.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { parseMcpRequestBlock } from "../src/content/mcp-parser.js";
import { parseMcpResponseSummary } from "../src/site-adapters/common/summary-protocol.js";
import { DeepSeekSiteAdapter } from "../src/site-adapters/deepseek/adapter.js";

describe("DeepSeekSiteAdapter", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("extracts mcp-request from DeepSeek _72b6158 markdown block", () => {
    const fence = "```";
    document.body.innerHTML = `
      <div class="ds-message">
        <div class="_72b6158">${fence}mcp-request
{"jsonrpc":"2.0","id":"call-040","method":"tools/call","params":{"name":"fs.ls","arguments":{"path":"/root/work/person","depth":1}}}
${fence}</div>
      </div>
    `;

    const adapter = new DeepSeekSiteAdapter();
    const blocks = adapter.collectAssistantBlocks();
    const block = blocks.find((item) => item.kind === "mcp-request");

    expect(block).toBeTruthy();
    const parsed = parseMcpRequestBlock(block?.text ?? "");
    expect(parsed?.id).toBe("call-040");
    expect(parsed?.envelope.method).toBe("tools/call");
  });

  it("extracts mcp-request from DeepSeek md-code-block (header + pre body)", () => {
    document.body.innerHTML = `
      <div class="ds-message">
        <div class="ds-markdown">
          <div class="md-code-block md-code-block-light">
            <div class="md-code-block-banner-wrap">
              <span class="d813de27">mcp-request</span>
            </div>
            <pre><span>{"jsonrpc":"2.0","id":"call-041","method":"tools/call","params":{"name":"fs.ls","arguments":{"path":"/root/work/flycode"}}}</span></pre>
          </div>
        </div>
      </div>
    `;

    const adapter = new DeepSeekSiteAdapter();
    const blocks = adapter.collectAssistantBlocks();
    const block = blocks.find((item) => item.kind === "mcp-request");
    expect(block).toBeTruthy();

    const parsed = parseMcpRequestBlock(block?.text ?? "");
    expect(parsed?.id).toBe("call-041");
    expect(parsed?.envelope.method).toBe("tools/call");
  });

  it("extracts mcp-response summary from DeepSeek _72b6158 markdown block", () => {
    const fence = "```";
    document.body.innerHTML = `
      <div class="ds-message">
        <div class="_72b6158">${fence}mcp-response
{"jsonrpc":"2.0","id":"call-039","result":{"content":[{"type":"text","text":"ok"}]}}
${fence}</div>
      </div>
    `;

    const adapter = new DeepSeekSiteAdapter();
    const blocks = adapter.collectAssistantBlocks();
    const block = blocks.find((item) => item.kind === "mcp-response");
    expect(block).toBeTruthy();

    const summary = parseMcpResponseSummary(block?.text ?? "", block?.kind ?? "unknown");
    expect(summary?.id).toBe("call-039");
    expect(summary?.status).toBe("成功");
  });

  it("does not treat user-side mcp-request block as executable request", () => {
    const fence = "```";
    document.body.innerHTML = `
      <div class="_81e7b5e _19d617c">
        <div class="_72b6158">${fence}mcp-request
{"jsonrpc":"2.0","id":"call-042","method":"tools/call","params":{"name":"fs.ls","arguments":{"path":"/tmp"}}}
${fence}</div>
      </div>
    `;

    const adapter = new DeepSeekSiteAdapter();
    const blocks = adapter.collectAssistantBlocks();
    const block = blocks[0];
    expect(block).toBeTruthy();
    expect(block.source).toBe("user");
    expect(block.kind).toBe("unknown");
  });

  it("masks DeepSeek result block into compact summary text", () => {
    const fence = "```";
    document.body.innerHTML = `
      <div class="ds-message">
        <div id="target" class="_72b6158">${fence}mcp-response
{"jsonrpc":"2.0","id":"call-039","result":{"content":[{"type":"text","text":"ok"}]}}
${fence}</div>
      </div>
    `;

    const node = document.getElementById("target");
    expect(node instanceof HTMLElement).toBe(true);
    if (!(node instanceof HTMLElement)) {
      throw new Error("target block not found");
    }

    const adapter = new DeepSeekSiteAdapter();
    adapter.applyMaskedSummary(node, "状态：成功\n命令：tools/call:fs.ls");

    expect(node.getAttribute("data-flycode-masked")).toBe("1");
    expect(node.textContent).toContain("状态：成功");
    expect(node.textContent).toContain("命令：tools/call:fs.ls");
  });
});
