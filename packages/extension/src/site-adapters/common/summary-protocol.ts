/**
 * FlyCode Note: Shared protocol summary parser
 * Parses mcp-response / legacy flycode result payloads into compact summary-friendly data.
 */
import type { McpResponseEnvelope } from "@flycode/shared-types";
import type { AssistantBlockKind } from "./types.js";
import { normalizeBlockText } from "./text-normalize.js";

export type SummaryStatus = "成功" | "失败" | "等待确认";

export interface ParsedMcpResponseSummary {
  id?: string;
  status: SummaryStatus;
}

export interface ParsedFlycodeResultSummary {
  status: Extract<SummaryStatus, "成功" | "失败">;
  command: string;
}

export function parseMcpResponseSummary(rawText: string, kind: AssistantBlockKind): ParsedMcpResponseSummary | null {
  const payloads = extractMcpResponsePayloads(rawText, kind);
  if (payloads.length === 0) {
    return null;
  }

  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    const payload = payloads[i];
    if (!payload) {
      continue;
    }
    let parsed: McpResponseEnvelope | null = null;
    try {
      parsed = JSON.parse(payload) as McpResponseEnvelope;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || parsed.jsonrpc !== "2.0") {
      continue;
    }
    if (!("result" in parsed) && !("error" in parsed)) {
      continue;
    }

    const idValue = parsed.id;
    const id = typeof idValue === "string" || typeof idValue === "number" ? String(idValue) : undefined;
    const pendingId = getPendingConfirmationId(parsed);
    const status: SummaryStatus = pendingId ? "等待确认" : parsed.error ? "失败" : "成功";
    return { id, status };
  }

  return null;
}

export function parseFlycodeResultSummary(rawText: string, kind: AssistantBlockKind): ParsedFlycodeResultSummary | null {
  const body = extractLegacyFlycodeResultBody(rawText, kind);
  if (!body) {
    return null;
  }

  const command = extractTaggedLine(body, "command") ?? "unknown";
  const okValue = extractTaggedLine(body, "ok");
  const status = okValue && okValue.trim().toLowerCase().startsWith("true") ? "成功" : "失败";
  return { status, command };
}

export function isFlycodeUploadPayload(rawText: string, kind: AssistantBlockKind): boolean {
  if (kind === "flycode-upload") {
    return true;
  }
  const raw = normalizeBlockText(rawText);
  if (!raw) {
    return false;
  }
  if (/^`{3,}\s*flycode-upload\s*\n[\s\S]*\n`{3,}\s*$/i.test(raw)) {
    return true;
  }
  if (/^`{3,}\s*flycode-upload\s*\n[\s\S]+$/i.test(raw)) {
    return true;
  }
  return /^flycode-upload\s*\n[\s\S]+$/i.test(raw);
}

export function formatSummary(status: SummaryStatus, command: string): string {
  return [`状态：${status}`, `命令：${command}`].join("\n");
}

function extractMcpResponsePayloads(rawText: string, kind: AssistantBlockKind): string[] {
  const raw = normalizeBlockText(rawText);
  if (!raw) {
    return [];
  }

  const payloads: string[] = [];
  const fencedPattern = /`{3,}\s*mcp-response\s*\n([\s\S]*?)(?:\n`{3,}\s*|$)/gi;
  let fencedMatch: RegExpExecArray | null = fencedPattern.exec(raw);
  while (fencedMatch) {
    const normalized = normalizeJsonPayload(fencedMatch[1] ?? "");
    if (normalized) {
      payloads.push(normalized);
    }
    fencedMatch = fencedPattern.exec(raw);
  }
  if (payloads.length > 0) {
    return payloads;
  }

  const openFenceOnly = raw.match(/^`{3,}\s*mcp-response\s*\n([\s\S]+)$/i);
  if (openFenceOnly) {
    const normalized = normalizeJsonPayload(openFenceOnly[1]);
    return normalized ? [normalized] : [];
  }

  const plainHeader = raw.match(/^mcp-response\s*\n([\s\S]+)$/i);
  if (plainHeader) {
    const normalized = normalizeJsonPayload(plainHeader[1]);
    return normalized ? [normalized] : [];
  }

  const normalized = normalizeJsonPayload(raw);
  if (!normalized) {
    return [];
  }

  // When adapter already classified this as mcp-response, accept JSON body directly.
  if (kind === "mcp-response") {
    return [normalized];
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.jsonrpc !== "2.0") {
    return [];
  }
  if (!("result" in envelope) && !("error" in envelope)) {
    return [];
  }
  return [normalized];
}

function extractLegacyFlycodeResultBody(rawText: string, kind: AssistantBlockKind): string | null {
  const raw = normalizeBlockText(rawText);
  if (!raw) {
    return null;
  }

  const fenced = raw.match(/^`{3,}\s*flycode-result\s*\n([\s\S]*?)\n`{3,}\s*$/i);
  if (fenced) {
    return fenced[1];
  }

  const openFenceOnly = raw.match(/^`{3,}\s*flycode-result\s*\n([\s\S]+)$/i);
  if (openFenceOnly) {
    return openFenceOnly[1];
  }

  const plainHeader = raw.match(/^flycode-result\s*\n([\s\S]+)$/i);
  if (plainHeader) {
    return plainHeader[1];
  }

  if (kind !== "flycode-result") {
    return null;
  }

  if (/\[command\]/i.test(raw) || /\[ok\]/i.test(raw)) {
    return raw;
  }
  return null;
}

function extractTaggedLine(body: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\[${escaped}\\]\\s*(.+)$`, "im");
  const match = body.match(pattern);
  return match ? match[1].trim() : null;
}

function normalizeJsonPayload(input: string): string | null {
  const trimmed = normalizeBlockText(input);
  if (!trimmed) {
    return null;
  }

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

function getPendingConfirmationId(response: McpResponseEnvelope): string | null {
  const result = response.result as { meta?: { pendingConfirmationId?: unknown } } | undefined;
  if (!result || !result.meta || typeof result.meta.pendingConfirmationId !== "string") {
    return null;
  }
  return result.meta.pendingConfirmationId;
}
