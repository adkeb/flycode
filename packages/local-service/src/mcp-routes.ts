/**
 * FlyCode Note: MCP gateway routes
 * Exposes Streamable HTTP MCP endpoint and desktop-app support APIs (confirmations, keys, console, app config).
 */
import { randomUUID } from "node:crypto";
import type {
  ConfirmationDecisionRequest,
  McpError,
  McpInitializeResult,
  McpRequestEnvelope,
  McpResponseEnvelope,
  McpToolCallParams,
  McpToolCallResult,
  McpToolDescriptor,
  SiteId
} from "@flycode/shared-types";
import type { FastifyInstance } from "fastify";
import { requireSiteKeyAuth } from "./security/auth.js";
import type { ServiceContext } from "./types.js";
import { AppError } from "./utils/errors.js";

type KnownSiteId = Exclude<SiteId, "unknown">;

const SUPPORTED_SITES: KnownSiteId[] = ["qwen", "deepseek", "gemini"];
const CONFIRMATION_REQUIRED_TOOLS = new Set([
  "fs.write",
  "fs.writeBatch",
  "fs.rm",
  "fs.mv",
  "fs.chmod",
  "process.run",
  "shell.exec"
]);

interface PendingToolPayload {
  kind: "tool-call";
  name: string;
  arguments: Record<string, unknown>;
  traceId: string;
}

interface PendingWritePayload {
  kind: "write-commit";
  opId: string;
  traceId: string;
}

interface PendingWriteBatchPayload {
  kind: "write-batch-commit";
  opId: string;
  traceId: string;
}

type KnownPendingPayload = PendingToolPayload | PendingWritePayload | PendingWriteBatchPayload;

