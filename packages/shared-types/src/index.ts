export type SiteId = "qwen" | "deepseek" | "unknown";

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "LIMIT_EXCEEDED"
  | "CONFLICT"
  | "INTERNAL_ERROR"
  | "NOT_SUPPORTED"
  | "POLICY_BLOCKED"
  | "WRITE_CONFIRMATION_REQUIRED"
  | "PAIRING_FAILED";

export interface CommandResult<T = unknown> {
  ok: boolean;
  errorCode?: ApiErrorCode;
  message?: string;
  data?: T;
  auditId: string;
  truncated: boolean;
}

export interface FsLsRequest {
  path: string;
  depth?: number;
  glob?: string;
  traceId: string;
  site: SiteId;
}

export interface FsReadRequest {
  path: string;
  range?: string;
  line?: number;
  lines?: string;
  encoding?: ReadEncoding;
  includeMeta?: boolean;
  traceId: string;
  site: SiteId;
}

export interface FsSearchRequest {
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
  traceId: string;
  site: SiteId;
}

export interface FsMkdirRequest {
  path: string;
  parents?: boolean;
  traceId: string;
  site: SiteId;
}

export type WriteMode = "overwrite" | "append";
export type ReadEncoding = "utf-8" | "base64" | "hex";

export interface FsWritePrepareRequest {
  path: string;
  mode: WriteMode;
  content: string;
  expectedSha256?: string;
  disableConfirmation?: boolean;
  traceId: string;
  site: SiteId;
}

export interface FsWriteCommitRequest {
  opId: string;
  confirmedByUser: boolean;
  traceId: string;
  site: SiteId;
}

export interface FsRmRequest {
  path: string;
  recursive?: boolean;
  force?: boolean;
  traceId: string;
  site: SiteId;
}

export interface FsMvRequest {
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
  traceId: string;
  site: SiteId;
}

export interface FsChmodRequest {
  path: string;
  mode: string;
  traceId: string;
  site: SiteId;
}

export interface WriteBatchFileInput {
  path: string;
  mode?: WriteMode;
  content: string;
  expectedSha256?: string;
}

export interface FsWriteBatchPrepareRequest {
  files: WriteBatchFileInput[];
  disableConfirmation?: boolean;
  traceId: string;
  site: SiteId;
}

export interface FsWriteBatchCommitRequest {
  opId: string;
  confirmedByUser: boolean;
  traceId: string;
  site: SiteId;
}

export interface FsDiffRequest {
  leftPath: string;
  rightPath?: string;
  rightContent?: string;
  contextLines?: number;
  traceId: string;
  site: SiteId;
}

export interface ProcessRunRequest {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  traceId: string;
  site: SiteId;
}

export interface ShellExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  traceId: string;
  site: SiteId;
}

export interface LsEntry {
  path: string;
  type: "file" | "directory";
  bytes?: number;
}

export interface LsData {
  entries: LsEntry[];
}

export interface ReadData {
  content: string;
  mime: string;
  bytes: number;
  sha256: string;
  meta?: {
    size: number;
    mtime: string;
    ctime: string;
    mode: string;
  };
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  before?: Array<{ line: number; text: string }>;
  after?: Array<{ line: number; text: string }>;
}

export interface SearchData {
  matches: SearchMatch[];
  total: number;
  truncated: boolean;
}

export interface MkdirData {
  path: string;
  created: boolean;
  parents: boolean;
}

export interface RmData {
  path: string;
  removed: boolean;
  type: "file" | "directory" | "missing";
  recursive: boolean;
}

export interface MvData {
  fromPath: string;
  toPath: string;
  overwritten: boolean;
}

export interface ChmodData {
  path: string;
  mode: string;
}

export interface WritePrepareData {
  opId: string;
  requireConfirmation: boolean;
  summary: string;
}

export interface WriteData {
  path: string;
  writtenBytes: number;
  backupPath?: string;
  newSha256: string;
}

export interface WriteBatchPrepareData {
  opId: string;
  requireConfirmation: boolean;
  summary: string;
  totalFiles: number;
  totalBytes: number;
}

export interface WriteBatchFileData {
  path: string;
  mode: WriteMode;
  writtenBytes: number;
  backupPath?: string;
  newSha256: string;
}

export interface WriteBatchData {
  files: WriteBatchFileData[];
  rolledBack?: boolean;
  failedAtIndex?: number;
  rollbackErrors?: string[];
}

export interface DiffData {
  leftPath: string;
  rightPath?: string;
  changed: boolean;
  unifiedDiff: string;
}

export interface ProcessRunData {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface PairVerifyRequest {
  pairCode: string;
}

export interface PairVerifyResponse {
  token: string;
  expiresAt: string;
}
