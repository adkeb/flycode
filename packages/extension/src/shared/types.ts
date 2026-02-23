/**
 * FlyCode Note: Extension MCP message contracts
 * Defines settings and runtime messages for MCP-only bridge execution.
 */
import type {
  ConfirmationEntry,
  McpRequestEnvelope,
  McpResponseEnvelope,
  SiteId,
  SiteKeysResponse
} from "@flycode/shared-types";

type KnownSiteId = Exclude<SiteId, "unknown">;

export interface ExtensionSettings {
  appBaseUrl: string;
  maxInjectTokens: number;
  autoToolEnabled: boolean;
  autoToolAutoSend: boolean;
  compactResultDisplayEnabled: boolean;
  debugLoggingEnabled: boolean;
  siteKeys: Partial<Record<KnownSiteId, string>>;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  appBaseUrl: "http://127.0.0.1:39393",
  maxInjectTokens: 12_000,
  autoToolEnabled: true,
  autoToolAutoSend: true,
  compactResultDisplayEnabled: true,
  debugLoggingEnabled: false,
  siteKeys: {}
};

export interface ExecuteMcpRequest {
  type: "FLYCODE_MCP_EXECUTE";
  site: SiteId;
  envelope: McpRequestEnvelope;
}

export interface ExecuteMcpResponse {
  ok: boolean;
  response?: McpResponseEnvelope;
  message?: string;
}

export interface PollConfirmationRequest {
  type: "FLYCODE_CONFIRMATION_GET";
  id: string;
}

export interface PollConfirmationResponse {
  ok: boolean;
  confirmation?: ConfirmationEntry;
  message?: string;
}

export interface GetSettingsRequest {
  type: "FLYCODE_GET_SETTINGS";
}

export interface SaveSettingsRequest {
  type: "FLYCODE_SAVE_SETTINGS";
  settings: Partial<ExtensionSettings>;
}

export interface CheckAppStatusRequest {
  type: "FLYCODE_APP_STATUS";
}

export interface SyncSiteKeysRequest {
  type: "FLYCODE_SYNC_SITE_KEYS";
}

export interface ReloadTabsRequest {
  type: "FLYCODE_RELOAD_TABS";
}

export interface AppStatusResponse {
  ok: boolean;
  connected: boolean;
  health?: unknown;
  message?: string;
}

export interface SyncSiteKeysResponse {
  ok: boolean;
  keys?: SiteKeysResponse;
  settings?: ExtensionSettings;
  message?: string;
}

export type RuntimeMessage =
  | ExecuteMcpRequest
  | PollConfirmationRequest
  | GetSettingsRequest
  | SaveSettingsRequest
  | CheckAppStatusRequest
  | SyncSiteKeysRequest
  | ReloadTabsRequest;
