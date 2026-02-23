/**
 * FlyCode Note: Minimal options page (V2)
 * Shows app connectivity, syncs per-site keys, and keeps lightweight local toggles.
 */
import type { ExtensionSettings } from "../shared/types.js";

const appBaseUrlInput = document.getElementById("appBaseUrl") as HTMLInputElement;
const maxInjectTokensInput = document.getElementById("maxInjectTokens") as HTMLInputElement;
const autoToolEnabledInput = document.getElementById("autoToolEnabled") as HTMLInputElement;
const autoToolAutoSendInput = document.getElementById("autoToolAutoSend") as HTMLInputElement;
const compactResultInput = document.getElementById("compactResultDisplayEnabled") as HTMLInputElement;
const debugInput = document.getElementById("debugLoggingEnabled") as HTMLInputElement;
const qwenKeyInput = document.getElementById("qwenKey") as HTMLInputElement;
const deepseekKeyInput = document.getElementById("deepseekKey") as HTMLInputElement;
const geminiKeyInput = document.getElementById("geminiKey") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const checkBtn = document.getElementById("checkBtn") as HTMLButtonElement;
const syncKeyBtn = document.getElementById("syncKeyBtn") as HTMLButtonElement;
const reloadBtn = document.getElementById("reloadBtn") as HTMLButtonElement;

void init();

async function init(): Promise<void> {
  const got = (await chrome.runtime.sendMessage({ type: "FLYCODE_GET_SETTINGS" })) as {
    ok: boolean;
    settings: ExtensionSettings;
  };
  if (!got?.ok || !got.settings) {
    setStatus("加载设置失败", true);
    return;
  }

  fillForm(got.settings);
  void checkConnection();

  saveBtn.addEventListener("click", async () => {
    const payload = readForm();
    const saved = await chrome.runtime.sendMessage({
      type: "FLYCODE_SAVE_SETTINGS",
      settings: payload
    });
    if (!saved?.ok) {
      setStatus(saved?.message ?? "保存失败", true);
      return;
    }
    fillForm(saved.settings);
    setStatus("设置已保存。", false);
  });

  checkBtn.addEventListener("click", async () => {
    await checkConnection();
  });

  syncKeyBtn.addEventListener("click", async () => {
    const synced = await chrome.runtime.sendMessage({ type: "FLYCODE_SYNC_SITE_KEYS" });
    if (!synced?.ok) {
      setStatus(synced?.message ?? "同步站点密钥失败", true);
      return;
    }
    fillForm(synced.settings);
    setStatus("站点密钥已同步到扩展。", false);
  });

  reloadBtn.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: "FLYCODE_RELOAD_TABS" });
    if (!response?.ok) {
      setStatus(response?.message ?? "重载页面失败", true);
      return;
    }
    setStatus(`已重载 ${response.count} 个页面。`, false);
  });
}

function fillForm(settings: ExtensionSettings): void {
  appBaseUrlInput.value = settings.appBaseUrl;
  maxInjectTokensInput.value = String(settings.maxInjectTokens);
  autoToolEnabledInput.checked = settings.autoToolEnabled;
  autoToolAutoSendInput.checked = settings.autoToolAutoSend;
  compactResultInput.checked = settings.compactResultDisplayEnabled;
  debugInput.checked = settings.debugLoggingEnabled;
  qwenKeyInput.value = settings.siteKeys.qwen ?? "";
  deepseekKeyInput.value = settings.siteKeys.deepseek ?? "";
  geminiKeyInput.value = settings.siteKeys.gemini ?? "";
}

function readForm(): Partial<ExtensionSettings> {
  return {
    appBaseUrl: appBaseUrlInput.value.trim(),
    maxInjectTokens: clamp(Number(maxInjectTokensInput.value), 200, 200000),
    autoToolEnabled: autoToolEnabledInput.checked,
    autoToolAutoSend: autoToolAutoSendInput.checked,
    compactResultDisplayEnabled: compactResultInput.checked,
    debugLoggingEnabled: debugInput.checked
  };
}

async function checkConnection(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: "FLYCODE_APP_STATUS" });
  if (!result?.ok) {
    setStatus(result?.message ?? "应用连接检测失败", true);
    return;
  }
  if (result.connected) {
    setStatus("应用连接正常。", false);
  } else {
    setStatus(`应用未连接：${result.message ?? "请先启动 FlyCode Desktop"}`, true);
  }
}

function setStatus(message: string, isError: boolean): void {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#a30000" : "#0a7a2f";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const next = Math.floor(value);
  if (next < min) return min;
  if (next > max) return max;
  return next;
}

