import { Badge, Button, Group, Select, Text, Title } from "@mantine/core";
import { IconRefresh, IconTerminal2 } from "@tabler/icons-react";

export default function TopStatusBar({
  healthConnected,
  healthError,
  healthCheckedAt,
  theme,
  onChangeTheme,
  onRefresh,
  busy,
  route
}) {
  return (
    <Group justify="space-between" h="100%" px="md">
      <Group gap="sm">
        <IconTerminal2 size={20} />
        <div>
          <Title order={4}>FlyCode Desktop</Title>
          <Text size="xs" c="dimmed">
            {route === "chat" ? "聊天工作台" : "设置中心"}
          </Text>
        </div>
      </Group>

      <Group gap="sm">
        <Badge color={healthConnected ? "teal" : "red"} variant="light">
          {healthConnected ? "服务在线" : "服务离线"}
        </Badge>
        {!healthConnected && healthError ? (
          <Text size="xs" c="red" maw={240} truncate>
            {healthError}
          </Text>
        ) : null}
        <Text size="xs" c="dimmed">
          {healthCheckedAt ? new Date(healthCheckedAt).toLocaleTimeString() : "未检查"}
        </Text>

        <Select
          value={theme}
          onChange={(value) => onChangeTheme(value ?? "system")}
          data={[
            { value: "system", label: "跟随系统" },
            { value: "light", label: "浅色" },
            { value: "dark", label: "深色" }
          ]}
          w={120}
          size="xs"
        />

        <Button size="xs" leftSection={<IconRefresh size={14} />} onClick={onRefresh} loading={busy}>
          刷新
        </Button>
      </Group>
    </Group>
  );
}
