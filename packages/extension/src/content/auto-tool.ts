/**
 * FlyCode Note: Auto tool block parser
 * Parses flycode-call blocks from AI output and converts JSON tool objects into executable commands.
 */
import { parseCommand } from "../shared/parser.js";
import type { ParsedCommand } from "../shared/types.js";

export interface AutoToolCall {
  callId?: string;
  rawCommand: string;
  commandHash: string;
  parsedCommand: ParsedCommand;
  fingerprint: string;
}

interface JsonAutoCall {
  id?: string;
  command?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export function parseAutoToolCallFromBlock(rawBlockText: string): AutoToolCall | null {
  const normalized = normalizeBlockText(rawBlockText);
  if (!normalized) {
    return null;
  }

  const withFenceStripped = stripMarkdownFence(normalized);
  const lines = withFenceStripped.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  let callId: string | undefined;
  let payload = withFenceStripped;

  if (/^\[?flycode-call\]?$/i.test(lines[0])) {
    payload = withFenceStripped.slice(withFenceStripped.indexOf(lines[0]) + lines[0].length).trim();
    const nextLines = payload.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (nextLines.length === 0) {
      return null;
    }

    if (nextLines[0].startsWith("id:")) {
      callId = nextLines[0].slice(3).trim();
      payload = payload.slice(payload.indexOf(nextLines[0]) + nextLines[0].length).trim();
    }
  } else if (/^(json|javascript|js)$/i.test(lines[0]) && lines[1]?.startsWith("{")) {
    payload = lines.slice(1).join("\n");
  }

  const slashCommand = extractSlashCommand(payload);
  if (slashCommand) {
    const normalizedCallId = normalizeId(callId);
    if (!normalizedCallId) {
      return null;
    }

    const parsed = safeParseCommand(slashCommand);
    if (!parsed) {
      return null;
    }
    const normalizedCommand = normalizeCommandForHash(slashCommand);

    return {
      callId: normalizedCallId,
      rawCommand: slashCommand,
      commandHash: hashText(normalizedCommand),
      parsedCommand: parsed,
      fingerprint: `sig:${hashText(`${normalizedCallId}|${slashCommand}`)}`
    };
  }

  const jsonCall = parseJsonCall(payload);
  if (!jsonCall) {
    return null;
  }

  if (!jsonCall.callId) {
    return null;
  }

  const parsed = jsonCall.parsedCommand ?? safeParseCommand(jsonCall.rawCommand);
  if (!parsed) {
    return null;
  }
  const normalizedCommand = normalizeCommandForHash(jsonCall.rawCommand);

  return {
    callId: jsonCall.callId,
    rawCommand: jsonCall.rawCommand,
    commandHash: hashText(normalizedCommand),
    parsedCommand: parsed,
    fingerprint: `sig:${hashText(`${jsonCall.callId ?? ""}|${jsonCall.rawCommand}`)}`
  };
}

function normalizeBlockText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .trim();
}

