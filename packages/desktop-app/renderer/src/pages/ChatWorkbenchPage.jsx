import { Card, Stack, Text } from "@mantine/core";
import BridgeWorkspace from "../BridgeWorkspace.jsx";

export default function ChatWorkbenchPage({
  apiBase,
  sessionReplayLimit,
  notice,
  error,
  onPendingCountChange
}) {
  return (
    <Stack gap="md" className="flycode-chat-page">
      {(notice || error) && (
        <Card withBorder>
          {notice ? <Text c="green">{notice}</Text> : null}
          {error ? <Text c="red">{error}</Text> : null}
        </Card>
      )}

      <BridgeWorkspace
        apiBase={apiBase}
        sessionReplayLimit={sessionReplayLimit}
        onPendingCountChange={onPendingCountChange}
      />
    </Stack>
  );
}
