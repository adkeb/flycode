/**
 * FlyCode Note: Auto tool parsing tests
 * Verifies flycode-call parsing, JSON tool conversion, ID requirements, and stable command hashing.
 */
import { describe, expect, it } from "vitest";
import { parseAutoToolCallFromBlock } from "../src/content/auto-tool.js";

describe("parseAutoToolCallFromBlock", () => {
  it("parses slash command in flycode-call block", () => {
    const parsed = parseAutoToolCallFromBlock(`[flycode-call]\nid: call-1\n/fs.read /tmp/a.txt --head 200`);
    expect(parsed).toMatchObject({
      callId: "call-1",
      rawCommand: "/fs.read /tmp/a.txt --head 200",
      parsedCommand: {
        command: "fs.read",
        path: "/tmp/a.txt",
        range: "head:200"
      }
    });
  });

  it("parses json command payload", () => {
    const parsed = parseAutoToolCallFromBlock(
      JSON.stringify({
        id: "call-1",
        command: "/fs.search /tmp --query \"TODO\" --limit 10"
      })
    );

    expect(parsed?.callId).toBe("call-1");
    expect(parsed?.parsedCommand).toMatchObject({
      command: "fs.search",
      path: "/tmp",
      query: "TODO",
      limit: 10
    });
  });

  it("parses json tool payload and converts into slash command", () => {
    const parsed = parseAutoToolCallFromBlock(
      JSON.stringify({
        id: "tool-1",
        tool: "fs.ls",
        args: {
          path: "/tmp",
          depth: 2,
          glob: "**/*.ts"
        }
      })
    );

    expect(parsed?.rawCommand).toBe('/fs.ls /tmp --depth 2 --glob "**/*.ts"');
    expect(parsed?.parsedCommand).toMatchObject({
      command: "fs.ls",
      path: "/tmp",
      depth: 2,
      glob: "**/*.ts"
    });
  });

  it("parses fs.mkdir tool payload with parents", () => {
    const parsed = parseAutoToolCallFromBlock(
      JSON.stringify({
        id: "mkdir-1",
        tool: "fs.mkdir",
        args: {
          path: "/tmp/new-folder",
          parents: true
        }
      })
    );

    expect(parsed?.rawCommand).toBe("/fs.mkdir /tmp/new-folder --parents");
    expect(parsed?.parsedCommand).toMatchObject({
      command: "fs.mkdir",
      path: "/tmp/new-folder",
      parents: true
    });
  });

  it("parses fs.writeBatch tool payload (json-only)", () => {
    const parsed = parseAutoToolCallFromBlock(
      JSON.stringify({
        id: "batch-1",
        tool: "fs.writeBatch",
        args: {
          files: [
            { path: "/tmp/a.txt", mode: "overwrite", content: "a" },
            { path: "/tmp/b.txt", mode: "append", content: "b" }
          ]
        }
      })
    );

    expect(parsed?.rawCommand).toBe("/fs.writeBatch 2 files");
    expect(parsed?.parsedCommand).toMatchObject({
      command: "fs.writeBatch",
      files: [
        { path: "/tmp/a.txt", mode: "overwrite", content: "a" },
        { path: "/tmp/b.txt", mode: "append", content: "b" }
      ]
    });
  });

  it("parses process.run tool payload", () => {
    const parsed = parseAutoToolCallFromBlock(
      JSON.stringify({
        id: "proc-1",
        tool: "process.run",
        args: {
          command: "npm",
          args: ["run", "test"],
          cwd: "/tmp/p"
        }
      })
    );

    expect(parsed?.rawCommand).toContain("/process.run npm");
    expect(parsed?.parsedCommand).toMatchObject({
      command: "process.run",
      commandName: "npm",
      args: ["run", "test"],
      cwd: "/tmp/p"
    });
  });

  it("parses shell.exec tool payload", () => {
    const parsed = parseAutoToolCallFromBlock(
      JSON.stringify({
        id: "shell-1",
        tool: "shell.exec",
        args: {
          command: "git status",
          cwd: "/tmp/p"
        }
      })
    );

    expect(parsed?.rawCommand).toContain("/shell.exec --command");
    expect(parsed?.parsedCommand).toMatchObject({
      command: "shell.exec",
      commandText: "git status",
      cwd: "/tmp/p"
    });
  });

  it("keeps fs.read selector and extra flags together", () => {
    const parsed = parseAutoToolCallFromBlock(
      JSON.stringify({
        id: "read-1",
        tool: "fs.read",
        args: {
          path: "/tmp/a.txt",
          line: 15,
          encoding: "utf-8",
          includeMeta: false
        }
      })
    );

    expect(parsed?.rawCommand).toBe("/fs.read /tmp/a.txt --line 15 --encoding utf-8 --no-meta");
    expect(parsed?.parsedCommand).toMatchObject({
      command: "fs.read",
      path: "/tmp/a.txt",
      line: 15,
      encoding: "utf-8",
      includeMeta: false
    });
  });

  it("returns null for non-call code blocks", () => {
    const parsed = parseAutoToolCallFromBlock("const a = 1;");
    expect(parsed).toBeNull();
  });

  it("builds stable commandHash for formatting differences", () => {
    const a = parseAutoToolCallFromBlock(`[flycode-call]\nid: call-7\n/fs.read /tmp/a.txt --head 100`);
    const b = parseAutoToolCallFromBlock(`[flycode-call]\nid: call-7\n   /fs.read   /tmp/a.txt   --head   100   `);

    expect(a?.commandHash).toBeTruthy();
    expect(a?.commandHash).toBe(b?.commandHash);
  });

  it("parses fenced flycode-call block", () => {
    const parsed = parseAutoToolCallFromBlock(
      "```flycode-call\n{\"id\":\"call-8\",\"tool\":\"fs.ls\",\"args\":{\"path\":\"/tmp\"}}\n```"
    );

    expect(parsed?.callId).toBe("call-8");
    expect(parsed?.parsedCommand).toMatchObject({
      command: "fs.ls",
      path: "/tmp"
    });
  });

  it("parses language-prefixed json block", () => {
    const parsed = parseAutoToolCallFromBlock(
      "json\n{\"id\":\"call-9\",\"tool\":\"fs.read\",\"args\":{\"path\":\"/tmp/a.txt\",\"head\":100}}"
    );

    expect(parsed?.callId).toBe("call-9");
    expect(parsed?.parsedCommand).toMatchObject({
      command: "fs.read",
      path: "/tmp/a.txt",
      range: "head:100"
    });
  });

  it("returns null when call id is missing for slash command", () => {
    const parsed = parseAutoToolCallFromBlock(`[flycode-call]\n/fs.ls /tmp`);
    expect(parsed).toBeNull();
  });

  it("returns null when call id is missing for json tool payload", () => {
    const parsed = parseAutoToolCallFromBlock(
      JSON.stringify({
        tool: "fs.read",
        args: {
          path: "/tmp/a.txt",
          head: 100
        }
      })
    );
    expect(parsed).toBeNull();
  });
});
