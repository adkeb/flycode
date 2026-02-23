/**
 * FlyCode Note: Core file operations
 * Implements ls/mkdir/read/search/write/rm/mv/chmod/diff with policy checks, redaction, and token budgeting.
 */
import fs from "node:fs/promises";
import path from "node:path";
import mime from "mime-types";
import { minimatch } from "minimatch";
import pdfParse from "pdf-parse";
import type { ReadEncoding, WriteMode } from "@flycode/shared-types";
import type { FileService, PathPolicy, PendingWriteOp, PolicyConfig, Redactor } from "../types.js";
import { AppError } from "../utils/errors.js";
import { sha256 } from "../utils/hash.js";
import { applyTokenBudget } from "./token-budget.js";

interface LsInternalResult {
  entries: Array<{ path: string; type: "file" | "directory"; bytes?: number }>;
  truncated: boolean;
}

interface ReadInternalResult {
  content: string;
  mime: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
  meta?: {
    size: number;
    mtime: string;
    ctime: string;
    mode: string;
  };
}

interface DiffOp {
  kind: "equal" | "add" | "remove";
  line: string;
  aLine: number;
  bLine: number;
}

export class DefaultFileService implements FileService {
  constructor(
    private readonly policy: PolicyConfig,
    private readonly pathPolicy: PathPolicy,
    private readonly redactor: Redactor
  ) {}

