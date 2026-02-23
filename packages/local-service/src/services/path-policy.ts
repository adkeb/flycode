/**
 * FlyCode Note: Path and site policy enforcement
 * Normalizes Linux and Windows paths, checks allowed roots and deny globs, and validates site allowlist.
 */
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { PathPolicy, PolicyConfig } from "../types.js";
import { AppError } from "../utils/errors.js";
import type { SiteId } from "@flycode/shared-types";

export class DefaultPathPolicy implements PathPolicy {
  private readonly normalizedRoots: string[];

  constructor(
    private readonly policy: PolicyConfig,
    private readonly runtimePlatform: NodeJS.Platform = process.platform
  ) {
    this.normalizedRoots = policy.allowed_roots.map((root) => this.resolvePath(this.normalizeInputPath(root)));
  }

  normalizeInputPath(inputPath: string): string {
    const raw = inputPath.trim();
    const unquoted = stripQuotes(raw);

    if (!unquoted) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Path cannot be empty"
      });
    }

    if (unquoted.startsWith("~/")) {
      const joined = this.pathApi.join(os.homedir(), unquoted.slice(2));
      return this.resolvePath(joined);
    }

    if (this.runtimePlatform === "win32") {
      const mntMatch = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(unquoted);
      if (mntMatch) {
        const drive = mntMatch[1].toUpperCase();
        const rest = (mntMatch[2] ?? "").replaceAll("/", "\\");
        const winPath = rest ? `${drive}:\\${rest}` : `${drive}:\\`;
        return path.win32.normalize(winPath);
      }

      return path.win32.resolve(unquoted);
    }

    const winMatch = /^([a-zA-Z]):[\\/](.*)$/.exec(unquoted);
    if (winMatch) {
      const drive = winMatch[1].toLowerCase();
      const rest = winMatch[2].replaceAll("\\", "/");
      return path.posix.normalize(`/mnt/${drive}/${rest}`);
    }

    return path.posix.resolve(unquoted);
  }

  assertAllowed(inputPath: string): void {
    const target = this.resolvePath(this.normalizeInputPath(inputPath));
    const matchingRoots = this.normalizedRoots.filter((root) => this.isInside(target, root));

    if (matchingRoots.length === 0) {
      throw new AppError({
        statusCode: 403,
        code: "POLICY_BLOCKED",
        message: `Path is outside allowed roots: ${target}`
      });
    }

    for (const root of matchingRoots) {
      const relative = this.relativePath(root, target).split(this.pathApi.sep).join("/");
      const blocked = this.policy.deny_globs.some((pattern) => minimatch(relative, pattern, { dot: true }));
      if (blocked) {
        throw new AppError({
          statusCode: 403,
          code: "POLICY_BLOCKED",
          message: `Path matches deny pattern: ${relative}`
        });
      }
    }
  }

  assertSiteAllowed(site: SiteId): void {
    const normalized = site.toLowerCase();
    const ok = this.policy.site_allowlist.some((candidate) => candidate.toLowerCase() === normalized);

    if (!ok) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: `Site is not allowed: ${site}`
      });
    }
  }

  private get pathApi(): typeof path.win32 | typeof path.posix {
    return this.runtimePlatform === "win32" ? path.win32 : path.posix;
  }

  private resolvePath(value: string): string {
    return this.pathApi.resolve(value);
  }

  private relativePath(from: string, to: string): string {
    return this.pathApi.relative(from, to);
  }

  private isInside(target: string, root: string): boolean {
    const relative = this.relativePath(root, target);
    return relative === "" || (!relative.startsWith("..") && !this.pathApi.isAbsolute(relative));
  }
}

function stripQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}
