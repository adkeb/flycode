import type { ParsedCommand } from "./types.js";

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("/fs.writeBatch")) {
    throw new Error("/fs.writeBatch is JSON-only in auto tool mode");
  }

  if (trimmed.startsWith("/fs.write")) {
    return parseWrite(trimmed);
  }

  if (trimmed.startsWith("/shell.exec")) {
    return parseShellExec(trimmed);
  }

  if (trimmed.startsWith("/process.run")) {
    return parseProcessRun(trimmed);
  }

  if (!trimmed.startsWith("/fs.")) {
    return null;
  }

  const args = tokenize(trimmed);
  const command = args[0];

  if (command === "/fs.ls") {
    const filePath = assertArg(args[1], "Missing path for /fs.ls");
    const depth = readNumberFlag(args, "--depth");
    const glob = readStringFlag(args, "--glob");

    return {
      command: "fs.ls",
      path: filePath,
      depth,
      glob,
      raw: trimmed
    };
  }

  if (command === "/fs.mkdir") {
    const dirPath = assertArg(args[1], "Missing path for /fs.mkdir");
    const parents = hasFlag(args, "--parents") || undefined;

    return {
      command: "fs.mkdir",
      path: dirPath,
      parents,
      raw: trimmed
    };
  }

  if (command === "/fs.read") {
    const filePath = assertArg(args[1], "Missing path for /fs.read");
    const head = readNumberFlag(args, "--head");
    const tail = readNumberFlag(args, "--tail");
    const range = readStringFlag(args, "--range");
    const line = readNumberFlag(args, "--line");
    const lines = readStringFlag(args, "--lines");
    const encoding = readStringFlag(args, "--encoding") as "utf-8" | "base64" | "hex" | undefined;
    const includeMeta = hasFlag(args, "--no-meta") ? false : hasFlag(args, "--include-meta") || undefined;

    const selectors = [head, tail, range, line, lines].filter((item) => item !== undefined);
    if (selectors.length > 1) {
      throw new Error("Only one of --head/--tail/--range/--line/--lines can be used");
    }

    let mergedRange = range;
    if (head !== undefined) mergedRange = `head:${head}`;
    if (tail !== undefined) mergedRange = `tail:${tail}`;

    return {
      command: "fs.read",
      path: filePath,
      range: mergedRange,
      line,
      lines,
      encoding,
      includeMeta,
      raw: trimmed
    };
  }

  if (command === "/fs.search") {
    const filePath = assertArg(args[1], "Missing path for /fs.search");
    const query = assertArg(readStringFlag(args, "--query"), "Missing --query for /fs.search");
    const regex = hasFlag(args, "--regex") || undefined;
    const glob = readStringFlag(args, "--glob");
    const limit = readNumberFlag(args, "--limit");
    const minBytes = readNumberFlag(args, "--min-bytes");
    const maxBytes = readNumberFlag(args, "--max-bytes");
    const mtimeFrom = readStringFlag(args, "--mtime-from");
    const mtimeTo = readStringFlag(args, "--mtime-to");
    const contextLines = readNumberFlag(args, "--context");
    const extFlags = readRepeatedStringFlags(args, "--ext");
    const extensionsArg = readStringFlag(args, "--extensions");
    const extensionsFromCsv = extensionsArg
      ? extensionsArg
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    const extensions = [...extFlags, ...extensionsFromCsv];

    return {
      command: "fs.search",
      path: filePath,
      query,
      regex,
      glob,
      limit,
      extensions: extensions.length > 0 ? extensions : undefined,
      minBytes,
      maxBytes,
      mtimeFrom,
      mtimeTo,
      contextLines,
      raw: trimmed
    };
  }

  if (command === "/fs.rm") {
    const filePath = assertArg(args[1], "Missing path for /fs.rm");
    const recursive = hasFlag(args, "--recursive") || undefined;
    const force = hasFlag(args, "--force") || undefined;

    return {
      command: "fs.rm",
      path: filePath,
      recursive,
      force,
      raw: trimmed
    };
  }

  if (command === "/fs.mv") {
    const fromPath = assertArg(args[1], "Missing fromPath for /fs.mv");
    const toPath = assertArg(args[2], "Missing toPath for /fs.mv");
    const overwrite = hasFlag(args, "--overwrite") || undefined;

    return {
      command: "fs.mv",
      fromPath,
      toPath,
      overwrite,
      raw: trimmed
    };
  }

  if (command === "/fs.chmod") {
    const filePath = assertArg(args[1], "Missing path for /fs.chmod");
    const mode = assertArg(readStringFlag(args, "--mode"), "Missing --mode for /fs.chmod");

    return {
      command: "fs.chmod",
      path: filePath,
      mode,
      raw: trimmed
    };
  }

  if (command === "/fs.diff") {
    const leftPath = assertArg(args[1], "Missing leftPath for /fs.diff");
    const rightPath = readStringFlag(args, "--right-path");
    const rightContent = extractFlagContent(input, "--right-content");
    const context = readNumberFlag(args, "--context");

    if ((rightPath && rightContent !== undefined) || (!rightPath && rightContent === undefined)) {
      throw new Error("Provide either --right-path or --right-content for /fs.diff");
    }

    return {
      command: "fs.diff",
      leftPath,
      rightPath,
      rightContent,
      contextLines: context,
      raw: trimmed
    };
  }

  throw new Error(`Unsupported command: ${command}`);
}

