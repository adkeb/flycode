import type { ExtensionSettings } from "../shared/types.js";

const baseUrlInput = document.getElementById("baseUrl") as HTMLInputElement;
const tokenInput = document.getElementById("token") as HTMLInputElement;
const pairCodeInput = document.getElementById("pairCode") as HTMLInputElement;
const maxInjectTokensInput = document.getElementById("maxInjectTokens") as HTMLInputElement;
const confirmWritesInput = document.getElementById("confirmWritesEnabled") as HTMLInputElement;
const autoToolEnabledInput = document.getElementById("autoToolEnabled") as HTMLInputElement;
const autoToolAutoSendInput = document.getElementById("autoToolAutoSend") as HTMLInputElement;
const autoToolAllowWriteInput = document.getElementById("autoToolAllowWrite") as HTMLInputElement;
const autoToolMaxCallsInput = document.getElementById("autoToolMaxCallsPerTurn") as HTMLInputElement;
const compactResultDisplayInput = document.getElementById("compactResultDisplayEnabled") as HTMLInputElement;
const debugLoggingEnabledInput = document.getElementById("debugLoggingEnabled") as HTMLInputElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const pairBtn = document.getElementById("pairBtn") as HTMLButtonElement;
const reloadBtn = document.getElementById("reloadBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

void init();

async function init(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({ type: "FLYCODE_GET_SETTINGS" })) as {
    ok: boolean;
    settings: ExtensionSettings;
  };

  if (!response.ok) {
    setStatus("加载扩展设置失败。", true);
    return;
  }

  fillForm(response.settings);

  saveBtn.addEventListener("click", async () => {
    try {
      const payload = readForm();
      const saved = await chrome.runtime.sendMessage({
        type: "FLYCODE_SAVE_SETTINGS",
        settings: payload
      });

      if (!saved?.ok) {
        setStatus(saved?.message ?? "保存失败", true);
        return;
      }

      setStatus("设置已保存。", false);
    } catch (error) {
      setStatus(`保存失败：${(error as Error).message}`, true);
    }
  });

  pairBtn.addEventListener("click", async () => {
    const pairCode = pairCodeInput.value.trim();
    if (!pairCode) {
      setStatus("请先输入配对码。", true);
      return;
    }

    try {
      const paired = await chrome.runtime.sendMessage({
        type: "FLYCODE_VERIFY_PAIR",
        pairCode
      });

      if (!paired?.ok) {
        setStatus(paired?.message ?? "配对失败", true);
        return;
      }

      tokenInput.value = paired.settings.token;
      setStatus(`配对成功。Token 有效期至 ${paired.expiresAt}。`, false);
    } catch (error) {
      setStatus(`配对失败：${(error as Error).message}`, true);
    }
  });

  reloadBtn.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: "FLYCODE_RELOAD_TABS" });
    if (!response?.ok) {
      setStatus(response?.message ?? "页面重载失败", true);
      return;
    }
    setStatus(`已重载 ${response.count} 个匹配页面。`, false);
  });
}

function fillForm(settings: ExtensionSettings): void {
  baseUrlInput.value = settings.baseUrl;
  tokenInput.value = settings.token;
  maxInjectTokensInput.value = String(settings.maxInjectTokens);
  confirmWritesInput.checked = settings.confirmWritesEnabled;
  autoToolEnabledInput.checked = settings.autoToolEnabled;
  autoToolAutoSendInput.checked = settings.autoToolAutoSend;
  autoToolAllowWriteInput.checked = settings.autoToolAllowWrite;
  autoToolMaxCallsInput.value = String(settings.autoToolMaxCallsPerTurn);
  compactResultDisplayInput.checked = settings.compactResultDisplayEnabled;
  debugLoggingEnabledInput.checked = settings.debugLoggingEnabled;
}

function readForm(): Partial<ExtensionSettings> {
  const maxInjectTokens = Number(maxInjectTokensInput.value || "12000");
  const autoToolMaxCallsPerTurn = Number(autoToolMaxCallsInput.value || "3");
  return {
    baseUrl: baseUrlInput.value.trim(),
    token: tokenInput.value.trim(),
    maxInjectTokens,
    confirmWritesEnabled: confirmWritesInput.checked,
    autoToolEnabled: autoToolEnabledInput.checked,
    autoToolAutoSend: autoToolAutoSendInput.checked,
    autoToolAllowWrite: autoToolAllowWriteInput.checked,
    autoToolMaxCallsPerTurn: clamp(autoToolMaxCallsPerTurn, 1, 20),
    compactResultDisplayEnabled: compactResultDisplayInput.checked,
    debugLoggingEnabled: debugLoggingEnabledInput.checked
  };
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
