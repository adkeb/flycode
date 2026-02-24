/**
 * FlyCode Note: Console timeline logger
 * Persists request/response summaries into ~/.flycode/console/YYYY-MM-DD.jsonl and supports filtered reads.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ConsoleClearRequest, ConsoleClearResult, ConsoleEventEntry, ConsoleQueryRequest } from "@flycode/shared-types";
import { getFlycodeHomeDir } from "../config/policy.js";
import type { ConsoleEventLogger } from "../types.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

export class FileConsoleEventLogger implements ConsoleEventLogger {
  async log(entry: ConsoleEventEntry): Promise<void> {
    const day = entry.timestamp.slice(0, 10);
    const dir = path.join(getFlycodeHomeDir(), "console");
    const filePath = path.join(dir, `${day}.jsonl`);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async listRecent(input?: {
    site?: ConsoleEventEntry["site"] | "all";
    status?: ConsoleEventEntry["status"] | "all";
    tool?: string;
    keyword?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<ConsoleEventEntry[]> {
    const dir = path.join(getFlycodeHomeDir(), "console");
    let files: string[] = [];

    try {
      files = (await fs.readdir(dir))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const limit = clampLimit(input?.limit ?? DEFAULT_LIMIT);
    const matcher = buildMatcher(input);

    const out: ConsoleEventEntry[] = [];
    for (const file of files.reverse()) {
      const fullPath = path.join(dir, file);
      const raw = await fs.readFile(fullPath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        const parsed = safeParseJson(line);
        if (!parsed) {
          continue;
        }

        if (!matcher(parsed)) continue;

        out.push(parsed);
        if (out.length >= limit) {
          return out;
        }
      }
    }

    return out;
  }

  async cleanupExpired(retentionDays: number): Promise<void> {
    const dir = path.join(getFlycodeHomeDir(), "console");
    const days = Math.max(1, Math.min(365, Math.floor(retentionDays)));
    const deadline = Date.now() - days * 24 * 60 * 60 * 1000;

    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const file of files) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) {
        continue;
      }
      const day = file.slice(0, 10);
      const dayMs = Date.parse(`${day}T00:00:00.000Z`);
      if (!Number.isFinite(dayMs) || dayMs >= deadline) {
        continue;
      }
      await fs.rm(path.join(dir, file), { force: true });
    }
  }

  async exportRecent(input?: ConsoleQueryRequest): Promise<ConsoleEventEntry[]> {
    return this.listRecent(input);
  }

  async clear(input: ConsoleClearRequest): Promise<ConsoleClearResult> {
    const dir = path.join(getFlycodeHomeDir(), "console");
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { deleted: 0 };
      }
      throw error;
    }

    if (input.mode === "all") {
      let deleted = 0;
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const raw = await fs.readFile(fullPath, "utf8");
        deleted += raw.split(/\r?\n/).filter(Boolean).length;
        await fs.rm(fullPath, { force: true });
      }
      return { deleted };
    }

    const matcher = buildMatcher(input.filters ?? {});
    let deleted = 0;

    for (const file of files) {
      const fullPath = path.join(dir, file);
      const raw = await fs.readFile(fullPath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const kept: string[] = [];

      for (const line of lines) {
        const parsed = safeParseJson(line);
        if (!parsed) {
          kept.push(line);
          continue;
        }
        if (matcher(parsed)) {
          deleted += 1;
          continue;
        }
        kept.push(line);
      }

      if (kept.length === 0) {
        await fs.rm(fullPath, { force: true });
      } else {
        await fs.writeFile(fullPath, `${kept.join("\n")}\n`, "utf8");
      }
    }

    return { deleted };
  }
}

function safeParseJson(line: string): ConsoleEventEntry | null {
  try {
    const parsed = JSON.parse(line) as ConsoleEventEntry;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.timestamp !== "string" ||
      typeof parsed.site !== "string" ||
      typeof parsed.method !== "string" ||
      typeof parsed.status !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function buildMatcher(input?: ConsoleQueryRequest): (entry: ConsoleEventEntry) => boolean {
  const fromTs = input?.from ? Date.parse(input.from) : Number.NEGATIVE_INFINITY;
  const toTs = input?.to ? Date.parse(input.to) : Number.POSITIVE_INFINITY;
  const keyword = input?.keyword?.toLowerCase();
  const site = input?.site;
  const status = input?.status;
  const tool = input?.tool;

  return (entry: ConsoleEventEntry) => {
    const ts = Date.parse(entry.timestamp);
    if (Number.isFinite(fromTs) && ts < fromTs) return false;
    if (Number.isFinite(toTs) && ts > toTs) return false;
    if (site && site !== "all" && entry.site !== site) return false;
    if (status && status !== "all" && entry.status !== status) return false;
    if (tool && entry.tool !== tool) return false;
    if (keyword) {
      const haystack = JSON.stringify(entry).toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  };
}
