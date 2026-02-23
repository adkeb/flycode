/**
 * FlyCode Note: Extension settings storage
 * Wraps chrome.storage access with defaults so runtime and options pages share consistent settings.
 */
import type { ExtensionSettings } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

const STORAGE_KEY = "flycodeSettings";

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEY] ?? {})
  };
}

export async function saveSettings(input: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const next = {
    ...(await getSettings()),
    ...input
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
