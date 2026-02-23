/**
 * FlyCode Note: Local service interfaces
 * Declares policy schema, service contracts, audit payloads, and manager interfaces for dependency boundaries.
 */
import type {
  ConfirmationEntry,
  ConsoleEventEntry,
  ReadEncoding,
  SiteId,
  SiteKeysResponse,
  WriteBatchFileInput,
  WriteMode
} from "@flycode/shared-types";

export interface RedactionRule {
  name: string;
  pattern: string;
  replacement?: string;
  flags?: string;
}

export interface PolicyConfig {
  allowed_roots: string[];
  deny_globs: string[];
  site_allowlist: string[];
  limits: {
    max_file_bytes: number;
    max_inject_tokens: number;
    max_search_matches: number;
  };
  write: {
    require_confirmation_default: boolean;
    allow_disable_confirmation: boolean;
    backup_on_overwrite: boolean;
    pending_ttl_seconds: number;
  };
  mutation: {
    allow_rm: boolean;
    allow_mv: boolean;
    allow_chmod: boolean;
    allow_write_batch: boolean;
  };
  process: {
    enabled: boolean;
    allowed_commands: string[];
    allowed_cwds: string[];
    default_timeout_ms: number;
    max_timeout_ms: number;
    max_output_bytes: number;
    allow_env_keys: string[];
  };
  redaction: {
    enabled: boolean;
    rules: RedactionRule[];
  };
  audit: {
    enabled: boolean;
    include_content_hash: boolean;
  };
  auth: {
    token_ttl_days: number;
    pair_code_ttl_minutes: number;
  };
}

export interface ServiceContext {
  policy: PolicyConfig;
  pairCodeManager: PairCodeManager;
  tokenManager: TokenManager;
  siteKeyManager: SiteKeyManager;
  confirmationManager: ConfirmationManager;
  consoleEventLogger: ConsoleEventLogger;
  appConfigManager: AppConfigManager;
  pathPolicy: PathPolicy;
  redactor: Redactor;
  auditLogger: AuditLogger;
  fileService: FileService;
  writeManager: WriteManager;
  writeBatchManager: WriteBatchManager;
  processRunner: ProcessRunner;
}

export interface PendingWriteOp {
  id: string;
  path: string;
  mode: WriteMode;
  content: string;
  requireConfirmation: boolean;
  traceId: string;
  site: SiteId;
  createdAt: Date;
  expiresAt: Date;
  expectedSha256?: string;
}

export interface PendingWriteBatchOp {
  id: string;
  files: Array<{
    path: string;
    mode: WriteMode;
    content: string;
    expectedSha256?: string;
  }>;
  requireConfirmation: boolean;
  traceId: string;
  site: SiteId;
  createdAt: Date;
  expiresAt: Date;
}

export interface AppErrorOptions {
  statusCode: number;
  code: string;
  message: string;
}

export interface AuditEntry {
  timestamp: string;
  site: SiteId;
  command: string;
  path?: string;
  outcome: "ok" | "error";
  bytes?: number;
  truncated: boolean;
  userConfirm?: boolean;
  traceId: string;
  auditId: string;
  errorCode?: string;
  message?: string;
}

export interface PairCodeManager {
  issueCode(): string;
  getCurrentCode(): string;
  verify(code: string): boolean;
  getExpiry(): Date;
}

export interface TokenManager {
  issueToken(): Promise<{ token: string; expiresAt: Date }>;
  verifyToken(token: string): Promise<boolean>;
}

export interface SiteKeyManager {
  getSiteKeys(): Promise<SiteKeysResponse>;
  ensureSiteKeys(): Promise<SiteKeysResponse>;
  rotateSiteKey(site: Exclude<SiteId, "unknown">): Promise<SiteKeysResponse>;
  verifySiteKey(site: Exclude<SiteId, "unknown">, token: string): Promise<boolean>;
}

export interface ConfirmationDecision {
  approved: boolean;
  alwaysAllow?: boolean;
}

export interface ConfirmationManager {
  createPending(input: {
    site: Exclude<SiteId, "unknown">;
    tool: string;
    summary: string;
    traceId: string;
    request: unknown;
  }): Promise<ConfirmationEntry>;
  getById(id: string): Promise<ConfirmationEntry | null>;
  resolve(id: string, input: ConfirmationDecision): Promise<ConfirmationEntry>;
  shouldSkipConfirmation(site: Exclude<SiteId, "unknown">, tool: string): Promise<boolean>;
  listRecent(limit: number): Promise<ConfirmationEntry[]>;
  getRequestPayload(id: string): unknown | undefined;
}

