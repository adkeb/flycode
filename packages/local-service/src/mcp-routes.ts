/**
 * FlyCode Note: MCP gateway routes
 * Exposes Streamable HTTP MCP endpoint, websocket bridge endpoint, and desktop support APIs.
 */
import { randomUUID } from "node:crypto";
import type {
  ConsoleClearRequest,
  ConfirmationDecisionRequest,
  McpRequestEnvelope,
  McpResponseEnvelope,
  PolicyRuntimePatch,
  SiteId
} from "@flycode/shared-types";
import type { FastifyInstance } from "fastify";
import { requireSiteKeyAuth } from "./security/auth.js";
import { assertKnownSite } from "./services/mcp-gateway.js";
import type { ServiceContext } from "./types.js";
import { AppError } from "./utils/errors.js";

type KnownSiteId = Exclude<SiteId, "unknown">;

export async function registerMcpRoutes(app: FastifyInstance, context: ServiceContext): Promise<void> {
  app.post<{ Params: { siteId: string }; Body: McpRequestEnvelope }>("/mcp/:siteId", async (request, reply) => {
    const siteId = assertKnownSite(request.params.siteId);
    await requireSiteKeyAuth(request, reply, siteId, context.siteKeyManager);

    const envelope = request.body as McpRequestEnvelope;
    const traceId = `mcp-${randomUUID()}`;
    const startedAt = Date.now();

    try {
      const response = await context.mcpGateway.dispatch(siteId, envelope, traceId);
      await context.consoleEventLogger.log({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        site: siteId,
        method: envelope.method,
        tool: envelope.method === "tools/call" ? (envelope.params as { name?: string } | undefined)?.name : undefined,
        status: context.mcpGateway.classifyStatus(response),
        durationMs: Date.now() - startedAt,
        truncated: false,
        request: envelope,
        response
      });
      return response;
    } catch (error: unknown) {
      const message = (error as Error).message ?? "Unexpected MCP error";
      const response: McpResponseEnvelope = {
        jsonrpc: "2.0",
        id: envelope?.id ?? null,
        error: {
          code: -32000,
          message
        }
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

  app.get("/v1/bridge/ws", { websocket: true }, async (connection: any, request) => {
    const socket = connection?.socket ?? connection;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const role = query.role === "app" ? "app" : query.role === "web" ? "web" : null;

    if (!role) {
      socket.send(
        JSON.stringify({
          type: "bridge.error",
          code: "INVALID_QUERY",
          message: "Missing role query parameter"
        })
      );
      socket.close();
      return;
    }

    try {
      if (role === "web") {
        const site = assertKnownSite(String(query.site ?? ""));
        const tabId = Number(query.tabId);
        const windowId = Number(query.windowId);
        const conversationId = String(query.conversationId ?? "").trim();
        const url = typeof query.url === "string" ? query.url : undefined;
        const title = typeof query.title === "string" ? query.title : undefined;

        await context.bridgeHub.bindWebsocket({
          socket,
          role,
          site,
          tabId,
          windowId,
          conversationId,
          url,
          title
        });
        return;
      }

      await context.bridgeHub.bindWebsocket({
        socket,
        role
      });
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "bridge.error",
          code: "BRIDGE_BIND_FAILED",
          message: (error as Error).message
        })
      );
      socket.close();
    }
  });

  app.delete<{ Params: { sessionId: string } }>("/v1/bridge/sessions/:sessionId", async (request) => {
    const sessionId = decodeURIComponent(String(request.params.sessionId ?? "")).trim();
    if (!sessionId) {
      throw new AppError({
        statusCode: 400,
        code: "INVALID_INPUT",
        message: "Missing sessionId"
      });
    }

    const deleted = await context.bridgeHub.deleteSession(sessionId);
    return {
      ok: true,
      data: {
        deleted
      }
    };
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

  app.get("/v1/policy/runtime", async () => {
    return {
      ok: true,
      data: context.policyRuntimeManager.getRuntime()
    };
  });

  app.post<{ Body: PolicyRuntimePatch }>("/v1/policy/runtime/validate", async (request) => {
    const body = request.body as PolicyRuntimePatch;
    const validation = context.policyRuntimeManager.validatePatch(body);
    return {
      ok: true,
      data: validation
    };
  });

  app.post<{ Body: PolicyRuntimePatch }>("/v1/policy/runtime", async (request) => {
    const body = request.body as PolicyRuntimePatch;
    const next = await context.policyRuntimeManager.applyPatch(body);
    return {
      ok: true,
      data: next
    };
  });

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
  }>("/v1/console/export", async (request) => {
    const events = await context.consoleEventLogger.exportRecent({
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

  app.post<{ Body: ConsoleClearRequest }>("/v1/console/clear", async (request) => {
    const body = request.body as ConsoleClearRequest;
    if (!body || (body.mode !== "all" && body.mode !== "filtered")) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Body mode must be 'all' or 'filtered'"
      });
    }

    const result = await context.consoleEventLogger.clear(body);
    return {
      ok: true,
      data: result
    };
  });
}