function stripMarkdownFence(text: string): string {
  const fenceMatch = text.match(/^```([^\n`]*)\n([\s\S]*?)\n```$/);
  if (!fenceMatch) {
    return text;
  }

  const language = fenceMatch[1].trim();
  const body = fenceMatch[2].trim();

  if (!language) {
    return body;
  }

  if (/^flycode-call$/i.test(language)) {
    return `flycode-call\n${body}`;
  }

  return `${language}\n${body}`;
}

function extractSlashCommand(payload: string): string | null {
  const trimmed = payload.trim();
  if (
    !trimmed.startsWith("/fs.") &&
    !trimmed.startsWith("/process.run") &&
    !trimmed.startsWith("/shell.exec")
  ) {
    return null;
  }

  const parsedFull = safeParseCommand(trimmed);
  if (parsedFull) {
    return trimmed;
  }

  const firstLine = trimmed.split("\n")[0]?.trim();
  if (!firstLine) {
    return null;
  }

  const parsedFirstLine = safeParseCommand(firstLine);
  if (parsedFirstLine) {
    return firstLine;
  }

  const writeMultiLineMatch = trimmed.match(
    /(^\/fs\.write[\s\S]*?--content\s+"""[\s\S]*?"""(?:\s+--expectedSha256\s+\S+)?)$/m
  );
  if (!writeMultiLineMatch) {
    return null;
  }

  const writeCommand = writeMultiLineMatch[1].trim();
  return safeParseCommand(writeCommand) ? writeCommand : null;
}

function parseJsonCall(payload: string): { callId?: string; rawCommand: string; parsedCommand?: ParsedCommand } | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  let parsed: JsonAutoCall;
  try {
    parsed = JSON.parse(trimmed) as JsonAutoCall;
  } catch {
    return null;
  }

  if (
    typeof parsed.command === "string" &&
    (
      parsed.command.trim().startsWith("/fs.") ||
      parsed.command.trim().startsWith("/process.run") ||
      parsed.command.trim().startsWith("/shell.exec")
    )
  ) {
    return {
      callId: normalizeId(parsed.id),
      rawCommand: parsed.command.trim()
    };
  }

  if (typeof parsed.tool !== "string") {
    return null;
  }

  if (parsed.tool === "fs.writeBatch") {
    const files = extractWriteBatchFiles(parsed.args ?? {});
    if (!files) {
      return null;
    }

    return {
      callId: normalizeId(parsed.id),
      rawCommand: `/fs.writeBatch ${files.length} files`,
      parsedCommand: {
        command: "fs.writeBatch",
        files,
        raw: `/fs.writeBatch ${files.length} files`
      }
    };
  }

  const fromTool = convertToolCallToSlash(parsed.tool, parsed.args ?? {});
  if (!fromTool) {
    return null;
  }

  return {
    callId: normalizeId(parsed.id),
    rawCommand: fromTool
  };
}

function convertToolCallToSlash(tool: string, args: Record<string, unknown>): string | null {
  const normalizePath = () => {
    const path = args.path;
    return typeof path === "string" ? quotePath(path) : null;
  };

  if (tool === "fs.ls") {
    const path = normalizePath();
    if (!path) return null;
    const depth = typeof args.depth === "number" ? ` --depth ${Math.floor(args.depth)}` : "";
    const glob = typeof args.glob === "string" ? ` --glob ${quoteArg(args.glob)}` : "";
    return `/fs.ls ${path}${depth}${glob}`;
  }

  if (tool === "fs.mkdir") {
    const path = normalizePath();
    if (!path) return null;
    const parents = args.parents === true ? " --parents" : "";
    return `/fs.mkdir ${path}${parents}`;
  }

  if (tool === "fs.read") {
    const path = normalizePath();
    if (!path) return null;
    let selector = "";
    if (typeof args.head === "number") {
      selector = ` --head ${Math.floor(args.head)}`;
    } else if (typeof args.tail === "number") {
      selector = ` --tail ${Math.floor(args.tail)}`;
    } else if (typeof args.range === "string") {
      selector = ` --range ${quoteArg(args.range)}`;
    } else if (typeof args.line === "number") {
      selector = ` --line ${Math.floor(args.line)}`;
    } else if (typeof args.lines === "string") {
      selector = ` --lines ${quoteArg(args.lines)}`;
    }

    const encoding =
      args.encoding === "base64" || args.encoding === "hex" || args.encoding === "utf-8"
        ? ` --encoding ${args.encoding}`
        : "";
    const includeMeta = args.includeMeta === false ? " --no-meta" : args.includeMeta === true ? " --include-meta" : "";

    return `/fs.read ${path}${selector}${encoding}${includeMeta}`;
  }

  if (tool === "fs.search") {
    const path = normalizePath();
    const query = typeof args.query === "string" ? args.query : null;
    if (!path || !query) return null;

    const regex = args.regex === true ? " --regex" : "";
    const glob = typeof args.glob === "string" ? ` --glob ${quoteArg(args.glob)}` : "";
    const limit = typeof args.limit === "number" ? ` --limit ${Math.floor(args.limit)}` : "";
    const extensions = Array.isArray(args.extensions)
      ? args.extensions.filter((item) => typeof item === "string").map((item) => ` --ext ${quoteArg(String(item))}`).join("")
      : "";
    const minBytes = typeof args.minBytes === "number" ? ` --min-bytes ${Math.floor(args.minBytes)}` : "";
    const maxBytes = typeof args.maxBytes === "number" ? ` --max-bytes ${Math.floor(args.maxBytes)}` : "";
    const mtimeFrom = typeof args.mtimeFrom === "string" ? ` --mtime-from ${quoteArg(args.mtimeFrom)}` : "";
    const mtimeTo = typeof args.mtimeTo === "string" ? ` --mtime-to ${quoteArg(args.mtimeTo)}` : "";
    const context = typeof args.contextLines === "number" ? ` --context ${Math.floor(args.contextLines)}` : "";

    return `/fs.search ${path} --query ${quoteArg(query)}${regex}${glob}${limit}${extensions}${minBytes}${maxBytes}${mtimeFrom}${mtimeTo}${context}`;
  }

  if (tool === "fs.write") {
    const path = normalizePath();
    const content = typeof args.content === "string" ? args.content : null;
    if (!path || content === null) return null;

    const mode = args.mode === "append" ? "append" : "overwrite";
    const expectedSha = typeof args.expectedSha256 === "string" ? ` --expectedSha256 ${args.expectedSha256}` : "";
    return `/fs.write ${path} --mode ${mode} --content """${content}"""${expectedSha}`;
  }

  if (tool === "fs.rm") {
    const path = normalizePath();
    if (!path) return null;
    const recursive = args.recursive === true ? " --recursive" : "";
    const force = args.force === true ? " --force" : "";
    return `/fs.rm ${path}${recursive}${force}`;
  }

  if (tool === "fs.mv") {
    const fromPath = typeof args.fromPath === "string" ? quotePath(args.fromPath) : null;
    const toPath = typeof args.toPath === "string" ? quotePath(args.toPath) : null;
    if (!fromPath || !toPath) return null;
    const overwrite = args.overwrite === true ? " --overwrite" : "";
    return `/fs.mv ${fromPath} ${toPath}${overwrite}`;
  }

  if (tool === "fs.chmod") {
    const path = normalizePath();
    const mode = typeof args.mode === "string" ? args.mode : null;
    if (!path || !mode) return null;
    return `/fs.chmod ${path} --mode ${mode}`;
  }

  if (tool === "fs.diff") {
    const leftPath = typeof args.leftPath === "string" ? quotePath(args.leftPath) : null;
    if (!leftPath) return null;
    const rightPath = typeof args.rightPath === "string" ? ` --right-path ${quotePath(args.rightPath)}` : "";
    const rightContent =
      typeof args.rightContent === "string" ? ` --right-content """${args.rightContent}"""` : "";
    if (!rightPath && !rightContent) return null;
    const context = typeof args.contextLines === "number" ? ` --context ${Math.floor(args.contextLines)}` : "";
    return `/fs.diff ${leftPath}${rightPath}${rightContent}${context}`;
  }

  if (tool === "process.run") {
    const commandName = typeof args.command === "string" ? quotePath(args.command) : null;
    if (!commandName) return null;
    const cmdArgs = Array.isArray(args.args)
      ? args.args
          .filter((item) => typeof item === "string")
          .map((item) => ` --arg ${quoteArg(String(item))}`)
          .join("")
      : "";
    const cwd = typeof args.cwd === "string" ? ` --cwd ${quotePath(args.cwd)}` : "";
    const timeout = typeof args.timeoutMs === "number" ? ` --timeout-ms ${Math.floor(args.timeoutMs)}` : "";
    const env = isRecord(args.env)
      ? Object.entries(args.env)
          .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
          .map(([key, value]) => ` --env ${quoteArg(`${key}=${value}`)}`)
          .join("")
      : "";
    return `/process.run ${commandName}${cmdArgs}${cwd}${timeout}${env}`;
  }

  if (tool === "shell.exec") {
    const commandText = typeof args.command === "string" ? args.command : null;
    if (!commandText) return null;
    const cwd = typeof args.cwd === "string" ? ` --cwd ${quotePath(args.cwd)}` : "";
    const timeout = typeof args.timeoutMs === "number" ? ` --timeout-ms ${Math.floor(args.timeoutMs)}` : "";
    const env = isRecord(args.env)
      ? Object.entries(args.env)
          .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
          .map(([key, value]) => ` --env ${quoteArg(`${key}=${value}`)}`)
          .join("")
      : "";
    return `/shell.exec --command ${quoteArg(commandText)}${cwd}${timeout}${env}`;
  }

  return null;
}

function quotePath(pathValue: string): string {
  return /\s/.test(pathValue) ? quoteArg(pathValue) : pathValue;
}

function quoteArg(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractWriteBatchFiles(args: Record<string, unknown>): Array<{
  path: string;
  mode?: "overwrite" | "append";
  content: string;
  expectedSha256?: string;
}> | null {
  if (!Array.isArray(args.files)) {
    return null;
  }

  const files: Array<{
    path: string;
    mode?: "overwrite" | "append";
    content: string;
    expectedSha256?: string;
  }> = [];

  for (const item of args.files) {
    if (!isRecord(item)) {
      return null;
    }

    const pathValue = item.path;
    const contentValue = item.content;
    if (typeof pathValue !== "string" || typeof contentValue !== "string") {
      return null;
    }

    const mode = item.mode === "append" ? "append" : item.mode === "overwrite" ? "overwrite" : undefined;
    const expectedSha256 = typeof item.expectedSha256 === "string" ? item.expectedSha256 : undefined;
    files.push({
      path: pathValue,
      mode,
      content: contentValue,
      expectedSha256
    });
  }

  return files.length > 0 ? files : null;
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function safeParseCommand(candidate: string): ParsedCommand | null {
  try {
    return parseCommand(candidate);
  } catch {
    return null;
  }
}

function normalizeCommandForHash(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return (hash >>> 0).toString(16);
}
