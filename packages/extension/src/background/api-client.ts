import type {
  FsChmodRequest,
  FsDiffRequest,
  FsMvRequest,
  FsRmRequest,
  CommandResult,
  FsLsRequest,
  FsMkdirRequest,
  FsReadRequest,
  FsSearchRequest,
  FsWriteBatchCommitRequest,
  FsWriteBatchPrepareRequest,
  FsWriteCommitRequest,
  FsWritePrepareRequest,
  PairVerifyRequest,
  PairVerifyResponse,
  ProcessRunRequest,
  ShellExecRequest,
  SiteId
} from "@flycode/shared-types";
import type { ParsedCommand } from "../shared/types.js";
import type { ExtensionSettings } from "../shared/types.js";
import { newTraceId } from "../shared/trace.js";

export async function verifyPairCode(settings: ExtensionSettings, pairCode: string): Promise<PairVerifyResponse> {
  const body: PairVerifyRequest = { pairCode };
  const response = await fetchJson<{ ok: boolean; token: string; expiresAt: string; message?: string }>(
    `${settings.baseUrl}/v1/pair/verify`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    throw new Error(response.message ?? "Pair verification failed");
  }

  return {
    token: response.token,
    expiresAt: response.expiresAt
  };
}

export async function runCommand(
  settings: ExtensionSettings,
  command: ParsedCommand,
  site: SiteId,
  confirmCommit: (summary: string, requestId: string) => Promise<boolean>
): Promise<CommandResult> {
  const traceId = newTraceId();

  if (command.command === "fs.ls") {
    const body: FsLsRequest = {
      path: command.path,
      depth: command.depth,
      glob: command.glob,
      traceId,
      site
    };

    return callProtected(settings, "/v1/fs/ls", body);
  }

  if (command.command === "fs.mkdir") {
    const body: FsMkdirRequest = {
      path: command.path,
      parents: command.parents,
      traceId,
      site
    };

    return callProtected(settings, "/v1/fs/mkdir", body);
  }

  if (command.command === "fs.read") {
    const body: FsReadRequest = {
      path: command.path,
      range: command.range,
      line: command.line,
      lines: command.lines,
      encoding: command.encoding,
      includeMeta: command.includeMeta,
      traceId,
      site
    };

    return callProtected(settings, "/v1/fs/read", body);
  }

  if (command.command === "fs.search") {
    const body: FsSearchRequest = {
      path: command.path,
      query: command.query,
      regex: command.regex,
      glob: command.glob,
      limit: command.limit,
      extensions: command.extensions,
      minBytes: command.minBytes,
      maxBytes: command.maxBytes,
      mtimeFrom: command.mtimeFrom,
      mtimeTo: command.mtimeTo,
      contextLines: command.contextLines,
      traceId,
      site
    };

    return callProtected(settings, "/v1/fs/search", body);
  }

  if (command.command === "fs.rm") {
    const body: FsRmRequest = {
      path: command.path,
      recursive: command.recursive,
      force: command.force,
      traceId,
      site
    };

    return callProtected(settings, "/v1/fs/rm", body);
  }

  if (command.command === "fs.mv") {
    const body: FsMvRequest = {
      fromPath: command.fromPath,
      toPath: command.toPath,
      overwrite: command.overwrite,
      traceId,
      site
    };

    return callProtected(settings, "/v1/fs/mv", body);
  }

  if (command.command === "fs.chmod") {
    const body: FsChmodRequest = {
      path: command.path,
      mode: command.mode,
      traceId,
      site
    };

    return callProtected(settings, "/v1/fs/chmod", body);
  }

  if (command.command === "fs.diff") {
    const body: FsDiffRequest = {
      leftPath: command.leftPath,
      rightPath: command.rightPath,
      rightContent: command.rightContent,
      contextLines: command.contextLines,
      traceId,
      site
    };

    return callProtected(settings, "/v1/fs/diff", body);
  }

  if (command.command === "fs.write") {
    const prepare: FsWritePrepareRequest = {
      path: command.path,
      mode: command.mode,
      content: command.content,
      expectedSha256: command.expectedSha256,
      disableConfirmation: !settings.confirmWritesEnabled,
      traceId,
      site
    };

    const prepareResult = await callProtected(settings, "/v1/fs/write/prepare", prepare);
    if (!prepareResult.ok) {
      return prepareResult;
    }

    const prepareData = prepareResult.data as { opId: string; requireConfirmation: boolean; summary: string };
    let approved = true;

    if (prepareData.requireConfirmation) {
      approved = await confirmCommit(prepareData.summary, prepareData.opId);
    }

    if (!approved) {
      return {
        ok: false,
        errorCode: "WRITE_CONFIRMATION_REQUIRED",
        message: "Write operation rejected by user",
        auditId: prepareResult.auditId,
        truncated: false
      };
    }

    const commit: FsWriteCommitRequest = {
      opId: prepareData.opId,
      confirmedByUser: true,
      traceId,
      site
    };

    return callProtected(settings, "/v1/fs/write/commit", commit);
  }

  if (command.command === "fs.writeBatch") {
    const prepare: FsWriteBatchPrepareRequest = {
      files: command.files.map((item) => ({
        path: item.path,
        mode: item.mode ?? "overwrite",
        content: item.content,
        expectedSha256: item.expectedSha256
      })),
      disableConfirmation: !settings.confirmWritesEnabled,
      traceId,
      site
    };

    const prepareResult = await callProtected(settings, "/v1/fs/write-batch/prepare", prepare);
    if (!prepareResult.ok) {
      return prepareResult;
    }

    const prepareData = prepareResult.data as { opId: string; requireConfirmation: boolean; summary: string };
    let approved = true;

    if (prepareData.requireConfirmation) {
      approved = await confirmCommit(prepareData.summary, prepareData.opId);
    }

    if (!approved) {
      return {
        ok: false,
        errorCode: "WRITE_CONFIRMATION_REQUIRED",
        message: "Write batch operation rejected by user",
        auditId: prepareResult.auditId,
        truncated: false
      };
    }

    const commit: FsWriteBatchCommitRequest = {
      opId: prepareData.opId,
      confirmedByUser: true,
      traceId,
      site
    };

    return callProtected(settings, "/v1/fs/write-batch/commit", commit);
  }

  if (command.command === "process.run") {
    const body: ProcessRunRequest = {
      command: command.commandName,
      args: command.args,
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
      env: command.env,
      traceId,
      site
    };

    return callProtected(settings, "/v1/process/run", body);
  }

  if (command.command === "shell.exec") {
    const body: ShellExecRequest = {
      command: command.commandText,
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
      env: command.env,
      traceId,
      site
    };

    return callProtected(settings, "/v1/shell/exec", body);
  }

  return {
    ok: false,
    errorCode: "INVALID_INPUT",
    message: "Unsupported command",
    auditId: newTraceId(),
    truncated: false
  };
}

async function callProtected(settings: ExtensionSettings, endpoint: string, body: object): Promise<CommandResult> {
  if (!settings.token) {
    throw new Error("Missing token. Open extension options and verify pair code first.");
  }

  return fetchJson<CommandResult>(`${settings.baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.token}`
    },
    body: JSON.stringify(body)
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
      typeof payload === "object" && payload !== null && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : `HTTP ${response.status}`;

    const error = new Error(message);
    (error as Error & { payload?: unknown }).payload = payload;
    throw error;
  }

  return payload as T;
}
