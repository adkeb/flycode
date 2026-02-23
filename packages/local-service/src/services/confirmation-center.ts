/**
 * FlyCode Note: Confirmation center
 * Maintains pending high-risk tool approvals and "always allow" policy per site+tool.
 */
import { randomUUID } from "node:crypto";
import type { ConfirmationEntry, SiteId } from "@flycode/shared-types";
import type { AppConfigManager, ConfirmationDecision, ConfirmationManager } from "../types.js";
import { AppError } from "../utils/errors.js";

type KnownSiteId = Exclude<SiteId, "unknown">;

interface ConfirmationState extends ConfirmationEntry {
  traceId: string;
  request: unknown;
}

const DEFAULT_CONFIRMATION_TTL_MS = 120_000;

export class InMemoryConfirmationManager implements ConfirmationManager {
  private readonly entries = new Map<string, ConfirmationState>();
  private readonly order: string[] = [];

  constructor(
    private readonly appConfigManager: AppConfigManager,
    private readonly ttlMs: number = DEFAULT_CONFIRMATION_TTL_MS
  ) {}

  async createPending(input: {
    site: KnownSiteId;
    tool: string;
    summary: string;
    traceId: string;
    request: unknown;
  }): Promise<ConfirmationEntry> {
    this.cleanupExpired();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    const id = randomUUID();
    const entry: ConfirmationState = {
      id,
      site: input.site,
      tool: input.tool,
      summary: input.summary,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      traceId: input.traceId,
      request: input.request
    };

    this.entries.set(id, entry);
    this.order.push(id);
    this.trim(1000);
    return this.toPublicEntry(entry);
  }

  async getById(id: string): Promise<ConfirmationEntry | null> {
    this.cleanupExpired();
    const entry = this.entries.get(id);
    return entry ? this.toPublicEntry(entry) : null;
  }

  async resolve(id: string, input: ConfirmationDecision): Promise<ConfirmationEntry> {
    this.cleanupExpired();
    const entry = this.entries.get(id);
    if (!entry) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Confirmation not found: ${id}`
      });
    }

    if (entry.status !== "pending") {
      return this.toPublicEntry(entry);
    }

    const now = new Date().toISOString();
    entry.status = input.approved ? "approved" : "rejected";
    entry.resolvedAt = now;
    this.entries.set(id, entry);

    if (input.approved && input.alwaysAllow) {
      await this.appConfigManager.updateAlwaysAllow(entry.site, entry.tool, true);
    }

    return this.toPublicEntry(entry);
  }

  async shouldSkipConfirmation(site: KnownSiteId, tool: string): Promise<boolean> {
    const config = await this.appConfigManager.load();
    return config.alwaysAllow[`${site}:${tool}`] === true;
  }

  async listRecent(limit: number): Promise<ConfirmationEntry[]> {
    this.cleanupExpired();
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const ids = this.order.slice(-safeLimit).reverse();
    return ids
      .map((id) => this.entries.get(id))
      .filter((item): item is ConfirmationState => Boolean(item))
      .map((entry) => this.toPublicEntry(entry));
  }

  getRequestPayload(id: string): unknown | undefined {
    this.cleanupExpired();
    return this.entries.get(id)?.request;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries.entries()) {
      if (entry.status !== "pending") {
        continue;
      }

      if (Date.parse(entry.expiresAt) > now) {
        continue;
      }

      entry.status = "timeout";
      entry.resolvedAt = new Date().toISOString();
      this.entries.set(id, entry);
    }
  }

  private trim(maxEntries: number): void {
    while (this.order.length > maxEntries) {
      const id = this.order.shift();
      if (!id) {
        break;
      }
      this.entries.delete(id);
    }
  }

  private toPublicEntry(entry: ConfirmationState): ConfirmationEntry {
    return {
      id: entry.id,
      site: entry.site,
      tool: entry.tool,
      summary: entry.summary,
      status: entry.status,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      resolvedAt: entry.resolvedAt
    };
  }
}

