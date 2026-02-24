import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Accordion,
  AppShell,
  Badge,
  Box,
  Button,
  Card,
  Code,
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
  const [confirmations, setConfirmations] = useState([]);
  const [siteKeys, setSiteKeys] = useState(null);
  const [events, setEvents] = useState([]);
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
    try {
      await Promise.all([loadHealth(), loadConfirmations(), loadSiteKeys(), loadConsole(), loadAppConfig()]);
    } catch (err) {
      setError((err).message);
    } finally {
      setBusy(false);
    }
  }, [filters.keyword, filters.site, filters.status, filters.tool]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadConfirmations();
      void loadConsole();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [filters.keyword, filters.site, filters.status, filters.tool]);

  async function loadHealth() {
    const value = await getJson("/v1/health");
    setHealth(value);
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

  async function loadConsole() {
    const search = new URLSearchParams();
    search.set("limit", "240");
    if (filters.site) search.set("site", filters.site);
    if (filters.status) search.set("status", filters.status);
    if (filters.tool.trim()) search.set("tool", filters.tool.trim());
    if (filters.keyword.trim()) search.set("keyword", filters.keyword.trim());

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
                {!health ? <Loader size="sm" /> : <Code block>{JSON.stringify(health, null, 2)}</Code>}
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
                          {item.createdAt}
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
                    return (
                      <Card key={site} withBorder p="sm">
                        <Group justify="space-between" mb={6}>
                          <Text fw={600}>{site}</Text>
                          <Button size="xs" variant="light" onClick={() => void rotateKey(site)}>
                            轮换
                          </Button>
                        </Group>
                        <Code block>{row?.key ?? "(empty)"}</Code>
                        <Text size="xs" c="dimmed" mt={4}>
                          rotated: {row?.rotatedAt ?? "-"}
                        </Text>
                        <Box mt="sm">
                          <Switch
                            size="xs"
                            label="该站点全部高风险命令免确认"
                            checked={siteAllAlwaysAllowEnabled(site)}
                            onChange={(event) => void setSiteAllAlwaysAllow(site, event.currentTarget.checked)}
                          />
                        </Box>
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
                            <Text size="xs" c="dimmed">
                              {event.site} · {event.durationMs ?? "-"}ms
                            </Text>
                          </Group>
                        </Group>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Box>
                          <Text size="xs" c="dimmed" mb={6}>
                            {event.timestamp}
                          </Text>
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
                          <Code block>{JSON.stringify({ request: event.request, response: event.response }, null, 2)}</Code>
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
