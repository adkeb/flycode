import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionIcon, AppShell, Card, MantineProvider, Stack, Text, Tooltip } from "@mantine/core";
import ChatWorkbenchPage from "./pages/ChatWorkbenchPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import SidebarNav from "./components/SidebarNav.jsx";
import TopStatusBar from "./components/TopStatusBar.jsx";

const API_BASE = "http://127.0.0.1:39393";
const MANAGED_SITES = ["qwen", "deepseek", "gemini"];
const CONFIRMATION_REQUIRED_TOOLS = ["fs.write", "fs.writeBatch", "fs.rm", "fs.mv", "fs.chmod", "process.run", "shell.exec"];
const LOCAL_SETTINGS_DRAFT_KEY = "flycode.desktop.settings-draft.v1";
const LOCAL_LAYOUT_KEY = "flycode.desktop.layout.v1";
const DEFAULT_ALLOWED_COMMANDS = ["npm", "node", "git", "rg", "pnpm", "yarn"];

const DEFAULT_POLICY_RUNTIME = {
  allowed_roots: [],
  process: {
    allowed_commands: [...DEFAULT_ALLOWED_COMMANDS],
    allowed_cwds: []
  }
};

const DEFAULT_APP_CONFIG = {
  theme: "system",
  logRetentionDays: 30,
  servicePort: 39393,
  alwaysAllow: {},
  bridge: {
    dedupeMaxEntries: 100000,
    sessionReplayLimit: 500,
    offlineQueuePerSession: 200,
    toolInterceptDefault: "auto",
    confirmationWaitTimeoutMs: 125000,
    confirmationPollIntervalMs: 1200
  }
};

