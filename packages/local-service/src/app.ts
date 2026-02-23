/**
 * FlyCode Note: Fastify app composition
 * Builds the HTTP app, wires CORS and unified error handling, and emits audit records for failures.
 */
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createServiceContext } from "./context.js";
import { registerRoutes } from "./routes.js";
import type { ServiceContext } from "./types.js";
import { AppError } from "./utils/errors.js";

export async function buildApp(inputContext?: ServiceContext): Promise<{ app: FastifyInstance; context: ServiceContext }> {
  const context = inputContext ?? (await createServiceContext());
  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: true
  });

  app.setErrorHandler(async (error, request, reply) => {
    const appError = error instanceof AppError ? error : null;

    const statusCode = appError?.statusCode ?? 500;
    const code = appError?.code ?? "INTERNAL_ERROR";
    const message = appError?.message ?? "Unexpected error";

    const traceId = extractTraceId(request.body);
    const site = extractSite(request.body);
    const command = inferCommand(request.url);
    const pathValue = extractPath(request.body);

    if (traceId && site && command) {
      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site,
        command,
        path: pathValue,
        outcome: "error",
        bytes: undefined,
        truncated: false,
        traceId,
        auditId: randomUUID(),
        errorCode: code,
        message
      });
    }

    reply.status(statusCode).send({
      ok: false,
      errorCode: code,
      message,
      auditId: randomUUID(),
      truncated: false
    });
  });

  await registerRoutes(app, context);

  return { app, context };
}

function extractTraceId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const traceId = (body as { traceId?: unknown }).traceId;
  return typeof traceId === "string" ? traceId : undefined;
}

function extractPath(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const bag = body as {
    path?: unknown;
    fromPath?: unknown;
    leftPath?: unknown;
    cwd?: unknown;
  };

  if (typeof bag.path === "string") return bag.path;
  if (typeof bag.fromPath === "string") return bag.fromPath;
  if (typeof bag.leftPath === "string") return bag.leftPath;
  if (typeof bag.cwd === "string") return bag.cwd;
  return undefined;
}

function extractSite(body: unknown): "qwen" | "deepseek" | "gemini" | "unknown" | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const site = (body as { site?: unknown }).site;
  if (site === "qwen" || site === "deepseek" || site === "gemini" || site === "unknown") {
    return site;
  }

  return undefined;
}

function inferCommand(url: string): string | undefined {
  if (url.includes("/v1/fs/ls")) return "fs.ls";
  if (url.includes("/v1/fs/mkdir")) return "fs.mkdir";
  if (url.includes("/v1/fs/rm")) return "fs.rm";
  if (url.includes("/v1/fs/mv")) return "fs.mv";
  if (url.includes("/v1/fs/chmod")) return "fs.chmod";
  if (url.includes("/v1/fs/read")) return "fs.read";
  if (url.includes("/v1/fs/search")) return "fs.search";
  if (url.includes("/v1/fs/diff")) return "fs.diff";
  if (url.includes("/v1/fs/write-batch/prepare")) return "fs.writeBatch.prepare";
  if (url.includes("/v1/fs/write-batch/commit")) return "fs.writeBatch.commit";
  if (url.includes("/v1/fs/write/prepare")) return "fs.write.prepare";
  if (url.includes("/v1/fs/write/commit")) return "fs.write.commit";
  if (url.includes("/v1/process/run")) return "process.run";
  if (url.includes("/v1/shell/exec")) return "shell.exec";
  if (url.includes("/mcp/")) return "mcp";
  return undefined;
}
