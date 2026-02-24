import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Accordion,
  AppShell,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Loader,
  MantineProvider,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title
} from "@mantine/core";
import { IconRefresh, IconShieldCheck, IconTerminal2 } from "@tabler/icons-react";

const API_BASE = "http://127.0.0.1:39393";
const MANAGED_SITES = ["qwen", "deepseek", "gemini"];
const CONFIRMATION_REQUIRED_TOOLS = ["fs.write", "fs.writeBatch", "fs.rm", "fs.mv", "fs.chmod", "process.run", "shell.exec"];

export default function App() {
  const [health, setHealth] = useState(null);
  const [healthConnected, setHealthConnected] = useState(false);
  const [healthCheckedAt, setHealthCheckedAt] = useState("");
  const [healthError, setHealthError] = useState("");

  const [confirmations, setConfirmations] = useState([]);
  const [siteKeys, setSiteKeys] = useState(null);
  const [events, setEvents] = useState([]);
  const [policyRuntime, setPolicyRuntime] = useState({
    allowed_roots: [],
    process: {
      allowed_commands: [],
      allowed_cwds: []
    }
  });

  const [rootInput, setRootInput] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [cwdInput, setCwdInput] = useState("");

  const [siteAdvancedOpen, setSiteAdvancedOpen] = useState({});

  const [appConfig, setAppConfig] = useState({
    theme: "system",
    logRetentionDays: 30,
    servicePort: 39393,
    alwaysAllow: {}
  });
  const [filters, setFilters] = useState({
    site: "all",
    status: "all",
    tool: "",
    keyword: ""
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

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
      const value = await getJson("/v1/health");
      setHealth(value);
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
    setAppConfig((prev) => ({
      ...prev,
      ...value.data
    }));
  }

  async function loadPolicyRuntime() {
    const value = await getJson("/v1/policy/runtime");
    const data = value?.data;
    if (!data || typeof data !== "object") {
      return;
    }
    setPolicyRuntime({
      allowed_roots: Array.isArray(data.allowed_roots) ? data.allowed_roots : [],
      process: {
        allowed_commands: Array.isArray(data.process?.allowed_commands) ? data.process.allowed_commands : [],
        allowed_cwds: Array.isArray(data.process?.allowed_cwds) ? data.process.allowed_cwds : []
      }
    });
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
    setAppConfig(saved.data);
    setNotice("配置已保存。");
  }

  async function validateAndSavePolicyRuntime() {
    const patch = {
      allowed_roots: policyRuntime.allowed_roots,
      process: {
        allowed_commands: policyRuntime.process.allowed_commands,
        allowed_cwds: policyRuntime.process.allowed_cwds
      }
    };

    const validation = await postJson("/v1/policy/runtime/validate", patch);
    const result = validation?.data;
    if (!result?.ok) {
      const detail = (result?.errors ?? []).map((item) => `${item.field}: ${item.message}`).join("; ") || "校验失败";
      setError(detail);
      return;
    }

    await postJson("/v1/policy/runtime", patch);
    setNotice("策略已热更新生效。");
    await loadPolicyRuntime();
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
    setAppConfig(saved.data);
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
    setPolicyRuntime((prev) => ({
      ...prev,
      allowed_roots: [...prev.allowed_roots, value]
    }));
    setRootInput("");
  }

  function removePolicyRoot(target) {
    setPolicyRuntime((prev) => ({
      ...prev,
      allowed_roots: prev.allowed_roots.filter((item) => item !== target)
    }));
  }

  function addAllowedCommand() {
    const value = commandInput.trim();
    if (!value) return;
    if (policyRuntime.process.allowed_commands.includes(value)) {
      setCommandInput("");
      return;
    }
    setPolicyRuntime((prev) => ({
      ...prev,
      process: {
        ...prev.process,
        allowed_commands: [...prev.process.allowed_commands, value]
      }
    }));
    setCommandInput("");
  }

  function removeAllowedCommand(target) {
    setPolicyRuntime((prev) => ({
      ...prev,
      process: {
        ...prev.process,
        allowed_commands: prev.process.allowed_commands.filter((item) => item !== target)
      }
    }));
  }

  function addAllowedCwd() {
    const value = cwdInput.trim();
    if (!value) return;
    if (policyRuntime.process.allowed_cwds.includes(value)) {
      setCwdInput("");
      return;
    }
    setPolicyRuntime((prev) => ({
      ...prev,
      process: {
        ...prev.process,
        allowed_cwds: [...prev.process.allowed_cwds, value]
      }
    }));
    setCwdInput("");
  }

  function removeAllowedCwd(target) {
    setPolicyRuntime((prev) => ({
      ...prev,
      process: {
        ...prev.process,
        allowed_cwds: prev.process.allowed_cwds.filter((item) => item !== target)
      }
    }));
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

  return (
    <MantineProvider defaultColorScheme="auto" forceColorScheme={colorScheme}>
      <AppShell padding="md" header={{ height: 72 }}>
        <AppShell.Header px="md">
          <Group justify="space-between" h="100%">
            <Group gap="sm">
              <IconTerminal2 size={22} />
              <div>
                <Title order={3}>FlyCode Desktop</Title>
                <Text size="sm" c="dimmed">
                  MCP-only 控制台与确认中心
                </Text>
              </div>
            </Group>
            <Group>
              <Select
                value={appConfig.theme}
                onChange={(value) => {
                  const next = value ?? "system";
                  setAppConfig((prev) => ({ ...prev, theme: next }));
                  void saveConfig({ theme: next });
                }}
                data={[
                  { value: "system", label: "跟随系统" },
                  { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" }
                ]}
                w={120}
              />
              <Button leftSection={<IconRefresh size={14} />} onClick={() => void refreshAll()} loading={busy}>
                刷新
              </Button>
            </Group>
          </Group>
        </AppShell.Header>

        <AppShell.Main>
          <Stack gap="md">
            {(notice || error) && (
              <Card withBorder>
                {notice ? <Text c="green">{notice}</Text> : null}
                {error ? <Text c="red">{error}</Text> : null}
              </Card>
            )}

            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <Card withBorder>
                <Group mb="xs">
                  <IconShieldCheck size={16} />
                  <Title order={4}>服务状态</Title>
                </Group>
                <Group justify="space-between" align="center">
                  <Group gap="xs">
                    <Badge color={healthConnected ? "green" : "red"} variant="filled">
                      {healthConnected ? "正在工作" : "断开连接"}
                    </Badge>
                    {!healthConnected && healthError ? (
                      <Text size="xs" c="red">
                        {healthError}
                      </Text>
                    ) : null}
                  </Group>
                  <Text size="xs" c="dimmed">
                    {healthCheckedAt ? `最近检查: ${new Date(healthCheckedAt).toLocaleString()}` : "未检查"}
                  </Text>
                </Group>
              </Card>

              <Card withBorder>
                <Title order={4} mb="sm">
                  配置中心
                </Title>
                <Stack gap="xs">
                  <TextInput
                    label="日志保留天数"
                    type="number"
                    min={1}
                    max={365}
                    value={String(appConfig.logRetentionDays ?? 30)}
                    onChange={(event) =>
                      setAppConfig((prev) => ({
                        ...prev,
                        logRetentionDays: clampNumber(event.currentTarget.value, 1, 365, 30)
                      }))
                    }
                  />
                  <TextInput
                    label="服务端口"
                    type="number"
                    min={1024}
                    max={65535}
                    value={String(appConfig.servicePort ?? 39393)}
                    onChange={(event) =>
                      setAppConfig((prev) => ({
                        ...prev,
                        servicePort: clampNumber(event.currentTarget.value, 1024, 65535, 39393)
                      }))
                    }
                  />
                  <Group justify="flex-end">
                    <Button
                      size="xs"
                      onClick={() =>
                        void saveConfig({
                          logRetentionDays: appConfig.logRetentionDays,
                          servicePort: appConfig.servicePort
                        })
                      }
                    >
                      保存配置
                    </Button>
                  </Group>
                </Stack>
              </Card>
            </SimpleGrid>

            <Card withBorder>
              <Title order={4} mb="sm">
                策略管理
              </Title>
              <SimpleGrid cols={{ base: 1, md: 3 }}>
                <Card withBorder p="sm">
                  <Text fw={600} size="sm" mb="xs">
                    允许目录 (allowed_roots)
                  </Text>
                  <Group mb="xs">
                    <TextInput
                      placeholder="输入绝对路径"
                      value={rootInput}
                      onChange={(event) => setRootInput(event.currentTarget.value)}
                      style={{ flex: 1 }}
                    />
                    <Button size="xs" onClick={addPolicyRoot}>
                      新增
                    </Button>
                  </Group>
                  <Stack gap={4}>
                    {policyRuntime.allowed_roots.map((item) => (
                      <Group key={item} justify="space-between">
                        <Text size="xs">{item}</Text>
                        <Button size="compact-xs" color="red" variant="light" onClick={() => removePolicyRoot(item)}>
                          删除
                        </Button>
                      </Group>
                    ))}
                  </Stack>
                </Card>

                <Card withBorder p="sm">
                  <Text fw={600} size="sm" mb="xs">
                    命令白名单 (allowed_commands)
                  </Text>
                  <Group mb="xs">
                    <TextInput
                      placeholder="如 npm / node / git"
                      value={commandInput}
                      onChange={(event) => setCommandInput(event.currentTarget.value)}
                      style={{ flex: 1 }}
                    />
                    <Button size="xs" onClick={addAllowedCommand}>
                      新增
                    </Button>
                  </Group>
                  <Stack gap={4}>
                    {policyRuntime.process.allowed_commands.map((item) => (
                      <Group key={item} justify="space-between">
                        <Text size="xs">{item}</Text>
                        <Button size="compact-xs" color="red" variant="light" onClick={() => removeAllowedCommand(item)}>
                          删除
                        </Button>
                      </Group>
                    ))}
                  </Stack>
                </Card>

                <Card withBorder p="sm">
                  <Text fw={600} size="sm" mb="xs">
                    命令工作目录 (allowed_cwds)
                  </Text>
                  <Group mb="xs">
                    <TextInput
                      placeholder="输入绝对路径"
                      value={cwdInput}
                      onChange={(event) => setCwdInput(event.currentTarget.value)}
                      style={{ flex: 1 }}
                    />
                    <Button size="xs" onClick={addAllowedCwd}>
                      新增
                    </Button>
                  </Group>
                  <Stack gap={4}>
                    {policyRuntime.process.allowed_cwds.map((item) => (
                      <Group key={item} justify="space-between">
                        <Text size="xs">{item}</Text>
                        <Button size="compact-xs" color="red" variant="light" onClick={() => removeAllowedCwd(item)}>
                          删除
                        </Button>
                      </Group>
                    ))}
                  </Stack>
                </Card>
              </SimpleGrid>

              <Group justify="flex-end" mt="sm">
                <Button size="xs" onClick={() => void validateAndSavePolicyRuntime()}>
                  保存并热更新
                </Button>
              </Group>
            </Card>

            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <Card withBorder>
                <Title order={4} mb="sm">
                  确认中心
                </Title>
                <Stack gap="xs">
                  {confirmations.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      当前无待处理确认。
                    </Text>
                  ) : (
                    confirmations.map((item) => (
                      <Card key={item.id} withBorder p="sm">
                        <Group justify="space-between" mb={6}>
                          <Text fw={600}>
                            {item.tool} · {item.site}
                          </Text>
                          <Badge color={statusColor(item.status)}>{item.status}</Badge>
                        </Group>
                        <Text size="sm" c="dimmed">
                          {item.summary}
                        </Text>
                        <Text size="xs" c="dimmed" mt={4}>
                          {new Date(item.createdAt).toLocaleString()}
                        </Text>
                        {item.status === "pending" ? (
                          <Group mt="xs">
                            <Button size="xs" color="green" onClick={() => void decide(item.id, true, false)}>
                              Approve
                            </Button>
                            <Button size="xs" color="blue" onClick={() => void decide(item.id, true, true)}>
                              Always Allow
                            </Button>
                            <Button size="xs" color="red" variant="light" onClick={() => void decide(item.id, false, false)}>
                              Reject
                            </Button>
                          </Group>
                        ) : null}
                      </Card>
                    ))
                  )}
                </Stack>
              </Card>

              <Card withBorder>
                <Title order={4} mb="sm">
                  站点管理
                </Title>
                <Stack gap="xs">
                  {MANAGED_SITES.map((site) => {
                    const row = siteKeys?.sites?.[site];
                    const advancedOpen = siteAdvancedOpen[site] === true;
                    return (
                      <Card key={site} withBorder p="sm">
                        <Group justify="space-between" mb={6}>
                          <Text fw={600}>{site}</Text>
                          <Button size="xs" variant="light" onClick={() => void rotateKey(site)}>
                            轮换
                          </Button>
                        </Group>
                        <Text size="xs" c="dimmed">
                          key: {row?.key ?? "(empty)"}
                        </Text>
                        <Text size="xs" c="dimmed" mt={4}>
                          rotated: {row?.rotatedAt ? new Date(row.rotatedAt).toLocaleString() : "-"}
                        </Text>
                        <Box mt="sm">
                          <Switch
                            size="xs"
                            label="该站点全部高风险命令免确认"
                            checked={siteAllAlwaysAllowEnabled(site)}
                            onChange={(event) => void setSiteAllAlwaysAllow(site, event.currentTarget.checked)}
                          />
                        </Box>
                        <Group mt="xs" justify="space-between">
                          <Text size="xs" c="dimmed">
                            高级设置
                          </Text>
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            onClick={() =>
                              setSiteAdvancedOpen((prev) => ({
                                ...prev,
                                [site]: !prev[site]
                              }))
                            }
                          >
                            {advancedOpen ? "收起" : "展开"}
                          </Button>
                        </Group>
                        {advancedOpen ? (
                          <Stack gap={6} mt="xs">
                            {CONFIRMATION_REQUIRED_TOOLS.map((tool) => (
                              <Switch
                                key={`${site}:${tool}`}
                                size="xs"
                                label={`${tool} 免确认`}
                                checked={toolAlwaysAllowEnabled(site, tool)}
                                onChange={(event) => void setSiteToolAlwaysAllow(site, tool, event.currentTarget.checked)}
                              />
                            ))}
                          </Stack>
                        ) : null}
                      </Card>
                    );
                  })}
                </Stack>
              </Card>
            </SimpleGrid>

            <Card withBorder>
              <Title order={4} mb="sm">
                请求控制台
              </Title>
              <SimpleGrid cols={{ base: 1, md: 4 }} mb="sm">
                <Select
                  label="站点"
                  value={filters.site}
                  onChange={(value) => setFilters((prev) => ({ ...prev, site: value ?? "all" }))}
                  data={[
                    { value: "all", label: "all" },
                    { value: "qwen", label: "qwen" },
                    { value: "deepseek", label: "deepseek" },
                    { value: "gemini", label: "gemini" }
                  ]}
                />
                <Select
                  label="状态"
                  value={filters.status}
                  onChange={(value) => setFilters((prev) => ({ ...prev, status: value ?? "all" }))}
                  data={[
                    { value: "all", label: "all" },
                    { value: "success", label: "success" },
                    { value: "failed", label: "failed" },
                    { value: "pending", label: "pending" }
                  ]}
                />
                <TextInput
                  label="工具"
                  placeholder="fs.read"
                  value={filters.tool}
                  onChange={(event) => setFilters((prev) => ({ ...prev, tool: event.currentTarget.value }))}
                />
                <TextInput
                  label="关键字"
                  placeholder="path/audit"
                  value={filters.keyword}
                  onChange={(event) => setFilters((prev) => ({ ...prev, keyword: event.currentTarget.value }))}
                />
              </SimpleGrid>
              <Group justify="flex-end" mb="sm">
                <Button size="xs" variant="light" onClick={() => void loadConsole()}>
                  应用过滤
                </Button>
                <Button size="xs" variant="light" onClick={() => void exportConsoleEvents()}>
                  导出当前筛选
                </Button>
                <Button size="xs" color="red" variant="light" onClick={() => void clearConsoleEvents()}>
                  清空日志
                </Button>
              </Group>

              {events.length === 0 ? (
                <Text size="sm" c="dimmed">
                  暂无记录。
                </Text>
              ) : (
                <Accordion multiple>
                  {events.map((event) => (
                    <Accordion.Item key={event.id} value={event.id}>
                      <Accordion.Control>
                        <Group justify="space-between" wrap="nowrap">
                          <Text size="sm" fw={600}>
                            {event.method}
                            {event.tool ? `:${event.tool}` : ""}
                          </Text>
                          <Group gap={8}>
                            <Badge color={statusColor(event.status)} variant="light">
                              {event.status}
                            </Badge>
                            <Badge color={ageColor(event.timestamp)} variant="light">
                              {new Date(event.timestamp).toLocaleString()}
                            </Badge>
                            <Text size="xs" c="dimmed">
                              {event.site} · {event.durationMs ?? "-"}ms
                            </Text>
                          </Group>
                        </Group>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Box>
                          {event.status === "pending" && getPendingConfirmationIdFromEvent(event) ? (
                            <Card withBorder p="sm" mb="sm">
                              <Stack gap={8}>
                                <Text size="sm" fw={600}>
                                  待审批操作
                                </Text>
                                <Text size="xs" c="dimmed">
                                  confirmationId: {getPendingConfirmationIdFromEvent(event)}
                                </Text>
                                <Group gap="xs">
                                  <Button
                                    size="xs"
                                    color="green"
                                    onClick={() => void decide(getPendingConfirmationIdFromEvent(event), true, false)}
                                  >
                                    Approve
                                  </Button>
                                  <Button
                                    size="xs"
                                    color="blue"
                                    onClick={() => void decide(getPendingConfirmationIdFromEvent(event), true, true)}
                                  >
                                    Always Allow
                                  </Button>
                                  <Button
                                    size="xs"
                                    color="red"
                                    variant="light"
                                    onClick={() => void decide(getPendingConfirmationIdFromEvent(event), false, false)}
                                  >
                                    Reject
                                  </Button>
                                </Group>
                              </Stack>
                            </Card>
                          ) : null}
                          <pre style={{ margin: 0, overflowX: "auto", whiteSpace: "pre-wrap", fontSize: 12 }}>
                            {JSON.stringify({ request: event.request, response: event.response }, null, 2)}
                          </pre>
                        </Box>
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                </Accordion>
              )}
            </Card>
          </Stack>
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

function statusColor(status) {
  if (status === "success" || status === "approved") return "green";
  if (status === "pending") return "blue";
  return "red";
}

function ageColor(timestamp) {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) {
    return "gray";
  }
  const age = Date.now() - ts;
  if (age <= 5 * 60 * 1000) return "green";
  if (age <= 24 * 60 * 60 * 1000) return "yellow";
  return "red";
}

function getPendingConfirmationIdFromEvent(event) {
  if (!event || typeof event !== "object") {
    return "";
  }
  const response = event.response;
  if (!response || typeof response !== "object") {
    return "";
  }
  const result = response.result;
  if (!result || typeof result !== "object") {
    return "";
  }
  const meta = result.meta;
  if (!meta || typeof meta !== "object") {
    return "";
  }
  const id = meta.pendingConfirmationId;
  return typeof id === "string" ? id : "";
}

function clampNumber(input, min, max, fallback) {
  const value = Number(input);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}
