/**
 * FlyCode Note: Background MCP router
 * Bridges content/options messages to local desktop app APIs and persists extension settings.
 */
import type { SiteId } from "@flycode/shared-types";
import { callMcp, fetchHealth, fetchSiteKeys, getConfirmation } from "./api-client.js";
import { getSettings, saveSettings } from "../shared/storage.js";
import type {
  AppStatusResponse,
  ExecuteMcpResponse,
  RuntimeMessage,
  SyncSiteKeysResponse
} from "../shared/types.js";

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  void handleMessage(message)
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error("[FlyCode][background] message handler error", error);
      sendResponse({ ok: false, message: (error as Error).message });
    });

  return true;
});

async function handleMessage(message: RuntimeMessage): Promise<unknown> {
  if (message.type === "FLYCODE_GET_SETTINGS") {
    const settings = await getSettings();
    return { ok: true, settings };
  }

  if (message.type === "FLYCODE_SAVE_SETTINGS") {
    const settings = await saveSettings(message.settings);
    return { ok: true, settings };
  }

  if (message.type === "FLYCODE_APP_STATUS") {
    return checkAppStatus();
  }

  if (message.type === "FLYCODE_SYNC_SITE_KEYS") {
    return syncSiteKeys();
  }

  if (message.type === "FLYCODE_CONFIRMATION_GET") {
    const settings = await getSettings();
    const confirmation = await getConfirmation(settings, message.id);
    return { ok: true, confirmation };
  }

  if (message.type === "FLYCODE_MCP_EXECUTE") {
    const settings = await getSettings();
    const response = await callMcp(settings, message.site, message.envelope);
    const out: ExecuteMcpResponse = {
      ok: true,
      response
    };
    return out;
  }

  if (message.type === "FLYCODE_RELOAD_TABS") {
    const tabs = await chrome.tabs.query({
      url: ["*://chat.qwen.ai/*", "*://chat.deepseek.com/*", "*://www.deepseek.com/*"]
    });
    await Promise.all(tabs.map((tab) => (tab.id ? chrome.tabs.reload(tab.id) : Promise.resolve())));
    return { ok: true, count: tabs.length };
  }

  return { ok: false, message: "Unsupported message type" };
}

async function checkAppStatus(): Promise<AppStatusResponse> {
  const settings = await getSettings();
  try {
    const health = await fetchHealth(settings);
    return {
      ok: true,
      connected: true,
      health
    };
  } catch (error) {
    return {
      ok: true,
      connected: false,
      message: (error as Error).message
    };
  }
}

async function syncSiteKeys(): Promise<SyncSiteKeysResponse> {
  const settings = await getSettings();
  try {
    const keys = await fetchSiteKeys(settings);
    const next = await saveSettings({
      siteKeys: {
        qwen: keys.sites.qwen?.key ?? "",
        deepseek: keys.sites.deepseek?.key ?? "",
        gemini: keys.sites.gemini?.key ?? ""
      }
    });
    return {
      ok: true,
      keys,
      settings: next
    };
  } catch (error) {
    return {
      ok: false,
      message: (error as Error).message
    };
  }
}

export function normalizeSite(site: string): SiteId {
  if (site === "qwen" || site === "deepseek" || site === "gemini") {
    return site;
  }
  return "unknown";
}

