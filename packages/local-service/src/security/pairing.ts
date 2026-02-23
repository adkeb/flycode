import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { getFlycodeHomeDir } from "../config/policy.js";
import type { PairCodeManager, TokenManager } from "../types.js";

interface TokenRecord {
  token: string;
  expiresAt: string;
}

interface TokenStore {
  tokens: TokenRecord[];
}

export class InMemoryPairCodeManager implements PairCodeManager {
  private code: string;
  private expiry: Date;

  constructor(private readonly ttlMinutes: number) {
    this.code = "";
    this.expiry = new Date(0);
    this.issueCode();
  }

  issueCode(): string {
    const numeric = randomInt(0, 1_000_000).toString().padStart(6, "0");
    this.code = numeric;
    this.expiry = new Date(Date.now() + this.ttlMinutes * 60_000);
    return this.code;
  }

  getCurrentCode(): string {
    return this.code;
  }

  verify(code: string): boolean {
    if (Date.now() > this.expiry.getTime()) {
      return false;
    }

    const ok = this.code === code.trim();
    if (ok) {
      this.issueCode();
    }

    return ok;
  }

  getExpiry(): Date {
    return this.expiry;
  }
}

export class FileTokenManager implements TokenManager {
  private readonly storePath: string;

  constructor(private readonly ttlDays: number) {
    this.storePath = path.join(getFlycodeHomeDir(), "tokens.json");
  }

  async issueToken(): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + this.ttlDays * 24 * 60 * 60 * 1000);

    const store = await this.loadStore();
    store.tokens.push({ token, expiresAt: expiresAt.toISOString() });
    await this.saveStore(store);

    return { token, expiresAt };
  }

  async verifyToken(token: string): Promise<boolean> {
    if (!token) {
      return false;
    }

    const store = await this.loadStore();
    const now = Date.now();
    const filtered = store.tokens.filter((record) => Date.parse(record.expiresAt) > now);

    if (filtered.length !== store.tokens.length) {
      await this.saveStore({ tokens: filtered });
    }

    return filtered.some((record) => record.token === token);
  }

  private async loadStore(): Promise<TokenStore> {
    await fs.mkdir(getFlycodeHomeDir(), { recursive: true });

    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as TokenStore;
      return {
        tokens: Array.isArray(parsed.tokens) ? parsed.tokens : []
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      return { tokens: [] };
    }
  }

  private async saveStore(store: TokenStore): Promise<void> {
    await fs.writeFile(this.storePath, JSON.stringify(store, null, 2), "utf8");
  }
}
