/**
 * FlyCode Note: App config manager
 * Loads/saves desktop UI preferences and per-site tool always-allow flags.
 */
import type { SiteId } from "@flycode/shared-types";
import {
  getAppConfigPath,
  normalizeAppConfig,
  readJsonFile,
  writeJsonFile
} from "../config/app-config.js";
import type { AppConfigData, AppConfigManager } from "../types.js";

type KnownSiteId = Exclude<SiteId, "unknown">;

export class JsonAppConfigManager implements AppConfigManager {
  async load(): Promise<AppConfigData> {
    const raw = await readJsonFile(getAppConfigPath(), {});
    const normalized = normalizeAppConfig(raw);
    await writeJsonFile(getAppConfigPath(), normalized);
    return normalized;
  }

  async save(next: AppConfigData): Promise<AppConfigData> {
    const normalized = normalizeAppConfig(next);
    await writeJsonFile(getAppConfigPath(), normalized);
    return normalized;
  }

  async updateAlwaysAllow(site: KnownSiteId, tool: string, allow: boolean): Promise<AppConfigData> {
    const current = await this.load();
    const next: AppConfigData = {
      ...current,
      alwaysAllow: {
        ...current.alwaysAllow,
        [`${site}:${tool}`]: allow
      }
    };
    return this.save(next);
  }
}

