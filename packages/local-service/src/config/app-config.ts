/**
 * FlyCode Note: Desktop app config storage
 * Handles ~/.flycode/app-config.json and ~/.flycode/site-keys.json file paths and default values.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { SiteId, SiteKeysResponse } from "@flycode/shared-types";
import { getFlycodeHomeDir } from "./policy.js";
import type { AppConfigData } from "../types.js";

type KnownSiteId = Exclude<SiteId, "unknown">;

const KNOWN_SITES: KnownSiteId[] = ["qwen", "deepseek", "gemini"];

export function getAppConfigPath(): string {
  return path.join(getFlycodeHomeDir(), "app-config.json");
}

export function getSiteKeysPath(): string {
  return path.join(getFlycodeHomeDir(), "site-keys.json");
}

export function defaultAppConfig(): AppConfigData {
  return {
    theme: "system",
    logRetentionDays: 30,
    servicePort: 39393,
    alwaysAllow: {},
    bridge: {
      dedupeMaxEntries: 100_000,
      sessionReplayLimit: 500,
      offlineQueuePerSession: 200,
      toolInterceptDefault: "auto",
      confirmationWaitTimeoutMs: 125_000,
      confirmationPollIntervalMs: 1_200
    }
  };
}

export function defaultSiteKeys(): SiteKeysResponse {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    rotatedAt: now,
    sites: {}
  };
}

export function normalizeSiteKeys(input: unknown): SiteKeysResponse {
  const fallback = defaultSiteKeys();
  if (!input || typeof input !== "object") {
    return fallback;
  }

  const parsed = input as Partial<SiteKeysResponse>;
  const sitesRecord = parsed.sites && typeof parsed.sites === "object" ? parsed.sites : {};
  const sites: SiteKeysResponse["sites"] = {};
  for (const site of KNOWN_SITES) {
    const item = (sitesRecord as SiteKeysResponse["sites"])[site];
    if (!item || typeof item !== "object") {
      continue;
    }
    if (typeof item.key !== "string" || item.key.length < 8) {
      continue;
    }
    sites[site] = {
      site,
      key: item.key,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : fallback.createdAt,
      rotatedAt: typeof item.rotatedAt === "string" ? item.rotatedAt : fallback.rotatedAt
    };
  }

  return {
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : fallback.createdAt,
    rotatedAt: typeof parsed.rotatedAt === "string" ? parsed.rotatedAt : fallback.rotatedAt,
    sites
  };
}

export function normalizeAppConfig(input: unknown): AppConfigData {
  const fallback = defaultAppConfig();
  if (!input || typeof input !== "object") {
    return fallback;
  }

  const parsed = input as Partial<AppConfigData>;
  const theme = parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system" ? parsed.theme : fallback.theme;
  const retentionRaw = Number(parsed.logRetentionDays ?? fallback.logRetentionDays);
  const logRetentionDays = Number.isFinite(retentionRaw) ? Math.max(1, Math.min(365, Math.floor(retentionRaw))) : fallback.logRetentionDays;
  const portRaw = Number(parsed.servicePort ?? fallback.servicePort);
  const servicePort = Number.isFinite(portRaw) ? Math.max(1024, Math.min(65535, Math.floor(portRaw))) : fallback.servicePort;

  const alwaysAllow: Record<string, boolean> = {};
  const rawAllow = parsed.alwaysAllow;
  if (rawAllow && typeof rawAllow === "object") {
    for (const [key, value] of Object.entries(rawAllow)) {
      if (typeof value === "boolean") {
        alwaysAllow[key] = value;
      }
    }
  }

  const rawBridge = parsed.bridge;
  const dedupeMaxEntries = clampInt(
    rawBridge && typeof rawBridge === "object" ? (rawBridge as { dedupeMaxEntries?: unknown }).dedupeMaxEntries : undefined,
    1_000,
    1_000_000,
    fallback.bridge.dedupeMaxEntries
  );
  const sessionReplayLimit = clampInt(
    rawBridge && typeof rawBridge === "object" ? (rawBridge as { sessionReplayLimit?: unknown }).sessionReplayLimit : undefined,
    20,
    2_000,
    fallback.bridge.sessionReplayLimit
  );
  const offlineQueuePerSession = clampInt(
    rawBridge && typeof rawBridge === "object" ? (rawBridge as { offlineQueuePerSession?: unknown }).offlineQueuePerSession : undefined,
    20,
    1_000,
    fallback.bridge.offlineQueuePerSession
  );
  const toolInterceptRaw =
    rawBridge && typeof rawBridge === "object"
      ? (rawBridge as { toolInterceptDefault?: unknown }).toolInterceptDefault
      : undefined;
  const toolInterceptDefault =
    toolInterceptRaw === "manual" || toolInterceptRaw === "auto"
      ? toolInterceptRaw
      : fallback.bridge.toolInterceptDefault;
  const confirmationWaitTimeoutMs = clampInt(
    rawBridge && typeof rawBridge === "object"
      ? (rawBridge as { confirmationWaitTimeoutMs?: unknown }).confirmationWaitTimeoutMs
      : undefined,
    5_000,
    600_000,
    fallback.bridge.confirmationWaitTimeoutMs
  );
  const confirmationPollIntervalMs = clampInt(
    rawBridge && typeof rawBridge === "object"
      ? (rawBridge as { confirmationPollIntervalMs?: unknown }).confirmationPollIntervalMs
      : undefined,
    200,
    10_000,
    fallback.bridge.confirmationPollIntervalMs
  );

  return {
    theme,
    logRetentionDays,
    servicePort,
    alwaysAllow,
    bridge: {
      dedupeMaxEntries,
      sessionReplayLimit,
      offlineQueuePerSession,
      toolInterceptDefault,
      confirmationWaitTimeoutMs,
      confirmationPollIntervalMs
    }
  };
}

function clampInt(input: unknown, min: number, max: number, fallback: number): number {
  const raw = Number(input ?? fallback);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