export default function App() {
  const localDraft = useMemo(() => readLocalSettingsDraft(), []);
  const localLayout = useMemo(() => readLocalLayoutState(), []);

  const [route, setRoute] = useState(readRouteFromHash());

  const [healthConnected, setHealthConnected] = useState(false);
  const [healthCheckedAt, setHealthCheckedAt] = useState("");
  const [healthError, setHealthError] = useState("");

  const [confirmations, setConfirmations] = useState([]);
  const [siteKeys, setSiteKeys] = useState(null);
  const [events, setEvents] = useState([]);
  const [policyRuntime, setPolicyRuntime] = useState(localDraft.policyRuntime ?? DEFAULT_POLICY_RUNTIME);

  const [rootInput, setRootInput] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [cwdInput, setCwdInput] = useState("");

  const [siteAdvancedOpen, setSiteAdvancedOpen] = useState({});
  const [pendingCount, setPendingCount] = useState(0);
  const [sidebarVisible, setSidebarVisible] = useState(localLayout.sidebarVisible === true);
  const [topbarVisible, setTopbarVisible] = useState(localLayout.topbarVisible === true);

  const [appConfig, setAppConfig] = useState(localDraft.appConfig ?? DEFAULT_APP_CONFIG);

  const [filters, setFilters] = useState({
    site: "all",
    status: "all",
    tool: "",
    keyword: ""
  });

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const onHashChange = () => {
      setRoute(readRouteFromHash());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    writeLocalSettingsDraft({
      appConfig,
      policyRuntime
    });
  }, [appConfig, policyRuntime]);

  useEffect(() => {
    writeLocalLayoutState({
      sidebarVisible,
      topbarVisible
    });
  }, [sidebarVisible, topbarVisible]);

  useEffect(() => {
    if (route === "settings") {
      setSidebarVisible(true);
      setTopbarVisible(true);
    }
  }, [route]);

  const colorScheme = useMemo(() => {
    if (appConfig.theme === "light" || appConfig.theme === "dark") {
      return appConfig.theme;
    }
    return "auto";
  }, [appConfig.theme]);

  const refreshAll = useCallback(async () => {
    setBusy(true);
    setError("");

    const settled = await Promise.allSettled([
      loadHealth(),
      loadConfirmations(),
      loadSiteKeys(),
      loadConsole(),
      loadAppConfig(),
      loadPolicyRuntime()
    ]);

    const rejected = settled.filter((item) => item.status === "rejected");
    if (rejected.length > 0) {
      setError(
        rejected
          .map((item) => String(item.reason?.message ?? item.reason ?? "未知错误"))
          .slice(0, 3)
          .join("; ")
      );
    }

    setBusy(false);
  }, [filters.keyword, filters.site, filters.status, filters.tool]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadConfirmations();
      void loadConsole();
      void loadHealth();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [filters.keyword, filters.site, filters.status, filters.tool]);

  async function loadHealth() {
    try {
      await getJson("/v1/health");
      setHealthConnected(true);
      setHealthError("");
      setHealthCheckedAt(new Date().toISOString());
    } catch (err) {
      setHealthConnected(false);
      setHealthError(String(err?.message ?? err ?? "服务不可达"));
      setHealthCheckedAt(new Date().toISOString());
      throw err;
    }
  }

  async function loadConfirmations() {
    const value = await getJson("/v1/confirmations?limit=60");
    setConfirmations(Array.isArray(value?.data) ? value.data : []);
  }

  async function loadSiteKeys() {
    const value = await getJson("/v1/site-keys");
    setSiteKeys(value?.data ?? null);
  }

  async function loadAppConfig() {
    const value = await getJson("/v1/app-config");
    if (!value?.data) {
      return;
    }
    setAppConfig(normalizeAppConfigValue(value.data));
  }

  async function loadPolicyRuntime() {
    const value = await getJson("/v1/policy/runtime");
    const data = value?.data;
    if (!data || typeof data !== "object") {
      return;
    }
    setPolicyRuntime(normalizePolicyRuntimeValue(data));
  }

  function buildConsoleSearch(filtersValue = filters) {
    const search = new URLSearchParams();
    search.set("limit", "240");
    if (filtersValue.site) search.set("site", filtersValue.site);
    if (filtersValue.status) search.set("status", filtersValue.status);
    if (filtersValue.tool.trim()) search.set("tool", filtersValue.tool.trim());
    if (filtersValue.keyword.trim()) search.set("keyword", filtersValue.keyword.trim());
    return search;
  }

  async function loadConsole() {
    const search = buildConsoleSearch();
    const value = await getJson(`/v1/console/events?${search.toString()}`);
    setEvents(Array.isArray(value?.data) ? value.data : []);
  }

  async function saveConfig(patch) {
    const saved = await postJson("/v1/app-config", {
      ...appConfig,
      ...patch
    });
    setAppConfig(normalizeAppConfigValue(saved.data));
    setNotice("配置已保存。");
    setError("");
  }

  async function savePolicyRuntime(nextRuntime, options = { showNotice: true }) {
    const runtime = normalizePolicyRuntimeValue(nextRuntime);
    const patch = {
      allowed_roots: runtime.allowed_roots,
      process: {
        allowed_commands: runtime.process.allowed_commands,
        allowed_cwds: runtime.process.allowed_cwds
      }
    };

    const validation = await postJson("/v1/policy/runtime/validate", patch);
    const result = validation?.data;
    if (!result?.ok) {
      const detail = (result?.errors ?? []).map((item) => `${item.field}: ${item.message}`).join("; ") || "校验失败";
      setError(detail);
      return false;
    }

    const saved = await postJson("/v1/policy/runtime", patch);
    setPolicyRuntime(normalizePolicyRuntimeValue(saved?.data ?? runtime));
    if (options.showNotice) {
      setNotice("策略已保存并热更新生效。");
    }
    setError("");
    return true;
  }

  async function validateAndSavePolicyRuntime() {
    await savePolicyRuntime(policyRuntime);
  }

  async function rotateKey(siteId) {
    await postJson(`/v1/site-keys/rotate/${siteId}`, {});
    await loadSiteKeys();
    setNotice(`${siteId} key 已轮换。`);
  }

  async function updateAlwaysAllowMap(nextAlwaysAllow, noticeText) {
    const saved = await postJson("/v1/app-config", {
      ...appConfig,
      alwaysAllow: nextAlwaysAllow
    });
    setAppConfig(normalizeAppConfigValue(saved.data));
    setNotice(noticeText);
  }

  function toolAlwaysAllowEnabled(site, tool) {
    return appConfig?.alwaysAllow?.[`${site}:${tool}`] === true;
  }

  function siteAllAlwaysAllowEnabled(site) {
    return CONFIRMATION_REQUIRED_TOOLS.every((tool) => toolAlwaysAllowEnabled(site, tool));
  }

  async function setSiteToolAlwaysAllow(site, tool, allow) {
    const nextAlwaysAllow = {
      ...(appConfig.alwaysAllow ?? {}),
      [`${site}:${tool}`]: allow
    };
    await updateAlwaysAllowMap(nextAlwaysAllow, `${site} ${tool} 已${allow ? "设置为免确认" : "恢复为需确认"}`);
  }

  async function setSiteAllAlwaysAllow(site, allow) {
    const nextAlwaysAllow = {
      ...(appConfig.alwaysAllow ?? {})
    };
    for (const tool of CONFIRMATION_REQUIRED_TOOLS) {
      nextAlwaysAllow[`${site}:${tool}`] = allow;
    }
    await updateAlwaysAllowMap(nextAlwaysAllow, `${site} 已${allow ? "开启全部免确认" : "关闭全部免确认"}`);
  }

  async function decide(confirmationId, approved, alwaysAllow = false) {
    await postJson(`/v1/confirmations/${encodeURIComponent(confirmationId)}/decision`, {
      approved,
      alwaysAllow
    });
    await loadConfirmations();
    setNotice(`确认 ${approved ? "通过" : "拒绝"}：${confirmationId}`);
  }

  function addPolicyRoot() {
    const value = rootInput.trim();
    if (!value) return;
    if (policyRuntime.allowed_roots.includes(value)) {
      setRootInput("");
      return;
    }
    const next = normalizePolicyRuntimeValue({
      ...policyRuntime,
      allowed_roots: [...policyRuntime.allowed_roots, value]
    });
    setPolicyRuntime(next);
    setRootInput("");
    void savePolicyRuntime(next, { showNotice: false });
  }

  function removePolicyRoot(target) {
    const next = normalizePolicyRuntimeValue({
      ...policyRuntime,
      allowed_roots: policyRuntime.allowed_roots.filter((item) => item !== target)
    });
    setPolicyRuntime(next);
    void savePolicyRuntime(next, { showNotice: false });
  }

  function addAllowedCommand() {
    const value = commandInput.trim();
    if (!value) return;
    if (policyRuntime.process.allowed_commands.includes(value)) {
      setCommandInput("");
      return;
    }
    const next = normalizePolicyRuntimeValue({
      ...policyRuntime,
      process: {
        ...policyRuntime.process,
        allowed_commands: [...policyRuntime.process.allowed_commands, value]
      }
    });
    setPolicyRuntime(next);
    setCommandInput("");
    void savePolicyRuntime(next, { showNotice: false });
  }

  function removeAllowedCommand(target) {
    const next = normalizePolicyRuntimeValue({
      ...policyRuntime,
      process: {
        ...policyRuntime.process,
        allowed_commands: policyRuntime.process.allowed_commands.filter((item) => item !== target)
      }
    });
    setPolicyRuntime(next);
    void savePolicyRuntime(next, { showNotice: false });
  }

  function addAllowedCwd() {
    const value = cwdInput.trim();
    if (!value) return;
    if (policyRuntime.process.allowed_cwds.includes(value)) {
      setCwdInput("");
      return;
    }
    const next = normalizePolicyRuntimeValue({
      ...policyRuntime,
      process: {
        ...policyRuntime.process,
        allowed_cwds: [...policyRuntime.process.allowed_cwds, value]
      }
    });
    setPolicyRuntime(next);
    setCwdInput("");
    void savePolicyRuntime(next, { showNotice: false });
  }

  function removeAllowedCwd(target) {
    const next = normalizePolicyRuntimeValue({
      ...policyRuntime,
      process: {
        ...policyRuntime.process,
        allowed_cwds: policyRuntime.process.allowed_cwds.filter((item) => item !== target)
      }
    });
    setPolicyRuntime(next);
    void savePolicyRuntime(next, { showNotice: false });
  }

  async function exportConsoleEvents() {
    const search = buildConsoleSearch(filters);
    const value = await getJson(`/v1/console/export?${search.toString()}`);
    const rows = Array.isArray(value?.data) ? value.data : [];
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flycode-console-${new Date().toISOString().replaceAll(":", "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`已导出 ${rows.length} 条日志。`);
  }

  async function clearConsoleEvents() {
    const choice = window.prompt("清空日志：输入 1 清空当前筛选，输入 2 清空全部，其他取消", "1");
    if (choice !== "1" && choice !== "2") {
      return;
    }
    const body =
      choice === "1"
        ? {
            mode: "filtered",
            filters: {
              site: filters.site,
              status: filters.status,
              tool: filters.tool,
              keyword: filters.keyword
            }
          }
        : { mode: "all" };

    const value = await postJson("/v1/console/clear", body);
    const deleted = Number(value?.data?.deleted ?? 0);
    setNotice(`已清空 ${deleted} 条日志。`);
    await loadConsole();
  }

  function navigate(nextRoute) {
    const safe = nextRoute === "settings" ? "settings" : "chat";
    const targetHash = `#/${safe}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
    setRoute(safe);
  }

  const immersiveChat = route === "chat";
  const navbarOpened = !immersiveChat || sidebarVisible;
  const headerOpened = !immersiveChat || topbarVisible;

  return (
    <MantineProvider defaultColorScheme="auto" forceColorScheme={colorScheme}>
      <AppShell
        className={`flycode-shell ${immersiveChat ? "is-chat" : "is-settings"} ${navbarOpened ? "is-navbar-open" : "is-navbar-hidden"} ${headerOpened ? "is-header-open" : "is-header-hidden"}`}
        padding={immersiveChat ? "xs" : "md"}
        header={{ height: headerOpened ? 72 : 0 }}
        navbar={{ width: navbarOpened ? 250 : 0, breakpoint: "sm" }}
      >
        <AppShell.Navbar>
          <SidebarNav route={route} onNavigate={navigate} pendingCount={pendingCount} />
        </AppShell.Navbar>

        <AppShell.Header>
          <TopStatusBar
            healthConnected={healthConnected}
            healthError={healthError}
            healthCheckedAt={healthCheckedAt}
            theme={appConfig.theme}
            onChangeTheme={(nextTheme) => {
              setAppConfig((prev) => ({ ...prev, theme: nextTheme }));
              void saveConfig({ theme: nextTheme });
            }}
            onRefresh={() => void refreshAll()}
            busy={busy}
            route={route}
          />
        </AppShell.Header>

        <AppShell.Main>
          {immersiveChat ? (
            <div className="flycode-floating-controls">
              <Tooltip label={sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"} withArrow>
                <ActionIcon
                  variant="light"
                  size="lg"
                  onClick={() => setSidebarVisible((value) => !value)}
                >
                  ☰
                </ActionIcon>
              </Tooltip>
              <Tooltip label={topbarVisible ? "隐藏顶栏" : "显示顶栏"} withArrow>
                <ActionIcon
                  variant="light"
                  size="lg"
                  onClick={() => setTopbarVisible((value) => !value)}
                >
                  ⌂
                </ActionIcon>
              </Tooltip>
            </div>
          ) : null}

          {route === "chat" ? (
            <ChatWorkbenchPage
              apiBase={API_BASE}
              sessionReplayLimit={appConfig.bridge?.sessionReplayLimit ?? 500}
              notice={notice}
              error={error}
              onPendingCountChange={setPendingCount}
            />
          ) : (
            <Stack gap="md">
              {(notice || error) && (
                <Card withBorder>
                  {notice ? <Text c="green">{notice}</Text> : null}
                  {error ? <Text c="red">{error}</Text> : null}
                </Card>
              )}

              <SettingsPage
                state={{
                  appConfig,
                  policyRuntime,
                  rootInput,
                  commandInput,
                  cwdInput,
                  confirmations,
                  siteKeys,
                  siteAdvancedOpen,
                  filters,
                  events
                }}
                actions={{
                  setAppConfig,
                  saveConfig,
                  setRootInput,
                  setCommandInput,
                  setCwdInput,
                  addPolicyRoot,
                  removePolicyRoot,
                  addAllowedCommand,
                  removeAllowedCommand,
                  addAllowedCwd,
                  removeAllowedCwd,
                  validateAndSavePolicyRuntime,
                  decide,
                  rotateKey,
                  setSiteAdvancedOpen,
                  siteAllAlwaysAllowEnabled,
                  setSiteAllAlwaysAllow,
                  toolAlwaysAllowEnabled,
                  setSiteToolAlwaysAllow,
                  setFilters,
                  loadConsole,
                  exportConsoleEvents,
                  clearConsoleEvents
                }}
                constants={{
                  MANAGED_SITES,
                  CONFIRMATION_REQUIRED_TOOLS
                }}
              />
            </Stack>
          )}
        </AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
}

async function getJson(pathValue) {
  const response = await fetch(`${API_BASE}${pathValue}`);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Invalid JSON response");
  }
  if (!response.ok) {
    throw new Error(payload?.message || `HTTP ${response.status}`);
  }
  return payload;
}

async function postJson(pathValue, body) {
  const response = await fetch(`${API_BASE}${pathValue}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Invalid JSON response");
  }
  if (!response.ok) {
    throw new Error(payload?.message || `HTTP ${response.status}`);
  }
  return payload;
}

function readRouteFromHash() {
  const raw = String(window.location.hash || "").replace(/^#\/?/, "").trim();
  if (raw === "settings") {
    return "settings";
  }
  return "chat";
}

function normalizePolicyRuntimeValue(input) {
  if (!input || typeof input !== "object") {
    return DEFAULT_POLICY_RUNTIME;
  }
  const allowedRoots = Array.isArray(input.allowed_roots) ? input.allowed_roots.map((item) => String(item)).filter(Boolean) : [];
  const allowedCommands = Array.isArray(input.process?.allowed_commands)
    ? input.process.allowed_commands.map((item) => String(item)).filter(Boolean)
    : [];
  const allowedCwds = Array.isArray(input.process?.allowed_cwds)
    ? input.process.allowed_cwds.map((item) => String(item)).filter(Boolean)
    : [];
  return {
    allowed_roots: allowedRoots,
    process: {
      allowed_commands: allowedCommands.length > 0 ? Array.from(new Set(allowedCommands)) : [...DEFAULT_ALLOWED_COMMANDS],
      allowed_cwds: allowedCwds
    }
  };
}

function normalizeAppConfigValue(input) {
  if (!input || typeof input !== "object") {
    return DEFAULT_APP_CONFIG;
  }
  const theme = input.theme === "light" || input.theme === "dark" || input.theme === "system" ? input.theme : "system";
  const alwaysAllow = input.alwaysAllow && typeof input.alwaysAllow === "object" ? input.alwaysAllow : {};
  const bridge = input.bridge && typeof input.bridge === "object" ? input.bridge : {};
  return {
    ...DEFAULT_APP_CONFIG,
    ...input,
    theme,
    alwaysAllow,
    bridge: {
      ...DEFAULT_APP_CONFIG.bridge,
      ...bridge
    }
  };
}

function readLocalSettingsDraft() {
  try {
    const raw = window.localStorage.getItem(LOCAL_SETTINGS_DRAFT_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return {
      appConfig: normalizeAppConfigValue(parsed?.appConfig),
      policyRuntime: normalizePolicyRuntimeValue(parsed?.policyRuntime)
    };
  } catch {
    return {};
  }
}

function writeLocalSettingsDraft(payload) {
  try {
    window.localStorage.setItem(
      LOCAL_SETTINGS_DRAFT_KEY,
      JSON.stringify({
        appConfig: normalizeAppConfigValue(payload?.appConfig),
        policyRuntime: normalizePolicyRuntimeValue(payload?.policyRuntime)
      })
    );
  } catch {
    // ignore storage failures
  }
}

function readLocalLayoutState() {
  try {
    const raw = window.localStorage.getItem(LOCAL_LAYOUT_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return {
      sidebarVisible: parsed?.sidebarVisible === true,
      topbarVisible: parsed?.topbarVisible === true
    };
  } catch {
    return {};
  }
}

function writeLocalLayoutState(payload) {
  try {
    window.localStorage.setItem(
      LOCAL_LAYOUT_KEY,
      JSON.stringify({
        sidebarVisible: payload?.sidebarVisible === true,
        topbarVisible: payload?.topbarVisible === true
      })
    );
  } catch {
    // ignore storage failures
  }
}