  async ls(inputPath: string, depth: number | undefined, glob: string | undefined): Promise<LsInternalResult> {
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    const stat = await safeStat(target);
    if (!stat) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Path not found: ${target}`
      });
    }

    if (stat.isFile()) {
      return {
        entries: [{ path: target, type: "file", bytes: stat.size }],
        truncated: false
      };
    }

    const maxDepth = Math.max(0, depth ?? 2);
    const entries: Array<{ path: string; type: "file" | "directory"; bytes?: number }> = [];
    await walkDir({
      root: target,
      current: target,
      depth: 0,
      maxDepth,
      includePattern: glob,
      onEntry: (entry) => entries.push(entry)
    });

    const filtered = entries.filter((entry) => isAllowedPath(this.pathPolicy, entry.path));
    filtered.sort((a, b) => a.path.localeCompare(b.path));
    return { entries: filtered, truncated: false };
  }

  async mkdir(inputPath: string, parents: boolean | undefined): Promise<{ path: string; created: boolean; parents: boolean }> {
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    const existing = await safeStat(target);
    if (existing) {
      if (!existing.isDirectory()) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `Path already exists and is not a directory: ${target}`
        });
      }

      return {
        path: target,
        created: false,
        parents: parents === true
      };
    }

    const recursive = parents === true;
    const parentDir = path.dirname(target);
    this.pathPolicy.assertAllowed(parentDir);

    if (!recursive) {
      const parentStat = await safeStat(parentDir);
      if (!parentStat?.isDirectory()) {
        throw new AppError({
          statusCode: 404,
          code: "NOT_FOUND",
          message: `Parent directory does not exist: ${parentDir}`
        });
      }
    }

    await fs.mkdir(target, { recursive });

    const created = await safeStat(target);
    if (!created?.isDirectory()) {
      throw new AppError({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: `Failed to create directory: ${target}`
      });
    }

    return {
      path: target,
      created: true,
      parents: recursive
    };
  }

  async rm(
    inputPath: string,
    options: { recursive?: boolean; force?: boolean }
  ): Promise<{ path: string; removed: boolean; type: "file" | "directory" | "missing"; recursive: boolean }> {
    this.assertMutationAllowed("allow_rm", "fs.rm is disabled by policy");

    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);
    this.assertNotRootTarget(target, "Cannot delete a root path in allowed_roots");

    const recursive = options.recursive === true;
    const force = options.force === true;
    const stat = await safeStat(target);

    if (!stat) {
      if (force) {
        return {
          path: target,
          removed: false,
          type: "missing",
          recursive
        };
      }

      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Path not found: ${target}`
      });
    }

    if (stat.isDirectory() && !recursive) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Directory deletion requires recursive=true"
      });
    }

    await fs.rm(target, { recursive: stat.isDirectory(), force });
    return {
      path: target,
      removed: true,
      type: stat.isDirectory() ? "directory" : "file",
      recursive
    };
  }

  async mv(
    fromPath: string,
    toPath: string,
    overwrite: boolean | undefined
  ): Promise<{ fromPath: string; toPath: string; overwritten: boolean }> {
    this.assertMutationAllowed("allow_mv", "fs.mv is disabled by policy");

    const from = this.pathPolicy.normalizeInputPath(fromPath);
    const to = this.pathPolicy.normalizeInputPath(toPath);
    this.pathPolicy.assertAllowed(from);
    this.pathPolicy.assertAllowed(to);
    this.assertNotRootTarget(from, "Cannot move a root path in allowed_roots");

    const sourceStat = await safeStat(from);
    if (!sourceStat) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Source path not found: ${from}`
      });
    }

    const destinationStat = await safeStat(to);
    let overwritten = false;

    if (destinationStat) {
      if (overwrite !== true) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `Destination already exists: ${to}`
        });
      }

      if (destinationStat.isDirectory()) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `Overwrite for directory destination is not supported: ${to}`
        });
      }

      await fs.rm(to, { force: true });
      overwritten = true;
    }

    await fs.mkdir(path.dirname(to), { recursive: true });

    try {
      await fs.rename(from, to);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
        throw error;
      }

      if (sourceStat.isDirectory()) {
        await fs.cp(from, to, { recursive: true });
        await fs.rm(from, { recursive: true, force: true });
      } else {
        await fs.copyFile(from, to);
        await fs.rm(from, { force: true });
      }
    }

    return {
      fromPath: from,
      toPath: to,
      overwritten
    };
  }

  async chmod(inputPath: string, mode: string): Promise<{ path: string; mode: string }> {
    this.assertMutationAllowed("allow_chmod", "fs.chmod is disabled by policy");

    if (process.platform === "win32") {
      throw new AppError({
        statusCode: 501,
        code: "NOT_SUPPORTED",
        message: "fs.chmod is not supported on Windows runtime"
      });
    }

    if (!/^[0-7]{3,4}$/.test(mode)) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: `Invalid chmod mode: ${mode}`
      });
    }

    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    const stat = await safeStat(target);
    if (!stat) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Path not found: ${target}`
      });
    }

    const modeValue = parseInt(mode, 8);
    await fs.chmod(target, modeValue);

    return {
      path: target,
      mode: mode.length === 3 ? `0${mode}` : mode
    };
  }

  async read(
    inputPath: string,
    options: {
      range?: string;
      line?: number;
      lines?: string;
      encoding?: ReadEncoding;
      includeMeta?: boolean;
    }
  ): Promise<ReadInternalResult> {
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    const stat = await safeStat(target);
    if (!stat) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `File not found: ${target}`
      });
    }

    if (!stat.isFile()) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: `Path is not a file: ${target}`
      });
    }

    if (stat.size > this.policy.limits.max_file_bytes) {
      throw new AppError({
        statusCode: 413,
        code: "LIMIT_EXCEEDED",
        message: `File exceeds max_file_bytes (${this.policy.limits.max_file_bytes})`
      });
    }

    const selectionCount = [options.range, options.line, options.lines].filter((item) => item !== undefined).length;
    if (selectionCount > 1) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Only one of range, line, lines can be used"
      });
    }

    const encoding = options.encoding ?? "utf-8";
    if (!["utf-8", "base64", "hex"].includes(encoding)) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: `Unsupported encoding: ${encoding}`
      });
    }

    const buffer = await fs.readFile(target);
    const fileHash = sha256(buffer);
    const mimeType = mime.lookup(target) || "text/plain";

    let content: string;
    if (encoding === "base64" || encoding === "hex") {
      if (options.line !== undefined || options.lines !== undefined) {
        throw new AppError({
          statusCode: 422,
          code: "INVALID_INPUT",
          message: "line/lines selection requires utf-8 encoding"
        });
      }
      content = buffer.toString(encoding);
    } else if (target.toLowerCase().endsWith(".pdf")) {
      try {
        const parsed = await pdfParse(buffer);
        content = parsed.text || "";
      } catch {
        throw new AppError({
          statusCode: 422,
          code: "INVALID_INPUT",
          message: `Failed to parse PDF file: ${target}`
        });
      }
    } else {
      content = buffer.toString("utf8");
    }

    const selected = selectReadContent(content, {
      range: options.range,
      line: options.line,
      lines: options.lines
    });

    const redacted = this.redactor.redact(selected);
    const budgeted = applyTokenBudget(redacted.content, this.policy.limits.max_inject_tokens);

    return {
      content: budgeted.content,
      mime: String(mimeType),
      bytes: stat.size,
      sha256: fileHash,
      truncated: budgeted.truncated,
      meta:
        options.includeMeta === false
          ? undefined
          : {
              size: stat.size,
              mtime: stat.mtime.toISOString(),
              ctime: stat.ctime.toISOString(),
              mode: formatFileMode(stat.mode)
            }
    };
  }

  async search(
    inputPath: string,
    options: {
      query: string;
      regex?: boolean;
      glob?: string;
      limit?: number;
      extensions?: string[];
      minBytes?: number;
      maxBytes?: number;
      mtimeFrom?: string;
      mtimeTo?: string;
      contextLines?: number;
    }
  ): Promise<{
    matches: Array<{
      path: string;
      line: number;
      column: number;
      text: string;
      before?: Array<{ line: number; text: string }>;
      after?: Array<{ line: number; text: string }>;
    }>;
    total: number;
    truncated: boolean;
  }> {
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    const stat = await safeStat(target);
    if (!stat) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Path not found: ${target}`
      });
    }

    const maxMatches = Math.min(options.limit ?? this.policy.limits.max_search_matches, this.policy.limits.max_search_matches);
    const contextLines = clamp(options.contextLines ?? 0, 0, 5);
    const files: string[] = [];
    const extensionSet = normalizeExtensions(options.extensions);
    const mtimeFrom = parseIsoDate(options.mtimeFrom, "mtimeFrom");
    const mtimeTo = parseIsoDate(options.mtimeTo, "mtimeTo");
    const minBytes = normalizeNonNegative(options.minBytes, "minBytes");
    const maxBytes = normalizeNonNegative(options.maxBytes, "maxBytes");

    if (minBytes !== undefined && maxBytes !== undefined && minBytes > maxBytes) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "minBytes cannot be greater than maxBytes"
      });
    }

    if (stat.isFile()) {
      files.push(target);
    } else {
      await collectFiles(target, target, options.glob, files);
    }

    const matcher = options.regex ? compileRegex(options.query) : null;

    const matches: Array<{
      path: string;
      line: number;
      column: number;
      text: string;
      before?: Array<{ line: number; text: string }>;
      after?: Array<{ line: number; text: string }>;
    }> = [];
    let total = 0;
    let truncated = false;

    for (const filePath of files) {
      if (!isAllowedPath(this.pathPolicy, filePath)) {
        continue;
      }

      const fileStat = await safeStat(filePath);
      if (!fileStat || !fileStat.isFile()) {
        continue;
      }

      if (fileStat.size > this.policy.limits.max_file_bytes) {
        continue;
      }
      if (minBytes !== undefined && fileStat.size < minBytes) {
        continue;
      }
      if (maxBytes !== undefined && fileStat.size > maxBytes) {
        continue;
      }
      if (mtimeFrom && fileStat.mtime.getTime() < mtimeFrom.getTime()) {
        continue;
      }
      if (mtimeTo && fileStat.mtime.getTime() > mtimeTo.getTime()) {
        continue;
      }
      if (extensionSet && !extensionSet.has(path.extname(filePath).toLowerCase())) {
        continue;
      }

      const raw = await fs.readFile(filePath, "utf8");
      const lines = raw.split(/\r?\n/);

      for (let i = 0; i < lines.length; i += 1) {
        const lineText = lines[i];
        const match = findMatch(lineText, options.query, matcher);
        if (match === null) {
          continue;
        }

        total += 1;
        if (matches.length < maxMatches) {
          const entry: {
            path: string;
            line: number;
            column: number;
            text: string;
            before?: Array<{ line: number; text: string }>;
            after?: Array<{ line: number; text: string }>;
          } = {
            path: filePath,
            line: i + 1,
            column: match + 1,
            text: this.redactor.redact(lineText).content
          };

          if (contextLines > 0) {
            const before = collectContext(lines, Math.max(0, i - contextLines), i - 1, this.redactor);
            const after = collectContext(lines, i + 1, Math.min(lines.length - 1, i + contextLines), this.redactor);
            if (before.length > 0) {
              entry.before = before;
            }
            if (after.length > 0) {
              entry.after = after;
            }
          }

          matches.push(entry);
        } else {
          truncated = true;
        }
      }

      if (truncated) {
        break;
      }
    }

    return {
      matches,
      total,
      truncated
    };
  }

  async diff(input: {
    leftPath: string;
    rightPath?: string;
    rightContent?: string;
    contextLines?: number;
  }): Promise<{ leftPath: string; rightPath?: string; changed: boolean; unifiedDiff: string; truncated: boolean }> {
    const leftPath = this.pathPolicy.normalizeInputPath(input.leftPath);
    this.pathPolicy.assertAllowed(leftPath);

    const rightPath = input.rightPath ? this.pathPolicy.normalizeInputPath(input.rightPath) : undefined;
    const rightContent = input.rightContent;

    if ((rightPath && rightContent !== undefined) || (!rightPath && rightContent === undefined)) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Provide either rightPath or rightContent"
      });
    }

    if (rightPath) {
      this.pathPolicy.assertAllowed(rightPath);
    }

    const leftText = await readTextForDiff(leftPath, this.policy.limits.max_file_bytes);
    const rightText = rightPath
      ? await readTextForDiff(rightPath, this.policy.limits.max_file_bytes)
      : String(rightContent ?? "");

    const contextLines = clamp(input.contextLines ?? 3, 0, 20);
    const unified = createUnifiedDiff({
      leftLabel: leftPath,
      rightLabel: rightPath ?? "(inline)",
      leftText,
      rightText,
      contextLines
    });

    const redacted = this.redactor.redact(unified).content;
    const budgeted = applyTokenBudget(redacted, this.policy.limits.max_inject_tokens);

    return {
      leftPath,
      rightPath,
      changed: leftText !== rightText,
      unifiedDiff: budgeted.content,
      truncated: budgeted.truncated
    };
  }

  async commitWrite(op: PendingWriteOp): Promise<{ path: string; writtenBytes: number; backupPath?: string; newSha256: string }> {
    const target = this.pathPolicy.normalizeInputPath(op.path);
    this.pathPolicy.assertAllowed(target);

    await fs.mkdir(path.dirname(target), { recursive: true });

    let backupPath: string | undefined;
    const existing = await safeStat(target);
    if (op.mode === "overwrite" && existing?.isFile() && this.policy.write.backup_on_overwrite) {
      backupPath = `${target}.flycode.bak.${Date.now()}`;
      await fs.copyFile(target, backupPath);
    }

    if (op.mode === "append") {
      await fs.appendFile(target, op.content, "utf8");
    } else {
      await fs.writeFile(target, op.content, "utf8");
    }

    const finalBuffer = await fs.readFile(target);

    return {
      path: target,
      writtenBytes: Buffer.byteLength(op.content),
      backupPath,
      newSha256: sha256(finalBuffer)
    };
  }

  async existingSha256(inputPath: string): Promise<string | null> {
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    const stat = await safeStat(target);
    if (!stat?.isFile()) {
      return null;
    }

    const content = await fs.readFile(target);
    return sha256(content);
  }

  private assertMutationAllowed(flag: keyof PolicyConfig["mutation"], message: string): void {
    if (!this.policy.mutation[flag]) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message
      });
    }
  }

  private assertNotRootTarget(target: string, message: string): void {
    const targetKey = normalizeForPathCompare(target);
    const roots = this.policy.allowed_roots.map((root) => normalizeForPathCompare(this.pathPolicy.normalizeInputPath(root)));
    if (roots.includes(targetKey)) {
      throw new AppError({
        statusCode: 403,
        code: "POLICY_BLOCKED",
        message
      });
    }
  }
}

function isAllowedPath(pathPolicy: PathPolicy, candidatePath: string): boolean {
  try {
    pathPolicy.assertAllowed(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function selectReadContent(
  content: string,
  options: { range?: string; line?: number; lines?: string }
): string {
  if (options.line !== undefined) {
    const line = Math.floor(Number(options.line));
    if (!Number.isFinite(line) || line <= 0) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "line must be a positive integer"
      });
    }

    const lines = content.split(/\r?\n/);
    return lines[line - 1] ?? "";
  }

  if (options.lines !== undefined) {
    const match = /^(\d+)-(\d+)$/.exec(String(options.lines).trim());
    if (!match) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "lines must use format start-end"
      });
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start <= 0 || end <= 0 || start > end) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Invalid lines range"
      });
    }

    const lines = content.split(/\r?\n/);
    return lines.slice(start - 1, end).join("\n");
  }

  return applyRange(content, options.range);
}

function applyRange(content: string, range: string | undefined): string {
  if (!range) {
    return content;
  }

  const head = /^head:(\d+)$/i.exec(range);
  if (head) {
    const chars = Number(head[1]);
    return content.slice(0, chars);
  }

  const tail = /^tail:(\d+)$/i.exec(range);
  if (tail) {
    const chars = Number(tail[1]);
    return content.slice(Math.max(0, content.length - chars));
  }

  const pair = /^(\d+):(\d+)$/i.exec(range);
  if (pair) {
    const start = Number(pair[1]);
    const end = Number(pair[2]);
    return content.slice(start, end);
  }

  throw new AppError({
    statusCode: 422,
    code: "INVALID_INPUT",
    message: `Invalid range value: ${range}`
  });
}

async function walkDir(input: {
  root: string;
  current: string;
  depth: number;
  maxDepth: number;
  includePattern?: string;
  onEntry: (entry: { path: string; type: "file" | "directory"; bytes?: number }) => void;
}): Promise<void> {
  const { root, current, depth, maxDepth, includePattern, onEntry } = input;
  if (depth > maxDepth) {
    return;
  }

  const dirents = await fs.readdir(current, { withFileTypes: true });
  for (const dirent of dirents) {
    const fullPath = path.join(current, dirent.name);
    const relative = path.relative(root, fullPath).split(path.sep).join("/");

    if (includePattern && !minimatch(relative, includePattern, { dot: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }
    }

    if (dirent.isDirectory()) {
      onEntry({ path: fullPath, type: "directory" });
      await walkDir({
        root,
        current: fullPath,
        depth: depth + 1,
        maxDepth,
        includePattern,
        onEntry
      });
      continue;
    }

    const stat = await fs.stat(fullPath);
    onEntry({ path: fullPath, type: "file", bytes: stat.size });
  }
}

async function collectFiles(root: string, currentDir: string, glob: string | undefined, out: string[]): Promise<void> {
  const dirents = await fs.readdir(currentDir, { withFileTypes: true });
  for (const dirent of dirents) {
    const fullPath = path.join(currentDir, dirent.name);
    if (dirent.isDirectory()) {
      await collectFiles(root, fullPath, glob, out);
      continue;
    }

    if (glob) {
      const relative = path.relative(root, fullPath).split(path.sep).join("/");
      if (!minimatch(relative, glob, { dot: true })) {
        continue;
      }
    }

    out.push(fullPath);
  }
}

function compileRegex(query: string): RegExp {
  try {
    return new RegExp(query);
  } catch {
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: `Invalid regex query: ${query}`
    });
  }
}

function findMatch(lineText: string, query: string, matcher: RegExp | null): number | null {
  if (matcher) {
    const match = lineText.match(matcher);
    if (!match || match.index === undefined) {
      return null;
    }
    return match.index;
  }

  const idx = lineText.indexOf(query);
  return idx >= 0 ? idx : null;
}

function collectContext(
  lines: string[],
  start: number,
  end: number,
  redactor: Redactor
): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  for (let i = start; i <= end; i += 1) {
    if (i < 0 || i >= lines.length) {
      continue;
    }
    out.push({
      line: i + 1,
      text: redactor.redact(lines[i]).content
    });
  }
  return out;
}

function normalizeExtensions(input: string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined;
  }

  const normalized = input
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));

  return normalized.length > 0 ? new Set(normalized) : undefined;
}

function parseIsoDate(value: string | undefined, fieldName: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: `${fieldName} must be an ISO date`
    });
  }

  return parsed;
}

function normalizeNonNegative(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: `${fieldName} must be a non-negative number`
    });
  }

  return Math.floor(parsed);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const floor = Math.floor(value);
  return Math.min(Math.max(floor, min), max);
}

function formatFileMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function normalizeForPathCompare(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function readTextForDiff(target: string, maxBytes: number): Promise<string> {
  const stat = await safeStat(target);
  if (!stat || !stat.isFile()) {
    throw new AppError({
      statusCode: 404,
      code: "NOT_FOUND",
      message: `Diff source is not a file: ${target}`
    });
  }

  if (stat.size > maxBytes) {
    throw new AppError({
      statusCode: 413,
      code: "LIMIT_EXCEEDED",
      message: `Diff source exceeds max_file_bytes (${maxBytes})`
    });
  }

  return fs.readFile(target, "utf8");
}

function createUnifiedDiff(input: {
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
  contextLines: number;
}): string {
  const leftLines = splitLines(input.leftText);
  const rightLines = splitLines(input.rightText);

  if (leftLines.length > 4000 || rightLines.length > 4000) {
    throw new AppError({
      statusCode: 413,
      code: "LIMIT_EXCEEDED",
      message: "Diff line count exceeds safe limit (4000 lines)"
    });
  }

  const ops = diffLines(leftLines, rightLines);
  const changed = ops.some((op) => op.kind !== "equal");
  const header = [`--- ${input.leftLabel}`, `+++ ${input.rightLabel}`];

  if (!changed) {
    return header.join("\n");
  }

  const changedIndexes = ops
    .map((op, index) => ({ op, index }))
    .filter((item) => item.op.kind !== "equal")
    .map((item) => item.index);

  const segments: Array<{ start: number; end: number }> = [];
  let currentStart = Math.max(0, changedIndexes[0] - input.contextLines);
  let currentEnd = Math.min(ops.length - 1, changedIndexes[0] + input.contextLines);

  for (let i = 1; i < changedIndexes.length; i += 1) {
    const idx = changedIndexes[i];
    const nextStart = Math.max(0, idx - input.contextLines);
    const nextEnd = Math.min(ops.length - 1, idx + input.contextLines);

    if (nextStart <= currentEnd + 1) {
      currentEnd = Math.max(currentEnd, nextEnd);
    } else {
      segments.push({ start: currentStart, end: currentEnd });
      currentStart = nextStart;
      currentEnd = nextEnd;
    }
  }
  segments.push({ start: currentStart, end: currentEnd });

  const hunks: string[] = [];
  for (const segment of segments) {
    const segmentOps = ops.slice(segment.start, segment.end + 1);
    const startA = segmentOps[0]?.aLine ?? 1;
    const startB = segmentOps[0]?.bLine ?? 1;
    const countA = segmentOps.filter((op) => op.kind !== "add").length;
    const countB = segmentOps.filter((op) => op.kind !== "remove").length;
    hunks.push(`@@ -${startA},${countA} +${startB},${countB} @@`);

    for (const op of segmentOps) {
      if (op.kind === "equal") hunks.push(` ${op.line}`);
      if (op.kind === "remove") hunks.push(`-${op.line}`);
      if (op.kind === "add") hunks.push(`+${op.line}`);
    }
  }

  return [...header, ...hunks].join("\n");
}

function splitLines(input: string): string[] {
  if (input.length === 0) {
    return [];
  }
  return input.split(/\r?\n/);
}

function diffLines(leftLines: string[], rightLines: string[]): DiffOp[] {
  const n = leftLines.length;
  const m = rightLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        leftLines[i] === rightLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  let aLine = 1;
  let bLine = 1;

  while (i < n && j < m) {
    if (leftLines[i] === rightLines[j]) {
      ops.push({ kind: "equal", line: leftLines[i], aLine, bLine });
      i += 1;
      j += 1;
      aLine += 1;
      bLine += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "remove", line: leftLines[i], aLine, bLine });
      i += 1;
      aLine += 1;
    } else {
      ops.push({ kind: "add", line: rightLines[j], aLine, bLine });
      j += 1;
      bLine += 1;
    }
  }

  while (i < n) {
    ops.push({ kind: "remove", line: leftLines[i], aLine, bLine });
    i += 1;
    aLine += 1;
  }

  while (j < m) {
    ops.push({ kind: "add", line: rightLines[j], aLine, bLine });
    j += 1;
    bLine += 1;
  }

  return ops;
}
