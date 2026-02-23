/**
 * FlyCode Note: MCP API client
 * Calls desktop-managed local service for MCP, health, site key sync, and confirmation polling.
 */
import type {
  ConfirmationEntry,
  McpRequestEnvelope,
  McpResponseEnvelope,
  SiteId,
  SiteKeysResponse
} from "@flycode/shared-types";
import type { ExtensionSettings } from "../shared/types.js";

type KnownSiteId = Exclude<SiteId, "unknown">;

export async function callMcp(
  settings: ExtensionSettings,
  site: SiteId,
  envelope: McpRequestEnvelope
): Promise<McpResponseEnvelope> {
  const knownSite = asKnownSite(site);
  const key = settings.siteKeys[knownSite];
  if (!key) {
    throw new Error(`Missing site key for ${knownSite}. Open extension options and sync keys from desktop app.`);
  }

  return fetchJson<McpResponseEnvelope>(`${settings.appBaseUrl}/mcp/${knownSite}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify(envelope)
  });
}

export async function fetchHealth(settings: ExtensionSettings): Promise<unknown> {
  return fetchJson<unknown>(`${settings.appBaseUrl}/v1/health`, {
    method: "GET"
  });
}

export async function fetchSiteKeys(settings: ExtensionSettings): Promise<SiteKeysResponse> {
  const response = await fetchJson<{ ok: boolean; data: SiteKeysResponse }>(`${settings.appBaseUrl}/v1/site-keys`, {
    method: "GET"
  });
  if (!response.ok) {
    throw new Error("Failed to fetch site keys");
  }
  return response.data;
}

export async function getConfirmation(settings: ExtensionSettings, id: string): Promise<ConfirmationEntry> {
  const response = await fetchJson<{ ok: boolean; data: ConfirmationEntry }>(
    `${settings.appBaseUrl}/v1/confirmations/${encodeURIComponent(id)}`,
    {
      method: "GET"
    }
  );
  if (!response.ok) {
    throw new Error("Failed to query confirmation");
  }
  return response.data;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON response from ${url}`);
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

function asKnownSite(site: SiteId): KnownSiteId {
  if (site === "qwen" || site === "deepseek" || site === "gemini") {
    return site;
  }
  throw new Error(`Unsupported site: ${site}`);
}