export interface ConsoleEventLogger {
  log(entry: ConsoleEventEntry): Promise<void>;
  listRecent(input?: {
    site?: SiteId | "all";
    status?: "success" | "failed" | "pending" | "all";
    tool?: string;
    keyword?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<ConsoleEventEntry[]>;
  cleanupExpired(retentionDays: number): Promise<void>;
}

export interface AppConfigData {
  theme: "light" | "dark" | "system";
  logRetentionDays: number;
  servicePort: number;
  alwaysAllow: Record<string, boolean>;
}

export interface AppConfigManager {
  load(): Promise<AppConfigData>;
  save(next: AppConfigData): Promise<AppConfigData>;
  updateAlwaysAllow(site: Exclude<SiteId, "unknown">, tool: string, allow: boolean): Promise<AppConfigData>;
}

export interface PathPolicy {
  normalizeInputPath(inputPath: string): string;
  assertAllowed(path: string): void;
  assertSiteAllowed(site: SiteId): void;
}

export interface Redactor {
  redact(content: string): { content: string; changed: boolean };
}

export interface AuditLogger {
  log(entry: AuditEntry): Promise<void>;
}

export interface FileService {
  ls(
    inputPath: string,
    depth: number | undefined,
    glob: string | undefined
  ): Promise<{ entries: Array<{ path: string; type: "file" | "directory"; bytes?: number }>; truncated: boolean }>;
  mkdir(inputPath: string, parents: boolean | undefined): Promise<{ path: string; created: boolean; parents: boolean }>;
  read(
    inputPath: string,
    options: {
      range?: string;
      line?: number;
      lines?: string;
      encoding?: ReadEncoding;
      includeMeta?: boolean;
    }
  ): Promise<{
    content: string;
    mime: string;
    bytes: number;
    sha256: string;
    truncated: boolean;
    meta?: {
      size: number;
      mtime: string;
      ctime: string;
      mode: string;
    };
  }>;
  search(
    inputPath: string,
    options: {
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
    }
  ): Promise<{
    matches: Array<{
      path: string;
      line: number;
      column: number;
      text: string;
      before?: Array<{ line: number; text: string }>;
      after?: Array<{ line: number; text: string }>;
    }>;
    total: number;
    truncated: boolean;
  }>;
  rm(
    inputPath: string,
    options: { recursive?: boolean; force?: boolean }
  ): Promise<{ path: string; removed: boolean; type: "file" | "directory" | "missing"; recursive: boolean }>;
  mv(
    fromPath: string,
    toPath: string,
    overwrite: boolean | undefined
  ): Promise<{ fromPath: string; toPath: string; overwritten: boolean }>;
  chmod(inputPath: string, mode: string): Promise<{ path: string; mode: string }>;
  diff(input: {
    leftPath: string;
    rightPath?: string;
    rightContent?: string;
    contextLines?: number;
  }): Promise<{ leftPath: string; rightPath?: string; changed: boolean; unifiedDiff: string; truncated: boolean }>;
  commitWrite(op: PendingWriteOp): Promise<{ path: string; writtenBytes: number; backupPath?: string; newSha256: string; }>;
  existingSha256(inputPath: string): Promise<string | null>;
}

export interface WriteManager {
  prepare(input: {
    path: string;
    mode: WriteMode;
    content: string;
    traceId: string;
    site: SiteId;
    expectedSha256?: string;
    disableConfirmation?: boolean;
  }): Promise<{ opId: string; requireConfirmation: boolean; summary: string }>;
  commit(input: {
    opId: string;
    confirmedByUser: boolean;
    traceId: string;
    site: SiteId;
  }): Promise<{ path: string; writtenBytes: number; backupPath?: string; newSha256: string }>;
}

export interface WriteBatchManager {
  prepare(input: {
    files: WriteBatchFileInput[];
    traceId: string;
    site: SiteId;
    disableConfirmation?: boolean;
  }): Promise<{ opId: string; requireConfirmation: boolean; summary: string; totalFiles: number; totalBytes: number }>;
  commit(input: {
    opId: string;
    confirmedByUser: boolean;
    traceId: string;
    site: SiteId;
  }): Promise<{ files: Array<{ path: string; mode: WriteMode; writtenBytes: number; backupPath?: string; newSha256: string }> }>;
}

export interface ProcessRunner {
  run(input: {
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<{
    command: string;
    cwd: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    truncated: boolean;
  }>;
  exec(input: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<{
    command: string;
    cwd: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    truncated: boolean;
  }>;
}
