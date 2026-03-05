/**
 * FlyCode Note: Desktop health API client (capture-only mode)
 */
import type { ExtensionSettings } from "../shared/types.js";

export async function fetchHealth(settings: ExtensionSettings): Promise<unknown> {
  return fetchJson<unknown>(`${settings.appBaseUrl}/v1/health`, {
    method: "GET"
  });
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
