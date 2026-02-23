/**
 * FlyCode Note: MCP request parser
 * Extracts JSON-RPC MCP request from markdown fenced blocks and validates minimal structure.
 */
import type { McpRequestEnvelope } from "@flycode/shared-types";

export interface ParsedMcpBlock {
  id: string;
  envelope: McpRequestEnvelope;
  requestHash: string;
  rawText: string;
}

export function parseMcpRequestBlock(raw: string): ParsedMcpBlock | null {
  const normalized = normalize(raw);
  if (!normalized) {
    return null;
  }

  const payload = extractPayload(normalized);
  if (!payload) {
    return null;
  }

  let envelope: McpRequestEnvelope;
  try {
    envelope = JSON.parse(payload) as McpRequestEnvelope;
  } catch {
    return null;
  }

  if (envelope.jsonrpc !== "2.0" || (envelope.method !== "initialize" && envelope.method !== "tools/list" && envelope.method !== "tools/call")) {
    return null;
  }

  const id = typeof envelope.id === "string" || typeof envelope.id === "number" ? String(envelope.id) : "";
  if (!id) {
    return null;
  }

  const canonical = JSON.stringify({
    jsonrpc: envelope.jsonrpc,
    id: envelope.id,
    method: envelope.method,
    params: envelope.params ?? null
  });

  return {
    id,
    envelope,
    requestHash: hashText(canonical),
    rawText: normalized
  };
}

function normalize(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim();
}

function extractPayload(text: string): string | null {
  const fenced = text.match(/^```mcp-request\s*\n([\s\S]*?)\n```$/i);
  if (fenced) {
    return normalizeJsonPayload(fenced[1]);
  }

  // DeepSeek 常见文本形态：代码块内容是首行 "mcp-request" + 下一行 JSON（无 ``` 文本）
  const plainHeader = text.match(/^mcp-request\s*\n([\s\S]+)$/i);
  if (plainHeader) {
    return normalizeJsonPayload(plainHeader[1]);
  }

  // 容错：某些站点在 pre 文本里混入了其他字符，尝试提取 JSON 主体。
  return normalizeJsonPayload(text);
}

function normalizeJsonPayload(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // 兼容 “json\\n{...}” 形式
  const jsonLang = trimmed.match(/^json\s*\n([\s\S]+)$/i);
  if (jsonLang) {
    return normalizeJsonPayload(jsonLang[1]);
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