export async function registerMcpRoutes(app: FastifyInstance, context: ServiceContext): Promise<void> {
  app.post<{ Params: { siteId: string }; Body: McpRequestEnvelope }>("/mcp/:siteId", async (request, reply) => {
    const siteId = assertKnownSite(request.params.siteId);
    await requireSiteKeyAuth(request, reply, siteId, context.siteKeyManager);

    const envelope = request.body as McpRequestEnvelope;
    const traceId = `mcp-${randomUUID()}`;
    const startedAt = Date.now();

    try {
      const response = await dispatchMcp(siteId, envelope, traceId, context);
      await context.consoleEventLogger.log({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        site: siteId,
        method: envelope.method,
        tool: envelope.method === "tools/call" ? (envelope.params as { name?: string } | undefined)?.name : undefined,
        status: classifyStatus(response),
        durationMs: Date.now() - startedAt,
        truncated: false,
        request: envelope,
        response
      });
      return response;
    } catch (error: unknown) {
      const appError = asAppError(error);
      const response: McpResponseEnvelope = {
        jsonrpc: "2.0",
        id: envelope?.id ?? null,
        error: toMcpError(appError)
      };

      await context.consoleEventLogger.log({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        site: siteId,
        method: envelope?.method ?? "unknown",
        tool: envelope?.method === "tools/call" ? (envelope.params as { name?: string } | undefined)?.name : undefined,
        status: "failed",
        durationMs: Date.now() - startedAt,
        request: envelope,
        response
      });
      return response;
    }
  });

  app.get("/v1/site-keys", async () => {
    const keys = await context.siteKeyManager.ensureSiteKeys();
    return {
      ok: true,
      data: keys
    };
  });

  app.post<{ Params: { siteId: string } }>("/v1/site-keys/rotate/:siteId", async (request) => {
    const site = assertKnownSite(request.params.siteId);
    const keys = await context.siteKeyManager.rotateSiteKey(site);
    return {
      ok: true,
      data: keys
    };
  });

  app.get<{ Params: { id: string } }>("/v1/confirmations/:id", async (request) => {
    const entry = await context.confirmationManager.getById(request.params.id);
    if (!entry) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Confirmation not found: ${request.params.id}`
      });
    }
    return {
      ok: true,
      data: entry
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/confirmations", async (request) => {
    const limit = request.query.limit ? Number(request.query.limit) : 100;
    const entries = await context.confirmationManager.listRecent(Number.isFinite(limit) ? limit : 100);
    return {
      ok: true,
      data: entries
    };
  });

  app.post<{ Params: { id: string }; Body: ConfirmationDecisionRequest }>(
    "/v1/confirmations/:id/decision",
    async (request) => {
      const body = request.body as ConfirmationDecisionRequest;
      const resolved = await context.confirmationManager.resolve(request.params.id, {
        approved: body.approved === true,
        alwaysAllow: body.alwaysAllow === true
      });
      return {
        ok: true,
        data: resolved
      };
    }
  );

  app.get<{
    Querystring: {
      site?: SiteId | "all";
      status?: "success" | "failed" | "pending" | "all";
      tool?: string;
      keyword?: string;
      from?: string;
      to?: string;
      limit?: string;
    };
  }>("/v1/console/events", async (request) => {
    const events = await context.consoleEventLogger.listRecent({
      site: request.query.site,
      status: request.query.status,
      tool: request.query.tool,
      keyword: request.query.keyword,
      from: request.query.from,
      to: request.query.to,
      limit: request.query.limit ? Number(request.query.limit) : undefined
    });
    return {
      ok: true,
      data: events
    };
  });

  app.get("/v1/app-config", async () => {
    const config = await context.appConfigManager.load();
    return {
      ok: true,
      data: config
    };
  });

  app.post<{ Body: unknown }>("/v1/app-config", async (request) => {
    const current = await context.appConfigManager.load();
    if (!request.body || typeof request.body !== "object") {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Body must be an object"
      });
    }
    const next = {
      ...current,
      ...(request.body as Record<string, unknown>)
    };
    const saved = await context.appConfigManager.save(next);
    await context.consoleEventLogger.cleanupExpired(saved.logRetentionDays);
    return {
      ok: true,
      data: saved
    };
  });
}

async function dispatchMcp(
  site: KnownSiteId,
  envelope: McpRequestEnvelope,
  traceId: string,
  context: ServiceContext
): Promise<McpResponseEnvelope> {
  if (!envelope || envelope.jsonrpc !== "2.0" || !envelope.method) {
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: "Invalid MCP JSON-RPC envelope"
    });
  }

  if (envelope.method === "initialize") {
    const result: McpInitializeResult = {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "flycode-mcp",
        version: "2.0.0"
      },
      capabilities: {
        tools: {
          listChanged: false
        }
      }
    };
    return {
      jsonrpc: "2.0",
      id: envelope.id,
      result
    };
  }

  if (envelope.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: envelope.id,
      result: {
        tools: buildToolDescriptors()
      }
    };
  }

  if (envelope.method === "tools/call") {
    const params = envelope.params as McpToolCallParams;
    const toolResult = await handleToolCall(site, params, traceId, context);
    return {
      jsonrpc: "2.0",
      id: envelope.id,
      result: toolResult
    };
  }

  throw new AppError({
    statusCode: 404,
    code: "NOT_FOUND",
    message: `Unsupported MCP method: ${String(envelope.method)}`
  });
}

async function handleToolCall(
  site: KnownSiteId,
  params: McpToolCallParams,
  traceId: string,
  context: ServiceContext
): Promise<McpToolCallResult> {
  if (!params || typeof params.name !== "string") {
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: "tools/call requires params.name"
    });
  }

  const toolName = params.name;
  const rawArguments = isRecord(params.arguments) ? params.arguments : {};
  const safeArguments = sanitizeArgs(rawArguments);
  context.pathPolicy.assertSiteAllowed(site);

  const requiresConfirmation =
    CONFIRMATION_REQUIRED_TOOLS.has(toolName) && !(await context.confirmationManager.shouldSkipConfirmation(site, toolName));

  const confirmedPayload = await resolveConfirmedPayload(site, toolName, params.confirmationId, context);
  if (!confirmedPayload && requiresConfirmation) {
    return preparePendingToolCall(site, toolName, safeArguments, traceId, context);
  }

  const result = await executeToolCall({
    site,
    traceId,
    toolName,
    args: safeArguments,
    context,
    confirmedPayload
  });

  return result;
}

async function resolveConfirmedPayload(
  site: KnownSiteId,
  toolName: string,
  confirmationId: string | undefined,
  context: ServiceContext
): Promise<KnownPendingPayload | null> {
  if (!confirmationId) {
    return null;
  }
  const entry = await context.confirmationManager.getById(confirmationId);
  if (!entry) {
    throw new AppError({
      statusCode: 404,
      code: "NOT_FOUND",
      message: `Confirmation not found: ${confirmationId}`
    });
  }
  if (entry.site !== site || entry.tool !== toolName) {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "Confirmation does not match current site/tool"
    });
  }
  if (entry.status === "pending") {
    throw new AppError({
      statusCode: 409,
      code: "WRITE_CONFIRMATION_REQUIRED",
      message: `Confirmation is still pending: ${confirmationId}`
    });
  }
  if (entry.status !== "approved") {
    throw new AppError({
      statusCode: 409,
      code: "WRITE_CONFIRMATION_REQUIRED",
      message: `Confirmation state is ${entry.status}`
    });
  }

  const payload = context.confirmationManager.getRequestPayload(confirmationId);
  if (!payload || !isPendingPayload(payload)) {
    throw new AppError({
      statusCode: 409,
      code: "INVALID_INPUT",
      message: "Missing confirmation payload"
    });
  }
  return payload;
}

async function preparePendingToolCall(
  site: KnownSiteId,
  toolName: string,
  args: Record<string, unknown>,
  traceId: string,
  context: ServiceContext
): Promise<McpToolCallResult> {
  if (toolName === "fs.write") {
    const prepared = await context.writeManager.prepare({
      path: String(args.path ?? ""),
      mode: args.mode === "append" ? "append" : "overwrite",
      content: String(args.content ?? ""),
      expectedSha256: typeof args.expectedSha256 === "string" ? args.expectedSha256 : undefined,
      disableConfirmation: true,
      traceId,
      site
    });
    const pending = await context.confirmationManager.createPending({
      site,
      tool: toolName,
      summary: prepared.summary,
      traceId,
      request: {
        kind: "write-commit",
        opId: prepared.opId,
        traceId
      } satisfies PendingWritePayload
    });
    return pendingResult(pending.id);
  }

  if (toolName === "fs.writeBatch") {
    const prepared = await context.writeBatchManager.prepare({
      files: normalizeWriteBatchFiles(args.files),
      disableConfirmation: true,
      traceId,
      site
    });
    const pending = await context.confirmationManager.createPending({
      site,
      tool: toolName,
      summary: prepared.summary,
      traceId,
      request: {
        kind: "write-batch-commit",
        opId: prepared.opId,
        traceId
      } satisfies PendingWriteBatchPayload
    });
    return pendingResult(pending.id);
  }

  const summary = `${toolName} ${summarizeArgs(args)}`;
  const pending = await context.confirmationManager.createPending({
    site,
    tool: toolName,
    summary,
    traceId,
    request: {
      kind: "tool-call",
      name: toolName,
      arguments: args,
      traceId
    } satisfies PendingToolPayload
  });
  return pendingResult(pending.id);
}

async function executeToolCall(input: {
  site: KnownSiteId;
  traceId: string;
  toolName: string;
  args: Record<string, unknown>;
  context: ServiceContext;
  confirmedPayload: KnownPendingPayload | null;
}): Promise<McpToolCallResult> {
  const { site, context, toolName } = input;
  let traceId = input.traceId;
  let args = input.args;
  let pendingPayload = input.confirmedPayload;
  let fromPending = false;

  if (pendingPayload?.kind === "tool-call") {
    if (pendingPayload.name === toolName) {
      args = pendingPayload.arguments;
      traceId = pendingPayload.traceId;
      fromPending = true;
    }
  }

  if (toolName === "fs.ls") {
    const result = await context.fileService.ls(String(args.path ?? ""), asNumber(args.depth), asString(args.glob));
    return successResult(result.entries, randomUUID(), result.truncated);
  }

  if (toolName === "fs.mkdir") {
    const result = await context.fileService.mkdir(String(args.path ?? ""), asBoolean(args.parents));
    return successResult(result, randomUUID(), false);
  }

  if (toolName === "fs.read") {
    const result = await context.fileService.read(String(args.path ?? ""), {
      range: asString(args.range),
      line: asNumber(args.line),
      lines: asString(args.lines),
      encoding: asReadEncoding(args.encoding),
      includeMeta: asBoolean(args.includeMeta)
    });
    return successResult(
      {
        content: result.content,
        mime: result.mime,
        bytes: result.bytes,
        sha256: result.sha256,
        meta: result.meta
      },
      randomUUID(),
      result.truncated
    );
  }

  if (toolName === "fs.search") {
    const result = await context.fileService.search(String(args.path ?? ""), {
      query: String(args.query ?? ""),
      regex: asBoolean(args.regex),
      glob: asString(args.glob),
      limit: asNumber(args.limit),
      extensions: asStringList(args.extensions),
      minBytes: asNumber(args.minBytes),
      maxBytes: asNumber(args.maxBytes),
      mtimeFrom: asString(args.mtimeFrom),
      mtimeTo: asString(args.mtimeTo),
      contextLines: asNumber(args.contextLines)
    });
    return successResult(result, randomUUID(), result.truncated);
  }

  if (toolName === "fs.rm") {
    const result = await context.fileService.rm(String(args.path ?? ""), {
      recursive: asBoolean(args.recursive),
      force: asBoolean(args.force)
    });
    return successResult(result, randomUUID(), false);
  }

  if (toolName === "fs.mv") {
    const result = await context.fileService.mv(
      String(args.fromPath ?? ""),
      String(args.toPath ?? ""),
      asBoolean(args.overwrite)
    );
    return successResult(result, randomUUID(), false);
  }

  if (toolName === "fs.chmod") {
    const result = await context.fileService.chmod(String(args.path ?? ""), String(args.mode ?? ""));
    return successResult(result, randomUUID(), false);
  }

  if (toolName === "fs.diff") {
    const result = await context.fileService.diff({
      leftPath: String(args.leftPath ?? ""),
      rightPath: asString(args.rightPath),
      rightContent: asString(args.rightContent),
      contextLines: asNumber(args.contextLines)
    });
    return successResult(result, randomUUID(), result.truncated);
  }

  if (toolName === "fs.write") {
    let committed;
    if (pendingPayload?.kind === "write-commit") {
      committed = await context.writeManager.commit({
        opId: pendingPayload.opId,
        confirmedByUser: true,
        traceId: pendingPayload.traceId,
        site
      });
    } else {
      const prepared = await context.writeManager.prepare({
        path: String(args.path ?? ""),
        mode: args.mode === "append" ? "append" : "overwrite",
        content: String(args.content ?? ""),
        expectedSha256: asString(args.expectedSha256),
        disableConfirmation: true,
        traceId,
        site
      });
      committed = await context.writeManager.commit({
        opId: prepared.opId,
        confirmedByUser: true,
        traceId,
        site
      });
    }
    return successResult(committed, randomUUID(), false);
  }

  if (toolName === "fs.writeBatch") {
    let committed;
    if (pendingPayload?.kind === "write-batch-commit") {
      committed = await context.writeBatchManager.commit({
        opId: pendingPayload.opId,
        confirmedByUser: true,
        traceId: pendingPayload.traceId,
        site
      });
    } else {
      const prepared = await context.writeBatchManager.prepare({
        files: normalizeWriteBatchFiles(args.files),
        disableConfirmation: true,
        traceId,
        site
      });
      committed = await context.writeBatchManager.commit({
        opId: prepared.opId,
        confirmedByUser: true,
        traceId,
        site
      });
    }
    return successResult(committed, randomUUID(), false);
  }

  if (toolName === "process.run") {
    const result = await context.processRunner.run({
      command: String(args.command ?? ""),
      args: asStringList(args.args),
      cwd: asString(args.cwd),
      timeoutMs: asNumber(args.timeoutMs),
      env: asStringRecord(args.env)
    });
    return successResult(result, randomUUID(), result.truncated);
  }

  if (toolName === "shell.exec") {
    const result = await context.processRunner.exec({
      command: String(args.command ?? ""),
      cwd: asString(args.cwd),
      timeoutMs: asNumber(args.timeoutMs),
      env: asStringRecord(args.env)
    });
    return successResult(result, randomUUID(), result.truncated);
  }

  throw new AppError({
    statusCode: 404,
    code: "NOT_FOUND",
    message: `Unsupported tool: ${toolName}`
  });
}

function pendingResult(id: string): McpToolCallResult {
  return {
    content: [{ type: "text", text: "Pending confirmation in FlyCode desktop app." }],
    isError: false,
    meta: {
      pendingConfirmationId: id
    }
  };
}

function successResult(data: unknown, auditId: string, truncated: boolean): McpToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ],
    meta: {
      auditId,
      truncated
    }
  };
}

function buildToolDescriptors(): McpToolDescriptor[] {
  return [
    descriptor("fs.ls", "List files and directories."),
    descriptor("fs.mkdir", "Create directory."),
    descriptor("fs.read", "Read file content."),
    descriptor("fs.search", "Search text in files."),
    descriptor("fs.write", "Write one file."),
    descriptor("fs.writeBatch", "Write multiple files transactionally."),
    descriptor("fs.rm", "Remove file/directory."),
    descriptor("fs.mv", "Move/rename path."),
    descriptor("fs.chmod", "Change file mode."),
    descriptor("fs.diff", "Create unified diff."),
    descriptor("process.run", "Run process with args."),
    descriptor("shell.exec", "Run shell command string.")
  ];
}

function descriptor(name: string, description: string): McpToolDescriptor {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  };
}

function classifyStatus(response: McpResponseEnvelope): "success" | "failed" | "pending" {
  if (response.error) {
    return "failed";
  }
  const result = response.result as McpToolCallResult | undefined;
  if (result?.meta?.pendingConfirmationId) {
    return "pending";
  }
  return "success";
}

function toMcpError(error: AppError): McpError {
  return {
    code: appErrorCodeToJsonRpc(error.code),
    message: error.message,
    data: {
      appCode: error.code,
      statusCode: error.statusCode
    }
  };
}

function appErrorCodeToJsonRpc(code: string): number {
  if (code === "UNAUTHORIZED") return -32001;
  if (code === "FORBIDDEN") return -32003;
  if (code === "NOT_FOUND") return -32004;
  if (code === "INVALID_INPUT") return -32602;
  return -32000;
}

function asAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError({
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: (error as Error).message ?? "Unexpected MCP error"
  });
}

function assertKnownSite(raw: string): KnownSiteId {
  const normalized = String(raw).toLowerCase();
  if (SUPPORTED_SITES.includes(normalized as KnownSiteId)) {
    return normalized as KnownSiteId;
  }
  throw new AppError({
    statusCode: 404,
    code: "NOT_FOUND",
    message: `Unsupported site route: ${raw}`
  });
}

function sanitizeArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith("__")) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function normalizeWriteBatchFiles(input: unknown): Array<{
  path: string;
  mode?: "overwrite" | "append";
  content: string;
  expectedSha256?: string;
}> {
  if (!Array.isArray(input)) {
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: "files must be an array"
    });
  }
  return input.map((item, index) => {
    if (!isRecord(item)) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: `Invalid files[${index}]`
      });
    }
    return {
      path: String(item.path ?? ""),
      mode: item.mode === "append" ? "append" : item.mode === "overwrite" ? "overwrite" : undefined,
      content: String(item.content ?? ""),
      expectedSha256: typeof item.expectedSha256 === "string" ? item.expectedSha256 : undefined
    };
  });
}

function summarizeArgs(args: Record<string, unknown>): string {
  const preview = JSON.stringify(args);
  if (!preview) {
    return "{}";
  }
  if (preview.length <= 160) {
    return preview;
  }
  return `${preview.slice(0, 160)}...`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asReadEncoding(value: unknown): "utf-8" | "base64" | "hex" | undefined {
  if (value === "utf-8" || value === "base64" || value === "hex") {
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPendingPayload(value: unknown): value is KnownPendingPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as { kind?: unknown };
  if (item.kind === "tool-call") {
    return true;
  }
  if (item.kind === "write-commit") {
    return true;
  }
  if (item.kind === "write-batch-commit") {
    return true;
  }
  return false;
}
