import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/shared/parser.js";

describe("parseCommand", () => {
  it("parses fs.ls", () => {
    const parsed = parseCommand('/fs.ls "/tmp" --depth 3 --glob "**/*.ts"');
    expect(parsed).toEqual({
      command: "fs.ls",
      path: "/tmp",
      depth: 3,
      glob: "**/*.ts",
      raw: '/fs.ls "/tmp" --depth 3 --glob "**/*.ts"'
    });
  });

  it("parses fs.read head range", () => {
    const parsed = parseCommand("/fs.read ./README.md --head 128");
    expect(parsed).toMatchObject({
      command: "fs.read",
      path: "./README.md",
      range: "head:128"
    });
  });

  it("parses fs.read line and encoding flags", () => {
    const parsed = parseCommand('/fs.read "/tmp/a.bin" --line 15 --encoding base64 --no-meta');
    expect(parsed).toMatchObject({
      command: "fs.read",
      path: "/tmp/a.bin",
      line: 15,
      encoding: "base64",
      includeMeta: false
    });
  });

  it("parses fs.mkdir", () => {
    const parsed = parseCommand('/fs.mkdir "/tmp/new-folder" --parents');
    expect(parsed).toEqual({
      command: "fs.mkdir",
      path: "/tmp/new-folder",
      parents: true,
      raw: '/fs.mkdir "/tmp/new-folder" --parents'
    });
  });

  it("parses fs.search with regex", () => {
    const parsed = parseCommand('/fs.search . --query "TODO" --regex --limit 20 --ext ts --ext js --min-bytes 10 --context 2');
    expect(parsed).toMatchObject({
      command: "fs.search",
      path: ".",
      query: "TODO",
      regex: true,
      limit: 20,
      extensions: ["ts", "js"],
      minBytes: 10,
      contextLines: 2
    });
  });

  it("parses fs.rm", () => {
    const parsed = parseCommand("/fs.rm /tmp/old --recursive --force");
    expect(parsed).toMatchObject({
      command: "fs.rm",
      path: "/tmp/old",
      recursive: true,
      force: true
    });
  });

  it("parses fs.mv", () => {
    const parsed = parseCommand('/fs.mv "/tmp/a.txt" "/tmp/b.txt" --overwrite');
    expect(parsed).toMatchObject({
      command: "fs.mv",
      fromPath: "/tmp/a.txt",
      toPath: "/tmp/b.txt",
      overwrite: true
    });
  });

  it("parses fs.chmod", () => {
    const parsed = parseCommand("/fs.chmod /tmp/a.sh --mode 755");
    expect(parsed).toMatchObject({
      command: "fs.chmod",
      path: "/tmp/a.sh",
      mode: "755"
    });
  });

  it("parses fs.diff with right-content", () => {
    const parsed = parseCommand('/fs.diff /tmp/a.txt --right-content """new""" --context 5');
    expect(parsed).toMatchObject({
      command: "fs.diff",
      leftPath: "/tmp/a.txt",
      rightContent: "new",
      contextLines: 5
    });
  });

  it("parses process.run", () => {
    const parsed = parseCommand('/process.run npm --arg run --arg test --cwd /tmp/p --timeout-ms 12000 --env NODE_ENV=test');
    expect(parsed).toMatchObject({
      command: "process.run",
      commandName: "npm",
      args: ["run", "test"],
      cwd: "/tmp/p",
      timeoutMs: 12000,
      env: {
        NODE_ENV: "test"
      }
    });
  });

  it("parses shell.exec", () => {
    const parsed = parseCommand('/shell.exec --command "git status" --cwd /tmp/p --timeout-ms 3000');
    expect(parsed).toMatchObject({
      command: "shell.exec",
      commandText: "git status",
      cwd: "/tmp/p",
      timeoutMs: 3000
    });
  });

  it("parses fs.write triple quote content", () => {
    const parsed = parseCommand('/fs.write ./a.txt --mode append --content """hello\\nworld"""');
    expect(parsed).toMatchObject({
      command: "fs.write",
      path: "./a.txt",
      mode: "append",
      content: "hello\\nworld"
    });
  });

  it("throws on invalid command", () => {
    expect(() => parseCommand("/fs.search . --limit not-a-number")).toThrowError();
  });

  it("throws for fs.writeBatch slash command", () => {
    expect(() => parseCommand("/fs.writeBatch /tmp/a.txt")).toThrowError(/json-only/i);
  });
});
