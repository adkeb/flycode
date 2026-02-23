/**
 * FlyCode Note: Compact result summary parser tests
 * Verifies mcp-response / flycode-result / flycode-upload can be summarized to status+command only.
 */
import { describe, expect, it } from "vitest";
import {
  formatSummary,
  isFlycodeUploadPayload,
  parseFlycodeResultSummary,
  parseMcpResponseSummary
} from "../src/site-adapters/common/summary-protocol.js";

describe("summary-protocol", () => {
  it("parses mcp-response payload and marks pending confirmation", () => {
    const raw = [
      "```mcp-response",
      JSON.stringify(
        {
          jsonrpc: "2.0",
          id: "call-101",
          result: {
            content: [{ type: "text", text: "pending" }],
            meta: {
              pendingConfirmationId: "pending-1"
            }
          }
        },
        null,
        2
      ),
      "```"
    ].join("\n");

    const parsed = parseMcpResponseSummary(raw, "mcp-response");
    expect(parsed?.id).toBe("call-101");
    expect(parsed?.status).toBe("等待确认");
  });

  it("parses legacy flycode-result into status and command", () => {
    const raw = [
      "```flycode-result",
      "[id] call-001",
      "[command] /fs.read /root/work/flycode/README.md",
      "[ok] true",
      "```"
    ].join("\n");

    const parsed = parseFlycodeResultSummary(raw, "flycode-result");
    expect(parsed?.status).toBe("成功");
    expect(parsed?.command).toBe("/fs.read /root/work/flycode/README.md");
  });

  it("detects flycode-upload payload", () => {
    const raw = [
      "```flycode-upload",
      "[source] flycode-file-picker",
      "[mode] files",
      "[selected] 1",
      "```"
    ].join("\n");

    expect(isFlycodeUploadPayload(raw, "flycode-upload")).toBe(true);
  });

  it("formats summary with only status and command lines", () => {
    const summary = formatSummary("失败", "tools/call:fs.read");
    const lines = summary.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("状态：失败");
    expect(lines[1]).toBe("命令：tools/call:fs.read");
    expect(summary).not.toContain("auditId");
    expect(summary).not.toContain("data");
    expect(summary).not.toContain("id:");
  });
});
