import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Divider,
  Drawer,
  Group,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip
} from "@mantine/core";
import {
  IconArrowDown,
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
  IconMessageCircle,
  IconSend,
  IconTrash,
  IconSparkles
} from "@tabler/icons-react";

const BRIDGE_PROTOCOL_VERSION = 4;

function buildWsUrl(apiBase) {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/bridge/ws";
  url.searchParams.set("role", "app");
  return url.toString();
}

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function upsertSession(list, next) {
  const index = list.findIndex((item) => item.sessionId === next.sessionId);
  if (index < 0) {
    return [next, ...list].sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
  }

  const merged = [...list];
  merged[index] = {
    ...merged[index],
    ...next
  };
  return merged.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
}

function appendMessage(messagesBySession, sessionId, record, replayLimit) {
  const current = messagesBySession[sessionId] ?? [];
  const normalizedSource = normalizeDisplaySource(record?.source);
  const shouldMarkLocalEcho =
    normalizedSource === "user" &&
    (record?.meta?.localEcho === true || record?.source === "app" || record?.eventType === "bridge.chat.send");
  const incoming = {
    ...record,
    source: normalizedSource,
    meta: shouldMarkLocalEcho
      ? {
          ...(record?.meta ?? {}),
          localEcho: true
        }
      : record?.meta,
    text: normalizeText(record?.text ?? "")
  };
  if (incoming.source === "user" && isLikelyToolEchoUserPayload(incoming.text)) {
    return messagesBySession;
  }
  if (!incoming.text) {
    return messagesBySession;
  }

  const next = [...current];
  const byIdIndex = next.findIndex((item) => item.id === incoming.id);
  if (byIdIndex >= 0) {
    next[byIdIndex] = mergeMessageRow(next[byIdIndex], incoming);
  } else if (incoming.source === "user") {
    const mirrorIndex = findLatestUserEcho(next, incoming.text);
    if (mirrorIndex >= 0) {
      const currentMirror = next[mirrorIndex];
      next[mirrorIndex] = {
        ...currentMirror,
        status: "done",
        createdAt: incoming.createdAt || currentMirror.createdAt
      };
    } else if (!hasCloseDuplicate(next, incoming)) {
      next.push(incoming);
    }
  } else if (!hasCloseDuplicate(next, incoming)) {
    next.push(incoming);
  }

  const safeLimit = Math.max(20, Math.min(2000, Number(replayLimit) || 500));
  return {
    ...messagesBySession,
    [sessionId]: next.slice(-safeLimit)
  };
}

function updateMessageStatus(messagesBySession, sessionId, messageId, ok, reason) {
  const list = messagesBySession[sessionId] ?? [];
  const nextStatus = ok ? "sent" : "failed";
  return {
    ...messagesBySession,
    [sessionId]: list.map((item) => {
      if (item.id !== messageId) {
        return item;
      }
      return {
        ...item,
        status: mergeMessageStatus(item.status, nextStatus),
        meta: {
          ...(item.meta ?? {}),
          reason
        }
      };
    })
  };
}

function mergeMessageRow(current, incoming) {
  const mergedMeta = {
    ...(current?.meta ?? {}),
    ...(incoming?.meta ?? {})
  };
  return {
    ...current,
    ...incoming,
    meta: Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined,
    status: mergeMessageStatus(current?.status, incoming?.status)
  };
}

function mergeMessageStatus(current, incoming) {
  if (current === "done" || incoming === "done") {
    return "done";
  }
  if (current === "failed" || incoming === "failed") {
    return "failed";
  }
  if (current === "sent" || incoming === "sent") {
    return "sent";
  }
  if (current === "queued" || incoming === "queued") {
    return "queued";
  }
  return incoming ?? current ?? "done";
}

function findLatestUserEcho(list, incomingText) {
  const normalized = normalizeText(incomingText);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const row = list[index];
    const isLegacyApp = row?.source === "app";
    const isLocalEchoUser = row?.source === "user" && row?.meta?.localEcho === true;
    const isChatSendUser = row?.source === "user" && row?.eventType === "bridge.chat.send";
    if (!isLegacyApp && !isLocalEchoUser && !isChatSendUser) {
      continue;
    }
    if (normalizeText(row.text) !== normalized) {
      continue;
    }
    if (row.status === "queued" || row.status === "sent") {
      return index;
    }
  }
  return -1;
}

