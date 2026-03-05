/**
 * FlyCode Note: Minimal options page (capture-only bridge mode)
 */
import type { ExtensionSettings } from "../shared/types.js";

const appBaseUrlInput = document.getElementById("appBaseUrl") as HTMLInputElement;
const bridgeFrontDedupeLimitInput = document.getElementById("bridgeFrontDedupeLimit") as HTMLInputElement;
const bridgeOutboundQueueLimitInput = document.getElementById("bridgeOutboundQueueLimit") as HTMLInputElement;
const bridgePingIntervalMsInput = document.getElementById("bridgePingIntervalMs") as HTMLInputElement;
const debugInput = document.getElementById("debugLoggingEnabled") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const checkBtn = document.getElementById("checkBtn") as HTMLButtonElement;
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
  bridgeFrontDedupeLimitInput.value = String(settings.bridgeFrontDedupeLimit);
  bridgeOutboundQueueLimitInput.value = String(settings.bridgeOutboundQueueLimit);
  bridgePingIntervalMsInput.value = String(settings.bridgePingIntervalMs);
  debugInput.checked = settings.debugLoggingEnabled;
}

function readForm(): Partial<ExtensionSettings> {
  return {
    appBaseUrl: appBaseUrlInput.value.trim(),
    bridgeFrontDedupeLimit: clamp(Number(bridgeFrontDedupeLimitInput.value), 200, 20000),
    bridgeOutboundQueueLimit: clamp(Number(bridgeOutboundQueueLimitInput.value), 20, 1000),
    bridgePingIntervalMs: clamp(Number(bridgePingIntervalMsInput.value), 2000, 120000),
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
