import type { CommandResult, SiteId } from "@flycode/shared-types";

export interface ExtensionSettings {
  baseUrl: string;
  token: string;
  maxInjectTokens: number;
  confirmWritesEnabled: boolean;
  autoToolEnabled: boolean;
  autoToolAutoSend: boolean;
  autoToolAllowWrite: boolean;
  autoToolMaxCallsPerTurn: number;
  compactResultDisplayEnabled: boolean;
  debugLoggingEnabled: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  baseUrl: "http://127.0.0.1:39393",
  token: "",
  maxInjectTokens: 12_000,
  confirmWritesEnabled: true,
  autoToolEnabled: false,
  autoToolAutoSend: false,
  autoToolAllowWrite: true,
  autoToolMaxCallsPerTurn: 3,
  compactResultDisplayEnabled: true,
  debugLoggingEnabled: false
};

export interface ParsedWriteBatchFile {
  path: string;
  mode?: "overwrite" | "append";
  content: string;
  expectedSha256?: string;
}

export type ParsedCommand =
  | {
      command: "fs.ls";
      path: string;
      depth?: number;
      glob?: string;
      raw: string;
    }
  | {
      command: "fs.mkdir";
      path: string;
      parents?: boolean;
      raw: string;
    }
  | {
      command: "fs.read";
      path: string;
      range?: string;
      line?: number;
      lines?: string;
      encoding?: "utf-8" | "base64" | "hex";
      includeMeta?: boolean;
      raw: string;
    }
  | {
      command: "fs.search";
      path: string;
      query: string;
      regex?: boolean;
      glob?: string;
      limit?: number;
      extensions?: string[];
      minBytes?: number;
      maxBytes?: number;
      mtimeFrom?: string;
      mtimeTo?: string;
      contextLines?: number;
      raw: string;
    }
  | {
      command: "fs.rm";
      path: string;
      recursive?: boolean;
      force?: boolean;
      raw: string;
    }
  | {
      command: "fs.mv";
      fromPath: string;
      toPath: string;
      overwrite?: boolean;
      raw: string;
    }
  | {
      command: "fs.chmod";
      path: string;
      mode: string;
      raw: string;
    }
  | {
      command: "fs.diff";
      leftPath: string;
      rightPath?: string;
      rightContent?: string;
      contextLines?: number;
      raw: string;
    }
  | {
      command: "fs.write";
      path: string;
      mode: "overwrite" | "append";
      content: string;
      expectedSha256?: string;
      raw: string;
    }
  | {
      command: "fs.writeBatch";
      files: ParsedWriteBatchFile[];
      raw: string;
    }
  | {
      command: "process.run";
      commandName: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      raw: string;
    }
  | {
      command: "shell.exec";
      commandText: string;
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      raw: string;
    };

export interface ExecuteCommandRequest {
  type: "FLYCODE_EXECUTE";
  command: ParsedCommand;
  site: SiteId;
}

export interface ExecuteCommandResponse {
  ok: boolean;
  result?: CommandResult;
  message?: string;
}

export interface VerifyPairCodeRequest {
  type: "FLYCODE_VERIFY_PAIR";
  pairCode: string;
}

export interface SaveSettingsRequest {
  type: "FLYCODE_SAVE_SETTINGS";
  settings: Partial<ExtensionSettings>;
}

export interface GetSettingsRequest {
  type: "FLYCODE_GET_SETTINGS";
}

export interface ReloadTabsRequest {
  type: "FLYCODE_RELOAD_TABS";
}

export interface ConfirmDecisionMessage {
  type: "FLYCODE_CONFIRM_DECISION";
  requestId: string;
  approved: boolean;
}

export type RuntimeMessage =
  | ExecuteCommandRequest
  | VerifyPairCodeRequest
  | SaveSettingsRequest
  | GetSettingsRequest
  | ReloadTabsRequest
  | ConfirmDecisionMessage;