function parseWrite(input: string): ParsedCommand {
  const args = tokenize(input);
  const filePath = assertArg(args[1], "Missing path for /fs.write");

  const modeMatch = /--mode\s+(overwrite|append)/.exec(input);
  const mode = (modeMatch?.[1] as "overwrite" | "append" | undefined) ?? "overwrite";

  const expectedShaMatch = /--expectedSha256\s+([a-fA-F0-9]+)/.exec(input);
  const expectedSha256 = expectedShaMatch?.[1];

  const content = extractWriteContent(input);

  return {
    command: "fs.write",
    path: filePath,
    mode,
    content,
    expectedSha256,
    raw: input
  };
}

function parseProcessRun(input: string): ParsedCommand {
  const args = tokenize(input);
  const commandName = assertArg(args[1], "Missing command for /process.run");
  const commandArgs = readRepeatedStringFlags(args, "--arg");
  const cwd = readStringFlag(args, "--cwd");
  const timeoutMs = readNumberFlag(args, "--timeout-ms");
  const envArgs = readRepeatedStringFlags(args, "--env");
  const env = parseEnvFlags(envArgs);

  return {
    command: "process.run",
    commandName,
    args: commandArgs.length > 0 ? commandArgs : undefined,
    cwd,
    timeoutMs,
    env,
    raw: input
  };
}

function parseShellExec(input: string): ParsedCommand {
  const args = tokenize(input);
  const commandText = assertArg(readStringFlag(args, "--command"), "Missing --command for /shell.exec");
  const cwd = readStringFlag(args, "--cwd");
  const timeoutMs = readNumberFlag(args, "--timeout-ms");
  const envArgs = readRepeatedStringFlags(args, "--env");
  const env = parseEnvFlags(envArgs);

  return {
    command: "shell.exec",
    commandText,
    cwd,
    timeoutMs,
    env,
    raw: input
  };
}

function extractWriteContent(input: string): string {
  const triple = /--content\s+"""([\s\S]*?)"""/m.exec(input);
  if (triple) {
    return triple[1];
  }

  const single = /--content\s+'([\s\S]*?)'/m.exec(input);
  if (single) {
    return single[1];
  }

  const double = /--content\s+"([\s\S]*?)"/m.exec(input);
  if (double) {
    return double[1];
  }

  const bare = /--content\s+(\S+)/.exec(input);
  if (bare) {
    return bare[1];
  }

  throw new Error("Missing --content for /fs.write");
}

function extractFlagContent(input: string, flag: string): string | undefined {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const triple = new RegExp(`${escapedFlag}\\s+"""([\\s\\S]*?)"""`, "m").exec(input);
  if (triple) {
    return triple[1];
  }

  const single = new RegExp(`${escapedFlag}\\s+'([\\s\\S]*?)'`, "m").exec(input);
  if (single) {
    return single[1];
  }

  const double = new RegExp(`${escapedFlag}\\s+\"([\\s\\S]*?)\"`, "m").exec(input);
  if (double) {
    return double[1];
  }

  const bare = new RegExp(`${escapedFlag}\\s+(\\S+)`).exec(input);
  if (bare) {
    return bare[1];
  }

  return undefined;
}

function parseEnvFlags(entries: string[]): Record<string, string> | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const entry of entries) {
    const idx = entry.indexOf("=");
    if (idx <= 0) {
      throw new Error(`Invalid --env value: ${entry}. Expected KEY=VALUE.`);
    }
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1);
    if (!key) {
      throw new Error(`Invalid --env key in value: ${entry}`);
    }
    out[key] = value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i += 1;
    if (i >= input.length) break;

    const startChar = input[i];
    if (startChar === "\"" || startChar === "'") {
      const quote = startChar;
      i += 1;
      let token = "";
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          token += input[i + 1];
          i += 2;
          continue;
        }
        token += input[i];
        i += 1;
      }
      i += 1;
      out.push(token);
      continue;
    }

    let token = "";
    while (i < input.length && !/\s/.test(input[i])) {
      token += input[i];
      i += 1;
    }
    out.push(token);
  }

  return out;
}

function readStringFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) {
    return undefined;
  }

  return args[idx + 1];
}

function readRepeatedStringFlags(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== flag) {
      continue;
    }
    const value = args[i + 1];
    if (value !== undefined && !value.startsWith("--")) {
      out.push(value);
      i += 1;
    }
  }
  return out;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = readStringFlag(args, flag);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${flag}: ${value}`);
  }

  return parsed;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function assertArg<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(message);
  }
  return value;
}
