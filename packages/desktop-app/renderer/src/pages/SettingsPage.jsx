import {
  Accordion,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title
} from "@mantine/core";

export default function SettingsPage({ state, actions, constants }) {
  const {
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
  } = state;

  const {
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
  } = actions;

  const { MANAGED_SITES, CONFIRMATION_REQUIRED_TOOLS } = constants;

  return (
    <Card withBorder>
      <Accordion multiple defaultValue={["app", "bridge", "policy", "sites", "console"]}>
        <Accordion.Item value="app">
          <Accordion.Control>
            <Title order={4}>应用配置</Title>
          </Accordion.Control>
          <Accordion.Panel>
            <SimpleGrid cols={{ base: 1, md: 2 }}>
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
            </SimpleGrid>
            <Group justify="flex-end" mt="sm">
              <Button size="xs" onClick={() => void saveConfig({ logRetentionDays: appConfig.logRetentionDays, servicePort: appConfig.servicePort })}>
                保存应用配置
              </Button>
            </Group>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="bridge">
          <Accordion.Control>
            <Title order={4}>Bridge 配置</Title>
          </Accordion.Control>
          <Accordion.Panel>
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <TextInput
                label="Bridge 去重上限"
                type="number"
                min={1000}
                max={1000000}
                value={String(appConfig.bridge?.dedupeMaxEntries ?? 100000)}
                onChange={(event) =>
                  setAppConfig((prev) => ({
                    ...prev,
                    bridge: {
                      ...(prev.bridge ?? {}),
                      dedupeMaxEntries: clampNumber(event.currentTarget.value, 1000, 1000000, 100000)
                    }
                  }))
                }
              />
              <TextInput
                label="Bridge 会话回放条数"
                type="number"
                min={20}
                max={2000}
                value={String(appConfig.bridge?.sessionReplayLimit ?? 500)}
                onChange={(event) =>
                  setAppConfig((prev) => ({
                    ...prev,
                    bridge: {
                      ...(prev.bridge ?? {}),
                      sessionReplayLimit: clampNumber(event.currentTarget.value, 20, 2000, 500)
                    }
                  }))
                }
              />
              <TextInput
                label="Bridge 离线队列上限/会话"
                type="number"
                min={20}
                max={1000}
                value={String(appConfig.bridge?.offlineQueuePerSession ?? 200)}
                onChange={(event) =>
                  setAppConfig((prev) => ({
                    ...prev,
                    bridge: {
                      ...(prev.bridge ?? {}),
                      offlineQueuePerSession: clampNumber(event.currentTarget.value, 20, 1000, 200)
                    }
                  }))
                }
              />
              <Select
                label="默认工具拦截模式"
                value={appConfig.bridge?.toolInterceptDefault ?? "auto"}
                onChange={(value) =>
                  setAppConfig((prev) => ({
                    ...prev,
                    bridge: {
                      ...(prev.bridge ?? {}),
                      toolInterceptDefault: value === "manual" ? "manual" : "auto"
                    }
                  }))
                }
                data={[
                  { value: "auto", label: "auto" },
                  { value: "manual", label: "manual" }
                ]}
              />
              <TextInput
                label="确认等待超时(ms)"
                type="number"
                min={5000}
                max={600000}
                value={String(appConfig.bridge?.confirmationWaitTimeoutMs ?? 125000)}
                onChange={(event) =>
                  setAppConfig((prev) => ({
                    ...prev,
                    bridge: {
                      ...(prev.bridge ?? {}),
                      confirmationWaitTimeoutMs: clampNumber(event.currentTarget.value, 5000, 600000, 125000)
                    }
                  }))
                }
              />
              <TextInput
                label="确认轮询间隔(ms)"
                type="number"
                min={200}
                max={10000}
                value={String(appConfig.bridge?.confirmationPollIntervalMs ?? 1200)}
                onChange={(event) =>
                  setAppConfig((prev) => ({
                    ...prev,
                    bridge: {
                      ...(prev.bridge ?? {}),
                      confirmationPollIntervalMs: clampNumber(event.currentTarget.value, 200, 10000, 1200)
                    }
                  }))
                }
              />
            </SimpleGrid>
            <Group justify="flex-end" mt="sm">
              <Button
                size="xs"
                onClick={() =>
                  void saveConfig({
                    bridge: appConfig.bridge
                  })
                }
              >
                保存 Bridge 配置
              </Button>
            </Group>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="policy">
          <Accordion.Control>
            <Title order={4}>策略管理</Title>
          </Accordion.Control>
          <Accordion.Panel>
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
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="sites">
          <Accordion.Control>
            <Title order={4}>站点与确认</Title>
          </Accordion.Control>
          <Accordion.Panel>
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <Card withBorder>
                <Title order={5} mb="sm">
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
                <Title order={5} mb="sm">
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
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="console">
          <Accordion.Control>
            <Title order={4}>请求控制台</Title>
          </Accordion.Control>
          <Accordion.Panel>
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
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Card>
  );
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
