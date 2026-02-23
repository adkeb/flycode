/**
 * FlyCode Note: Background message router
 * Handles runtime messages for settings, pairing, command execution, and confirmation popup workflow.
 */
import { runCommand, verifyPairCode } from "./api-client.js";
import type { CommandResult } from "@flycode/shared-types";
import { getSettings, saveSettings } from "../shared/storage.js";
import type { RuntimeMessage } from "../shared/types.js";

const pendingConfirmations = new Map<string, (approved: boolean) => void>();

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

  if (message.type === "FLYCODE_VERIFY_PAIR") {
    const current = await getSettings();
    const verified = await verifyPairCode(current, message.pairCode);
    const settings = await saveSettings({ token: verified.token });
    return { ok: true, settings, expiresAt: verified.expiresAt };
  }

  if (message.type === "FLYCODE_RELOAD_TABS") {
    const tabs = await chrome.tabs.query({
      url: ["*://chat.qwen.ai/*", "*://chat.deepseek.com/*", "*://www.deepseek.com/*"]
    });

    await Promise.all(tabs.map((tab) => (tab.id ? chrome.tabs.reload(tab.id) : Promise.resolve())));
    return { ok: true, count: tabs.length };
  }

  if (message.type === "FLYCODE_CONFIRM_DECISION") {
    const resolve = pendingConfirmations.get(message.requestId);
    if (resolve) {
      resolve(message.approved);
      pendingConfirmations.delete(message.requestId);
    }

    return { ok: true };
  }

  if (message.type === "FLYCODE_EXECUTE") {
    const settings = await getSettings();
    bgLog(settings.debugLoggingEnabled, "execute request", {
      site: message.site,
      command: message.command.command,
      raw: message.command.raw
    });
    const result = await runCommand(settings, message.command, message.site, requestConfirmation);
    const budgetedResult = applyClientTokenBudget(result, settings.maxInjectTokens);
    bgLog(settings.debugLoggingEnabled, "execute result", {
      ok: budgetedResult.ok,
      errorCode: budgetedResult.errorCode,
      auditId: budgetedResult.auditId,
      truncated: budgetedResult.truncated
    });
    return { ok: true, result: budgetedResult };
  }

  return { ok: false, message: "Unsupported message type" };
}

function applyClientTokenBudget(result: CommandResult, maxTokens: number): CommandResult {
  if (!result.ok || result.data === undefined) {
    return result;
  }

  const maxChars = Math.max(200, maxTokens * 4);
  const serialized = JSON.stringify(result.data);

  if (serialized.length <= maxChars) {
    return result;
  }

  const next: CommandResult = {
    ...result,
    truncated: true
  };

  if (isRecord(next.data) && typeof next.data.content === "string") {
    next.data = {
      ...next.data,
      content: `${next.data.content.slice(0, maxChars)}\n\n[...TRUNCATED_BY_EXTENSION_TOKEN_BUDGET...]`
    };
    return next;
  }

  next.data = {
    preview: `${serialized.slice(0, maxChars)}\n\n[...TRUNCATED_BY_EXTENSION_TOKEN_BUDGET...]`
  };

  return next;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

async function requestConfirmation(summary: string, requestId: string): Promise<boolean> {
  const pageUrl = chrome.runtime.getURL(
    `confirm.html?requestId=${encodeURIComponent(requestId)}&summary=${encodeURIComponent(summary)}`
  );

  await chrome.windows.create({
    url: pageUrl,
    type: "popup",
    width: 640,
    height: 520
  });

  return new Promise<boolean>((resolve) => {
    pendingConfirmations.set(requestId, resolve);

    const timeoutMs = 120_000;
    setTimeout(() => {
      if (!pendingConfirmations.has(requestId)) {
        return;
      }
      pendingConfirmations.delete(requestId);
      resolve(false);
    }, timeoutMs);
  });
}

function bgLog(enabled: boolean, message: string, payload?: unknown): void {
  if (!enabled) {
    return;
  }

  if (payload === undefined) {
    console.info("[FlyCode][background]", message);
    return;
  }

  console.info("[FlyCode][background]", message, payload);
}
