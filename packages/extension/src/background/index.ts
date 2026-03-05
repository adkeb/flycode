/**
 * FlyCode Note: Background bridge support (capture-only mode)
 */
import { fetchHealth } from "./api-client.js";
import { getSettings, saveSettings } from "../shared/storage.js";
import type { AppStatusResponse, RuntimeMessage } from "../shared/types.js";

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error("[FlyCode][background] message handler error", error);
      sendResponse({ ok: false, message: (error as Error).message });
    });

  return true;
});

async function handleMessage(message: RuntimeMessage, sender?: chrome.runtime.MessageSender): Promise<unknown> {
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

  if (message.type === "FLYCODE_RELOAD_TABS") {
    const tabs = await chrome.tabs.query({
      url: ["*://chat.qwen.ai/*", "*://chat.deepseek.com/*", "*://www.deepseek.com/*"]
    });
    await Promise.all(tabs.map((tab) => (tab.id ? chrome.tabs.reload(tab.id) : Promise.resolve())));
    return { ok: true, count: tabs.length };
  }

  if (message.type === "FLYCODE_GET_TAB_CONTEXT") {
    const tab = sender?.tab;
    if (!tab || typeof tab.id !== "number" || typeof tab.windowId !== "number") {
      return { ok: false, message: "Unable to resolve tab context" };
    }
    return {
      ok: true,
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title
    };
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
