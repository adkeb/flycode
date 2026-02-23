/**
 * FlyCode Note: MCP parser tests
 * Ensures content script only executes valid mcp-request fenced JSON-RPC blocks.
 */
import { describe, expect, it } from "vitest";
import { parseMcpRequestBlock } from "../src/content/mcp-parser.js";

describe("parseMcpRequestBlock", () => {
  it("parses tools/call block", () => {
    const parsed = parseMcpRequestBlock(
      [
        "```mcp-request",
        '{"jsonrpc":"2.0","id":"call-001","method":"tools/call","params":{"name":"fs.read","arguments":{"path":"/tmp/a.txt"}}}',
        "```"
      ].join("\n")
    );

    expect(parsed?.id).toBe("call-001");
    expect(parsed?.envelope.method).toBe("tools/call");
  });

  it("parses deepseek plain code-block text (no backticks in textContent)", () => {
    const parsed = parseMcpRequestBlock(
      [
        "mcp-request",
        '{"jsonrpc":"2.0","id":"call-plain-001","method":"tools/call","params":{"name":"fs.ls","arguments":{"path":"/root/work/flycode"}}}'
      ].join("\n")
    );

    expect(parsed?.id).toBe("call-plain-001");
    expect(parsed?.envelope.method).toBe("tools/call");
  });

  it("parses payload when wrapper text exists around json", () => {
    const parsed = parseMcpRequestBlock(
      [
        "mcp-request",
        "copy download",
        '{"jsonrpc":"2.0","id":"call-wrap-001","method":"tools/list","params":{}}',
        "extra footer"
      ].join("\n")
    );

    expect(parsed?.id).toBe("call-wrap-001");
    expect(parsed?.envelope.method).toBe("tools/list");
  });

  it("rejects invalid method", () => {
    const parsed = parseMcpRequestBlock(
      [
        "```mcp-request",
        '{"jsonrpc":"2.0","id":"call-001","method":"unknown","params":{}}',
        "```"
      ].join("\n")
    );
    expect(parsed).toBeNull();
  });

  it("rejects missing id", () => {
    const parsed = parseMcpRequestBlock(
      [
        "```mcp-request",
        '{"jsonrpc":"2.0","method":"tools/list"}',
        "```"
      ].join("\n")
    );
    expect(parsed).toBeNull();
  });
});
