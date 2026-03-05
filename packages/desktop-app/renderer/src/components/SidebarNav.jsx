import { Badge, NavLink, Stack, Text } from "@mantine/core";
import { IconMessageCircle, IconSettings } from "@tabler/icons-react";

export default function SidebarNav({ route, onNavigate, pendingCount }) {
  return (
    <Stack gap="xs" p="sm" className="flycode-sidebar">
      <div className="flycode-brand">
        <Text fw={800} size="lg">
          FlyCode
        </Text>
        <Text size="xs" c="dimmed">
          Desktop Workbench
        </Text>
      </div>

      <NavLink
        active={route === "chat"}
        label="聊天工作台"
        leftSection={<IconMessageCircle size={16} />}
        rightSection={pendingCount > 0 ? <Badge size="xs" color="orange">{pendingCount}</Badge> : null}
        onClick={() => onNavigate("chat")}
      />

      <NavLink
        active={route === "settings"}
        label="设置中心"
        leftSection={<IconSettings size={16} />}
        onClick={() => onNavigate("settings")}
      />
    </Stack>
  );
}
