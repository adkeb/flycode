/**
 * FlyCode Note: Per-site bridge key manager
 * Stores qwen/deepseek/gemini keys in ~/.flycode/site-keys.json with rotate and verify helpers.
 */
import { randomBytes } from "node:crypto";
import type { SiteId, SiteKeysResponse } from "@flycode/shared-types";
import {
  getSiteKeysPath,
  normalizeSiteKeys,
  readJsonFile,
  writeJsonFile
} from "../config/app-config.js";
import type { SiteKeyManager } from "../types.js";

type KnownSiteId = Exclude<SiteId, "unknown">;

const KEY_SIZE_BYTES = 24;

export class FileSiteKeyManager implements SiteKeyManager {
  async getSiteKeys(): Promise<SiteKeysResponse> {
    const raw = await readJsonFile(getSiteKeysPath(), {});
    return normalizeSiteKeys(raw);
  }

  async ensureSiteKeys(): Promise<SiteKeysResponse> {
    const current = await this.getSiteKeys();
    let dirty = false;
    for (const site of ["qwen", "deepseek", "gemini"] as KnownSiteId[]) {
      if (current.sites[site]?.key) {
        continue;
      }
      const now = new Date().toISOString();
      current.sites[site] = {
        site,
        key: generateSiteKey(),
        createdAt: now,
        rotatedAt: now
      };
      dirty = true;
    }

    if (dirty) {
      current.rotatedAt = new Date().toISOString();
      await writeJsonFile(getSiteKeysPath(), current);
    }

    return current;
  }

  async rotateSiteKey(site: KnownSiteId): Promise<SiteKeysResponse> {
    const current = await this.ensureSiteKeys();
    const now = new Date().toISOString();
    current.sites[site] = {
      site,
      key: generateSiteKey(),
      createdAt: current.sites[site]?.createdAt ?? now,
      rotatedAt: now
    };
    current.rotatedAt = now;
    await writeJsonFile(getSiteKeysPath(), current);
    return current;
  }

  async verifySiteKey(site: KnownSiteId, token: string): Promise<boolean> {
    if (!token) {
      return false;
    }
    const keys = await this.ensureSiteKeys();
    return keys.sites[site]?.key === token;
  }
}

function generateSiteKey(): string {
  return randomBytes(KEY_SIZE_BYTES).toString("hex");
}