function hasCloseDuplicate(list, incoming) {
  const incomingTs = Date.parse(String(incoming.createdAt ?? ""));
  return list.some((item) => {
    if (item.id === incoming.id) {
      return true;
    }
    if (item.source !== incoming.source) {
      return false;
    }
    if (normalizeText(item.text) !== normalizeText(incoming.text)) {
      return false;
    }
    const ts = Date.parse(String(item.createdAt ?? ""));
    if (!Number.isFinite(incomingTs) || !Number.isFinite(ts)) {
      return true;
    }
    return Math.abs(ts - incomingTs) <= 1600;
  });
}

function normalizeMessagesBySession(input, replayLimit) {
  let out = {};
  if (!input || typeof input !== "object") {
    return out;
  }
  for (const [sessionId, records] of Object.entries(input)) {
    if (!Array.isArray(records)) {
      continue;
    }
    for (const record of records) {
      if (!record || typeof record !== "object") {
        continue;
      }
      out = appendMessage(out, sessionId, record, replayLimit);
    }
  }
  return out;
}

function prettyJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function normalizeText(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim();
}

function normalizeDisplaySource(source) {
  return source === "app" ? "user" : source;
}

function isLikelyToolEchoUserPayload(text) {
  const source = String(text ?? "");
  return /\{\s*"jsonrpc"\s*:\s*"2\.0"/i.test(source) || /"jsonrpc"\s*:\s*"2\.0"/i.test(source);
}

function parseFencedBlocks(text) {
  const source = String(text ?? "");
  if (!source.includes("```")) {
    return [{ type: "text", content: source }];
  }

  const lines = source.split("\n");
  const blocks = [];
  let inCode = false;
  let lang = "";
  let buffer = [];

  for (const line of lines) {
    const fence = line.match(/^```\s*(.*)$/);
    if (fence) {
      if (!inCode) {
        if (buffer.length > 0) {
          blocks.push({ type: "text", content: buffer.join("\n") });
          buffer = [];
        }
        inCode = true;
        lang = fence[1]?.trim() ?? "";
      } else {
        blocks.push({ type: "code", content: buffer.join("\n"), lang });
        buffer = [];
        inCode = false;
        lang = "";
      }
      continue;
    }
    buffer.push(line);
  }

  if (buffer.length > 0) {
    blocks.push({ type: inCode ? "code" : "text", content: buffer.join("\n"), lang });
  }

  return blocks;
}

function renderInlineMarkdown(text, keyPrefix) {
  const source = String(text ?? "");
  if (!source) {
    return null;
  }
  const parts = [];
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|\*[^*\n]+\*)/g;
  let last = 0;
  let match;
  let index = 0;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > last) {
      parts.push(source.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      const value = token.slice(2, -2);
      parts.push(
        <strong key={`${keyPrefix}-b-${index}`} style={{ fontWeight: 700 }}>
          {value}
        </strong>
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      const value = token.slice(1, -1);
      parts.push(
        <em key={`${keyPrefix}-i-${index}`} style={{ fontStyle: "italic" }}>
          {value}
        </em>
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      const value = token.slice(1, -1);
      parts.push(
        <code key={`${keyPrefix}-c-${index}`} style={{ background: "#eaf1ed", padding: "1px 6px", borderRadius: 6 }}>
          {value}
        </code>
      );
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/i);
      if (link) {
        parts.push(
          <a key={`${keyPrefix}-a-${index}`} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
      } else {
        parts.push(token);
      }
    }
    last = match.index + token.length;
    index += 1;
  }
  if (last < source.length) {
    parts.push(source.slice(last));
  }
  return parts;
}

function renderMarkdownTextBlock(content, keyPrefix) {
  const lines = String(content ?? "").split("\n");
  const nodes = [];
  let idx = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    const joined = paragraph.join("\n");
    nodes.push(
      <Text key={`${keyPrefix}-p-${idx}`} size="sm" className="flycode-message-text">
        {renderInlineMarkdown(joined, `${keyPrefix}-p-${idx}`)}
      </Text>
    );
    idx += 1;
    paragraph = [];
  };

  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      lineIndex += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = Math.max(1, Math.min(6, heading[1].length));
      nodes.push(
        <Text key={`${keyPrefix}-h-${idx}`} className={`flycode-md-heading level-${level}`}>
          {renderInlineMarkdown(heading[2], `${keyPrefix}-h-${idx}`)}
        </Text>
      );
      idx += 1;
      lineIndex += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      nodes.push(<div key={`${keyPrefix}-hr-${idx}`} className="flycode-md-rule" />);
      idx += 1;
      lineIndex += 1;
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const quoteRows = [];
      while (lineIndex < lines.length) {
        const current = (lines[lineIndex] ?? "").trim();
        const row = current.match(/^>\s?(.*)$/);
        if (!row) {
          break;
        }
        quoteRows.push(row[1]);
        lineIndex += 1;
      }
      nodes.push(
        <div key={`${keyPrefix}-q-${idx}`} className="flycode-md-blockquote">
          {quoteRows.map((item, itemIndex) => (
            <Text key={`${keyPrefix}-q-${idx}-${itemIndex}`} size="sm" className="flycode-message-text">
              {renderInlineMarkdown(item, `${keyPrefix}-q-${idx}-${itemIndex}`)}
            </Text>
          ))}
        </div>
      );
      idx += 1;
      continue;
    }

    const listItem = trimmed.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (listItem) {
      flushParagraph();
      const listRows = [];
      while (lineIndex < lines.length) {
        const current = (lines[lineIndex] ?? "").trim();
        const row = current.match(/^([-*]|\d+\.)\s+(.*)$/);
        if (!row) {
          break;
        }
        listRows.push(row[2]);
        lineIndex += 1;
      }
      nodes.push(
        <Stack key={`${keyPrefix}-l-${idx}`} gap={2}>
          {listRows.map((item, itemIndex) => (
            <Text key={`${keyPrefix}-l-${idx}-${itemIndex}`} size="sm" className="flycode-message-text flycode-md-list-item">
              {"• "}
              {renderInlineMarkdown(item, `${keyPrefix}-l-${idx}-${itemIndex}`)}
            </Text>
          ))}
        </Stack>
      );
      idx += 1;
      continue;
    }

    paragraph.push(trimmed);
    lineIndex += 1;
  }

  flushParagraph();
  return nodes;
}

function renderRichMarkdown(markdown, keyPrefix) {
  const blocks = parseFencedBlocks(markdown);
  const out = [];
  let index = 0;
  for (const block of blocks) {
    if (!block || !block.content) {
      continue;
    }
    if (block.type === "code") {
      out.push(
        <div key={`${keyPrefix}-code-wrap-${index}`} className="flycode-message-code-wrap">
          {block.lang ? <div className="flycode-message-code-lang">{block.lang}</div> : null}
          <pre className="flycode-message-code">{block.content}</pre>
        </div>
      );
      index += 1;
      continue;
    }
    const rendered = renderMarkdownTextBlock(block.content, `${keyPrefix}-txt-${index}`);
    if (rendered.length > 0) {
      out.push(...rendered);
      index += 1;
    }
  }
  return out;
}

function MessageBody({ message }) {
  const text = String(message?.text ?? "");
  const thinkText = typeof message?.meta?.thinkText === "string" ? normalizeText(message.meta.thinkText) : "";
  const answerMarkdown = typeof message?.meta?.answerMarkdown === "string" ? normalizeText(message.meta.answerMarkdown) : "";
  const webReadSummary = typeof message?.meta?.webReadSummary === "string" ? normalizeText(message.meta.webReadSummary) : "";
  const blocks = parseFencedBlocks(text);
  if (message?.source === "tool") {
    return (
      <details>
        <summary style={{ cursor: "pointer", fontSize: "12px", color: "#4b6355", fontWeight: 600 }}>
          工具返回（{text.length} 字，点击展开）
        </summary>
        <Stack gap={6} mt={6}>
          {blocks.map((block, index) => {
            if (block.type === "code") {
              return (
                <pre key={`tool-code-${index}`} className="flycode-message-code">
                  {block.content}
                </pre>
              );
            }
            return (
              <Text key={`tool-text-${index}`} size="sm" className="flycode-message-text">
                {block.content}
              </Text>
            );
          })}
        </Stack>
      </details>
    );
  }
  return (
    <Stack gap={6}>
      {webReadSummary ? (
        <Badge size="xs" variant="light" color="indigo" className="flycode-webread-summary" style={{ width: "fit-content" }}>
          {webReadSummary}
        </Badge>
      ) : null}
      {thinkText ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: "12px", color: "#4b6355", fontWeight: 600 }}>思考过程（think）</summary>
          <pre className="flycode-message-code" style={{ marginTop: "6px" }}>
            {thinkText}
          </pre>
        </details>
      ) : null}
      {message?.source === "assistant" && answerMarkdown
        ? renderRichMarkdown(answerMarkdown, `assistant-${message.id || message.createdAt}`)
        : blocks.map((block, index) => {
            if (block.type === "code") {
              return (
                <pre key={`code-${index}`} className="flycode-message-code">
                  {block.content}
                </pre>
              );
            }
            return (
              <Text key={`text-${index}`} size="sm" className="flycode-message-text">
                {block.content}
              </Text>
            );
          })}
    </Stack>
  );
}

export default function BridgeWorkspace({
  apiBase,
  sessionReplayLimit,
  onPendingCountChange
}) {
  const wsRef = useRef(null);
  const reconnectTimer = useRef(undefined);
  const reconnectAttempts = useRef(0);
  const messageListRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [wsError, setWsError] = useState("");
  const [sessions, setSessions] = useState([]);
  const [messagesBySession, setMessagesBySession] = useState({});
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [draft, setDraft] = useState("");
  const [deletingSessionId, setDeletingSessionId] = useState("");
  const [pending, setPending] = useState([]);
  const [selectedPendingId, setSelectedPendingId] = useState("");
  const [pendingEditorValue, setPendingEditorValue] = useState("");
  const [pendingEditorError, setPendingEditorError] = useState("");
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [drawerOpened, setDrawerOpened] = useState(false);
  const [sessionPaneCollapsed, setSessionPaneCollapsed] = useState(false);

  const selectedSession = useMemo(
    () => sessions.find((item) => item.sessionId === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  );

  const selectedMessages = selectedSessionId ? messagesBySession[selectedSessionId] ?? [] : [];
  const selectedPending = useMemo(
    () => pending.find((item) => item.pendingId === selectedPendingId) ?? null,
    [pending, selectedPendingId]
  );

  useEffect(() => {
    if (typeof onPendingCountChange === "function") {
      onPendingCountChange(pending.length);
    }
  }, [onPendingCountChange, pending.length]);

  useEffect(() => {
    if (pending.length === 0) {
      if (selectedPendingId) {
        setSelectedPendingId("");
        setPendingEditorValue("");
        setPendingEditorError("");
      }
      return;
    }

    if (!selectedPendingId || !pending.some((item) => item.pendingId === selectedPendingId)) {
      const first = pending[0];
      if (!first) {
        return;
      }
      setSelectedPendingId(first.pendingId);
      setPendingEditorValue(prettyJson(first.envelope));
      setPendingEditorError("");
    }
  }, [pending, selectedPendingId]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };

    function connect() {
      const socket = new WebSocket(buildWsUrl(apiBase));
      wsRef.current = socket;

      socket.addEventListener("open", () => {
        reconnectAttempts.current = 0;
        setWsError("");
        socket.send(
          JSON.stringify({
            type: "bridge.hello",
            role: "app",
            protocolVersion: BRIDGE_PROTOCOL_VERSION
          })
        );
      });

      socket.addEventListener("close", () => {
        setConnected(false);
        scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        setConnected(false);
      });

      socket.addEventListener("message", (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (frame.type === "bridge.hello.ok") {
          setConnected(true);
          return;
        }

        if (frame.type === "bridge.error") {
          setWsError(String(frame.message ?? "bridge error"));
          return;
        }

        if (frame.type === "bridge.snapshot") {
          const sessionsValue = Array.isArray(frame.sessions) ? frame.sessions : [];
          const messagesValue = frame.messagesBySession && typeof frame.messagesBySession === "object" ? frame.messagesBySession : {};
          const pendingBySession = frame.pendingBySession && typeof frame.pendingBySession === "object" ? frame.pendingBySession : {};

          const pendingRows = [];
          for (const value of Object.values(pendingBySession)) {
            if (!Array.isArray(value)) {
              continue;
            }
            for (const item of value) {
              if (!item || typeof item !== "object") {
                continue;
              }
              pendingRows.push(item);
            }
          }

          setSessions(sessionsValue);
          setMessagesBySession(normalizeMessagesBySession(messagesValue, sessionReplayLimit));
          setPending(pendingRows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
          setSelectedSessionId((current) => {
            if (current && sessionsValue.some((item) => item.sessionId === current)) {
              return current;
            }
            return sessionsValue[0]?.sessionId ?? "";
          });

          return;
        }

        if (frame.type === "bridge.session.upsert") {
          if (frame.payload?.session && typeof frame.payload.session.sessionId === "string") {
            setSessions((prev) => upsertSession(prev, frame.payload.session));
          }
          return;
        }

        if (frame.type === "bridge.session.offline") {
          const sessionId = String(frame.payload?.sessionId ?? "");
          const lastActiveAt = String(frame.payload?.lastActiveAt ?? new Date().toISOString());
          if (!sessionId) {
            return;
          }
          setSessions((prev) =>
            prev.map((item) =>
              item.sessionId === sessionId
                ? {
                    ...item,
                    online: false,
                    lastActiveAt
                  }
                : item
            )
          );
          return;
        }

        if (frame.type === "bridge.chat.message") {
          const record = frame.payload?.record;
          if (!record || typeof record !== "object" || typeof record.sessionId !== "string") {
            return;
          }

          setMessagesBySession((prev) => appendMessage(prev, record.sessionId, record, sessionReplayLimit));

          if (frame.payload?.session && typeof frame.payload.session.sessionId === "string") {
            setSessions((prev) => upsertSession(prev, frame.payload.session));
          }
          return;
        }

        if (frame.type === "bridge.chat.send.ack") {
          const sessionId = String(frame.sessionId ?? frame.payload?.sessionId ?? "");
          const messageId = String(frame.payload?.messageId ?? "");
          const ok = frame.payload?.ok === true;
          const reason = typeof frame.payload?.reason === "string" ? frame.payload.reason : undefined;
          if (sessionId && messageId) {
            setMessagesBySession((prev) => updateMessageStatus(prev, sessionId, messageId, ok, reason));
          }
          return;
        }

        if (frame.type === "bridge.tool.pending") {
          const pendingRow = frame.payload;
          if (!pendingRow || typeof pendingRow.pendingId !== "string") {
            return;
          }
          setPending((prev) => {
            if (prev.some((item) => item.pendingId === pendingRow.pendingId)) {
              return prev;
            }
            return [pendingRow, ...prev].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
          });
          return;
        }

        if (frame.type === "bridge.tool.result") {
          const record = frame.payload?.record;
          if (!record || typeof record !== "object" || typeof record.sessionId !== "string") {
            return;
          }
          setMessagesBySession((prev) => appendMessage(prev, record.sessionId, record, sessionReplayLimit));
        }
      });
    }

    function scheduleReconnect() {
      if (reconnectTimer.current) {
        return;
      }
      reconnectAttempts.current += 1;
      const delay = Math.min(12_000, 800 + reconnectAttempts.current * 800);
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = undefined;
        connect();
      }, delay);
    }
  }, [apiBase, sessionReplayLimit]);

  useEffect(() => {
    if (!autoScrollEnabled) {
      return;
    }
    const target = messageListRef.current;
    if (!target) {
      return;
    }
    target.scrollTop = target.scrollHeight;
  }, [selectedMessages, autoScrollEnabled, selectedSessionId]);

  function sendFrame(frame) {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(frame));
    return true;
  }

  function sendChat(text) {
    const normalized = normalizeText(text);
    if (!normalized || !selectedSessionId) {
      return;
    }

    const messageId = randomId();
    const now = new Date().toISOString();

    const sent = sendFrame({
      type: "bridge.chat.send",
      id: randomId(),
      sessionId: selectedSessionId,
      createdAt: now,
      payload: {
        sessionId: selectedSessionId,
        messageId,
        text: normalized
      }
    });

    const record = {
      id: messageId,
      sessionId: selectedSessionId,
      site: selectedSession?.site ?? "qwen",
      source: "user",
      eventType: "bridge.chat.send",
      text: normalized,
      createdAt: now,
      status: sent ? "queued" : "failed",
      meta: sent ? { localEcho: true } : { reason: "socket_not_connected", localEcho: true }
    };

    setMessagesBySession((prev) => appendMessage(prev, selectedSessionId, record, sessionReplayLimit));
    if (sent) {
      setDraft("");
    }
  }

  function handleSend() {
    sendChat(draft);
  }

  async function deleteSession(sessionId) {
    const normalized = String(sessionId ?? "").trim();
    if (!normalized || deletingSessionId) {
      return;
    }

    setDeletingSessionId(normalized);
    setWsError("");

    try {
      const response = await fetch(`${apiBase}/v1/bridge/sessions/${encodeURIComponent(normalized)}`, {
        method: "DELETE"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) {
        throw new Error(String(payload?.message ?? `HTTP ${response.status}`));
      }

      setSessions((prev) => {
        const next = prev.filter((item) => item.sessionId !== normalized);
        setSelectedSessionId((current) => (current === normalized ? next[0]?.sessionId ?? "" : current));
        return next;
      });
      setMessagesBySession((prev) => {
        const next = { ...prev };
        delete next[normalized];
        return next;
      });
      setPending((prev) => prev.filter((item) => item.sessionId !== normalized));
      setSelectedPendingId("");
      setPendingEditorValue("");
      setPendingEditorError("");
    } catch (error) {
      setWsError((error instanceof Error ? error.message : String(error)) || "删除会话失败");
    } finally {
      setDeletingSessionId("");
    }
  }

  function decidePending(decision) {
    if (!selectedPending) {
      return;
    }

    let envelope;
    if (decision === "approve") {
      try {
        envelope = JSON.parse(pendingEditorValue);
      } catch {
        setPendingEditorError("JSON 格式错误，无法批准。");
        return;
      }
      if (!envelope || typeof envelope !== "object") {
        setPendingEditorError("编辑器内容必须是 JSON 对象。");
        return;
      }
      if (envelope.jsonrpc !== "2.0" || typeof envelope.method !== "string") {
        setPendingEditorError("必须是合法 MCP Envelope（至少含 jsonrpc=2.0 与 method）。");
        return;
      }
      setPendingEditorError("");
    }

    sendFrame({
      type: "bridge.tool.pending.resolve",
      id: randomId(),
      sessionId: selectedPending.sessionId,
      createdAt: new Date().toISOString(),
      payload: {
        pendingId: selectedPending.pendingId,
        decision,
        ...(envelope ? { envelope } : {})
      }
    });

    setPending((prev) => prev.filter((item) => item.pendingId !== selectedPending.pendingId));
  }

  function formatSessionLabel(session) {
    return `${session.site} · tab ${session.tabId} · win ${session.windowId}`;
  }

  function messageBubbleClass(message) {
    const source = normalizeDisplaySource(message.source);
    if (source === "user") return "flycode-message-bubble is-user";
    if (source === "assistant") return "flycode-message-bubble is-assistant";
    if (source === "tool") return "flycode-message-bubble is-tool";
    return "flycode-message-bubble is-app";
  }

  return (
    <Card withBorder className="flycode-chat-workspace">
      <Group justify="space-between" align="center" mb="md">
        <Group gap="xs">
          <IconSparkles size={18} />
          <Title order={3}>聊天工作台</Title>
          <Badge color={connected ? "teal" : "red"} variant="light">
            {connected ? "Bridge 已连接" : "Bridge 断开"}
          </Badge>
          {wsError ? (
            <Badge color="red" variant="light">
              {wsError}
            </Badge>
          ) : null}
        </Group>

        <Group gap="sm">
          <Button
            size="xs"
            variant={pending.length > 0 ? "filled" : "light"}
            color={pending.length > 0 ? "orange" : "gray"}
            onClick={() => setDrawerOpened(true)}
          >
            待审批 {pending.length}
          </Button>
        </Group>
      </Group>

      <div className={`flycode-chat-grid ${sessionPaneCollapsed ? "is-session-collapsed" : ""}`}>
        {!sessionPaneCollapsed ? (
        <aside className="flycode-session-pane">
          <Group justify="space-between" mb="xs">
            <Group gap={6}>
              <Text fw={700} size="sm">
                会话
              </Text>
              <Text size="xs" c="dimmed">
                {sessions.length} 个
              </Text>
            </Group>
            <Tooltip label="折叠会话栏">
              <ActionIcon variant="subtle" size="sm" onClick={() => setSessionPaneCollapsed(true)}>
                <IconChevronLeft size={15} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <ScrollArea h="100%" className="flycode-session-scroll">
            <Stack gap={8}>
              {sessions.map((session) => (
                <div
                  key={session.sessionId}
                  role="button"
                  tabIndex={0}
                  className={`flycode-session-item ${session.sessionId === selectedSessionId ? "is-active" : ""}`}
                  onClick={() => setSelectedSessionId(session.sessionId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedSessionId(session.sessionId);
                    }
                  }}
                >
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap={6}>
                    <div className="flycode-session-item-title">{session.title || formatSessionLabel(session)}</div>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      loading={deletingSessionId === session.sessionId}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void deleteSession(session.sessionId);
                      }}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                  <div className="flycode-session-item-sub">{formatSessionLabel(session)}</div>
                  <div className="flycode-session-item-meta">
                    <span className={session.online ? "online" : "offline"}>{session.online ? "在线" : "离线"}</span>
                    <span>{new Date(session.lastActiveAt).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </Stack>
          </ScrollArea>
        </aside>
        ) : null}

        <section className="flycode-chat-main">
          <div className="flycode-chat-head">
            <Group gap={8} align="flex-start">
              {sessionPaneCollapsed ? (
                <Tooltip label="展开会话栏">
                  <ActionIcon variant="light" size="sm" onClick={() => setSessionPaneCollapsed(false)}>
                    <IconChevronRight size={15} />
                  </ActionIcon>
                </Tooltip>
              ) : null}
              <div>
                <Text fw={700}>{selectedSession?.title || "选择会话开始聊天"}</Text>
                <Text size="xs" c="dimmed">
                  {selectedSession ? `${selectedSession.site} · tab ${selectedSession.tabId} · win ${selectedSession.windowId}` : "等待 web 会话连接"}
                </Text>
              </div>
            </Group>
            <Group gap={6}>
              <Tooltip label="跳转到底部">
                <ActionIcon
                  variant="light"
                  onClick={() => {
                    const el = messageListRef.current;
                    if (!el) return;
                    el.scrollTop = el.scrollHeight;
                    setAutoScrollEnabled(true);
                  }}
                >
                  <IconArrowDown size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </div>

          <div
            ref={messageListRef}
            className="flycode-message-list"
            onScroll={(event) => {
              const target = event.currentTarget;
              const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
              setAutoScrollEnabled(distance <= 36);
            }}
          >
            {selectedSessionId ? (
              selectedMessages.length > 0 ? (
                selectedMessages.map((message) => (
                  <div
                    key={message.id || `${message.sessionId}-${message.createdAt}`}
                    className={`flycode-message-row source-${normalizeDisplaySource(message.source)}`}
                  >
                    <div className={messageBubbleClass(message)}>
                      <Group justify="space-between" align="center" mb={6}>
                        <Group gap={6}>
                          <IconMessageCircle size={13} />
                          <Text size="xs" fw={700}>
                            {normalizeDisplaySource(message.source)}
                          </Text>
                        </Group>
                        <Group gap={6}>
                          <Badge
                            size="xs"
                            color={
                              message.status === "failed"
                                ? "red"
                                : message.status === "queued"
                                  ? "yellow"
                                  : message.status === "sent"
                                    ? "teal"
                                    : "gray"
                            }
                            variant="light"
                          >
                            {message.status ?? "done"}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            {new Date(message.createdAt).toLocaleTimeString()}
                          </Text>
                        </Group>
                      </Group>
                      <MessageBody message={message} />
                      {message.status === "failed" ? (
                        <Group gap={6} mt={8}>
                          <IconAlertTriangle size={14} color="#b45309" />
                          <Text size="xs" c="yellow.8">
                            发送失败{typeof message.meta?.reason === "string" ? `：${message.meta.reason}` : ""}
                          </Text>
                        </Group>
                      ) : null}
                    </div>
                  </div>
                ))
              ) : (
                <div className="flycode-empty">当前会话暂无消息。</div>
              )
            ) : (
              <div className="flycode-empty">请选择左侧会话。</div>
            )}
          </div>

          <Divider my="sm" />
          <div className="flycode-composer">
            <Textarea
              minRows={3}
              maxRows={8}
              autosize
              placeholder="输入消息发送到网页 AI。Enter 发送，Shift+Enter 换行。"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
            />
            <Group justify="space-between" mt="xs">
              <Text size="xs" c="dimmed">
                {autoScrollEnabled ? "自动滚动已开启" : "你正在查看历史消息"}
              </Text>
              <Button
                size="xs"
                leftSection={<IconSend size={14} />}
                onClick={handleSend}
                disabled={!selectedSessionId || !connected || !draft.trim()}
              >
                发送
              </Button>
            </Group>
          </div>
        </section>
      </div>

      <Drawer
        opened={drawerOpened}
        onClose={() => setDrawerOpened(false)}
        title="工具待审批"
        position="right"
        size="40%"
      >
        {pending.length === 0 ? (
          <Text size="sm" c="dimmed">
            当前无待审批项。
          </Text>
        ) : (
          <div className="flycode-pending-grid">
            <Card withBorder p="sm">
              <Text size="xs" c="dimmed" mb="xs">
                待审批请求
              </Text>
              <Stack gap={8}>
                {pending.map((item) => (
                  <button
                    type="button"
                    key={item.pendingId}
                    className={`flycode-pending-item ${item.pendingId === selectedPendingId ? "is-active" : ""}`}
                    onClick={() => {
                      setSelectedPendingId(item.pendingId);
                      setPendingEditorValue(prettyJson(item.envelope));
                      setPendingEditorError("");
                    }}
                  >
                    <div>{item.pendingId.slice(0, 10)}</div>
                    <div className="sub">{item.sessionId}</div>
                  </button>
                ))}
              </Stack>
            </Card>

            <Card withBorder p="sm">
              <Text size="xs" c="dimmed" mb="xs">
                可视化编辑器（MCP Envelope JSON）
              </Text>
              {selectedPending ? (
                <>
                  <Text size="xs" mb={6}>
                    Pending: {selectedPending.pendingId}
                  </Text>
                  <Textarea
                    minRows={16}
                    value={pendingEditorValue}
                    onChange={(event) => {
                      setPendingEditorValue(event.currentTarget.value);
                      if (pendingEditorError) {
                        setPendingEditorError("");
                      }
                    }}
                    styles={{
                      input: {
                        fontFamily: "var(--flycode-font-mono, monospace)",
                        fontSize: "12px"
                      }
                    }}
                  />
                  {pendingEditorError ? (
                    <Text size="xs" c="red" mt={6}>
                      {pendingEditorError}
                    </Text>
                  ) : (
                    <Text size="xs" c="dimmed" mt={6}>
                      你可以直接编辑 `tools/call` 参数后再批准执行。
                    </Text>
                  )}

                  <Group mt="sm">
                    <Button
                      size="xs"
                      variant="light"
                      onClick={() => {
                        setPendingEditorValue(prettyJson(selectedPending.envelope));
                        setPendingEditorError("");
                      }}
                    >
                      重置
                    </Button>
                    <Button size="xs" color="green" onClick={() => decidePending("approve")}>
                      批准
                    </Button>
                    <Button size="xs" color="red" variant="light" onClick={() => decidePending("reject")}>
                      拒绝
                    </Button>
                  </Group>
                </>
              ) : (
                <Text size="xs" c="dimmed">
                  请选择一个待审批项。
                </Text>
              )}
            </Card>
          </div>
        )}
      </Drawer>
    </Card>
  );
}
