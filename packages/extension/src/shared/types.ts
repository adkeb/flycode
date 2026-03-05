/**
 * FlyCode Note: Extension runtime contracts (capture-only bridge mode)
 */

export interface ExtensionSettings {
  appBaseUrl: string;
  maxInjectTokens: number;
  bridgeFrontDedupeLimit: number;
  bridgeOutboundQueueLimit: number;
  bridgePingIntervalMs: number;
  debugLoggingEnabled: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  appBaseUrl: "http://127.0.0.1:39393",
  maxInjectTokens: 12000,
  bridgeFrontDedupeLimit: 3000,
  bridgeOutboundQueueLimit: 200,
  bridgePingIntervalMs: 15000,
  debugLoggingEnabled: false
};

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

export interface ReloadTabsRequest {
  type: "FLYCODE_RELOAD_TABS";
}

export interface GetTabContextRequest {
  type: "FLYCODE_GET_TAB_CONTEXT";
}

export interface AppStatusResponse {
  ok: boolean;
  connected: boolean;
  health?: unknown;
  message?: string;
}

export interface TabContextResponse {
  ok: boolean;
  tabId?: number;
  windowId?: number;
  url?: string;
  title?: string;
  message?: string;
}

export type RuntimeMessage =
  | GetSettingsRequest
  | SaveSettingsRequest
  | CheckAppStatusRequest
  | ReloadTabsRequest
  | GetTabContextRequest;
