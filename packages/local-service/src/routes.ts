import { randomUUID } from "node:crypto";
import type {
  FsChmodRequest,
  FsDiffRequest,
  CommandResult,
  FsLsRequest,
  FsMkdirRequest,
  FsReadRequest,
  FsRmRequest,
  FsSearchRequest,
  FsMvRequest,
  FsWriteBatchCommitRequest,
  FsWriteBatchPrepareRequest,
  ProcessRunRequest,
  ShellExecRequest,
  FsWriteCommitRequest,
  FsWritePrepareRequest,
  PairVerifyRequest
} from "@flycode/shared-types";
import type { FastifyInstance } from "fastify";
import { requireBearerAuth } from "./security/auth.js";
import type { ServiceContext } from "./types.js";

export async function registerRoutes(app: FastifyInstance, context: ServiceContext): Promise<void> {
  app.get("/v1/health", async () => ({
    ok: true,
    service: "flycode-local-service",
    pairCodeExpiresAt: context.pairCodeManager.getExpiry().toISOString()
  }));

  app.post<{ Body: PairVerifyRequest }>("/v1/pair/verify", async (request, reply) => {
    const body = request.body as PairVerifyRequest;
    const pairCode = String(body?.pairCode ?? "");

    const ok = context.pairCodeManager.verify(pairCode);
    if (!ok) {
      reply.code(401);
      return {
        ok: false,
        errorCode: "PAIRING_FAILED",
        message: "Invalid or expired pair code"
      };
    }

    const issued = await context.tokenManager.issueToken();
    return {
      ok: true,
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString()
    };
  });

  app.register(async (protectedScope) => {
    protectedScope.addHook("preHandler", async (request, reply) => {
      await requireBearerAuth(request, reply, context.tokenManager);
    });

    protectedScope.post<{ Body: FsLsRequest }>("/v1/fs/ls", async (request) => {
      const body = request.body as FsLsRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const result = await context.fileService.ls(body.path, body.depth, body.glob);
      const output: CommandResult = {
        ok: true,
        data: { entries: result.entries },
        auditId: randomUUID(),
        truncated: result.truncated
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "fs.ls",
        path: body.path,
        outcome: "ok",
        bytes: undefined,
        truncated: output.truncated,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: FsMkdirRequest }>("/v1/fs/mkdir", async (request) => {
      const body = request.body as FsMkdirRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const mkdirResult = await context.fileService.mkdir(body.path, body.parents);
      const output: CommandResult = {
        ok: true,
        data: mkdirResult,
        auditId: randomUUID(),
        truncated: false
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "fs.mkdir",
        path: body.path,
        outcome: "ok",
        bytes: undefined,
        truncated: false,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: FsReadRequest }>("/v1/fs/read", async (request) => {
      const body = request.body as FsReadRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const readResult = await context.fileService.read(body.path, {
        range: body.range,
        line: body.line,
        lines: body.lines,
        encoding: body.encoding,
        includeMeta: body.includeMeta
      });
      const output: CommandResult = {
        ok: true,
        data: {
          content: readResult.content,
          mime: readResult.mime,
          bytes: readResult.bytes,
          sha256: readResult.sha256,
          meta: readResult.meta
        },
        auditId: randomUUID(),
        truncated: readResult.truncated
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "fs.read",
        path: body.path,
        outcome: "ok",
        bytes: readResult.bytes,
        truncated: output.truncated,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: FsSearchRequest }>("/v1/fs/search", async (request) => {
      const body = request.body as FsSearchRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const searchResult = await context.fileService.search(body.path, {
        query: body.query,
        regex: body.regex,
        glob: body.glob,
        limit: body.limit,
        extensions: body.extensions,
        minBytes: body.minBytes,
        maxBytes: body.maxBytes,
        mtimeFrom: body.mtimeFrom,
        mtimeTo: body.mtimeTo,
        contextLines: body.contextLines
      });

      const output: CommandResult = {
        ok: true,
        data: searchResult,
        auditId: randomUUID(),
        truncated: searchResult.truncated
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "fs.search",
        path: body.path,
        outcome: "ok",
        bytes: undefined,
        truncated: output.truncated,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: FsRmRequest }>("/v1/fs/rm", async (request) => {
      const body = request.body as FsRmRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const rmResult = await context.fileService.rm(body.path, {
        recursive: body.recursive,
        force: body.force
      });

      const output: CommandResult = {
        ok: true,
        data: rmResult,
        auditId: randomUUID(),
        truncated: false
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "fs.rm",
        path: body.path,
        outcome: "ok",
        bytes: undefined,
        truncated: false,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: FsMvRequest }>("/v1/fs/mv", async (request) => {
      const body = request.body as FsMvRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const moveResult = await context.fileService.mv(body.fromPath, body.toPath, body.overwrite);
      const output: CommandResult = {
        ok: true,
        data: moveResult,
        auditId: randomUUID(),
        truncated: false
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "fs.mv",
        path: `${body.fromPath} -> ${body.toPath}`,
        outcome: "ok",
        bytes: undefined,
        truncated: false,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: FsChmodRequest }>("/v1/fs/chmod", async (request) => {
      const body = request.body as FsChmodRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const chmodResult = await context.fileService.chmod(body.path, body.mode);
      const output: CommandResult = {
        ok: true,
        data: chmodResult,
        auditId: randomUUID(),
        truncated: false
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "fs.chmod",
        path: body.path,
        outcome: "ok",
        bytes: undefined,
        truncated: false,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: FsDiffRequest }>("/v1/fs/diff", async (request) => {
      const body = request.body as FsDiffRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const diffResult = await context.fileService.diff({
        leftPath: body.leftPath,
        rightPath: body.rightPath,
        rightContent: body.rightContent,
        contextLines: body.contextLines
      });

      const output: CommandResult = {
        ok: true,
        data: {
          leftPath: diffResult.leftPath,
          rightPath: diffResult.rightPath,
          changed: diffResult.changed,
          unifiedDiff: diffResult.unifiedDiff
        },
        auditId: randomUUID(),
        truncated: diffResult.truncated
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "fs.diff",
        path: body.leftPath,
        outcome: "ok",
        bytes: undefined,
        truncated: output.truncated,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: FsWritePrepareRequest & { disableConfirmation?: boolean } }>(
      "/v1/fs/write/prepare",
      async (request) => {
        const body = request.body as FsWritePrepareRequest & { disableConfirmation?: boolean };
        context.pathPolicy.assertSiteAllowed(body.site);

        const prepared = await context.writeManager.prepare({
          path: body.path,
          mode: body.mode,
          content: body.content,
          traceId: body.traceId,
          site: body.site,
          expectedSha256: body.expectedSha256,
          disableConfirmation: body.disableConfirmation
        });

        const output: CommandResult = {
          ok: true,
          data: prepared,
          auditId: randomUUID(),
          truncated: false
        };

        await context.auditLogger.log({
          timestamp: new Date().toISOString(),
          site: body.site,
          command: "fs.write.prepare",
          path: body.path,
          outcome: "ok",
          bytes: Buffer.byteLength(body.content),
          truncated: false,
          userConfirm: false,
          traceId: body.traceId,
          auditId: output.auditId
        });

        return output;
      }
    );

    protectedScope.post<{ Body: FsWriteCommitRequest }>("/v1/fs/write/commit", async (request) => {
      const body = request.body as FsWriteCommitRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const committed = await context.writeManager.commit({
        opId: body.opId,
        confirmedByUser: body.confirmedByUser,
        traceId: body.traceId,
        site: body.site
      });

      const output: CommandResult = {
        ok: true,
        data: committed,
        auditId: randomUUID(),
        truncated: false
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "fs.write.commit",
        path: committed.path,
        outcome: "ok",
        bytes: committed.writtenBytes,
        truncated: false,
        userConfirm: body.confirmedByUser,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: FsWriteBatchPrepareRequest & { disableConfirmation?: boolean } }>(
      "/v1/fs/write-batch/prepare",
      async (request) => {
        const body = request.body as FsWriteBatchPrepareRequest & { disableConfirmation?: boolean };
        context.pathPolicy.assertSiteAllowed(body.site);

        const prepared = await context.writeBatchManager.prepare({
          files: body.files,
          traceId: body.traceId,
          site: body.site,
          disableConfirmation: body.disableConfirmation
        });

        const output: CommandResult = {
          ok: true,
          data: prepared,
          auditId: randomUUID(),
          truncated: false
        };

        await context.auditLogger.log({
          timestamp: new Date().toISOString(),
          site: body.site,
          command: "fs.writeBatch.prepare",
          path: `(batch:${body.files.length})`,
          outcome: "ok",
          bytes: body.files.reduce((sum, item) => sum + Buffer.byteLength(item.content ?? ""), 0),
          truncated: false,
          userConfirm: false,
          traceId: body.traceId,
          auditId: output.auditId
        });

        return output;
      }
    );

    protectedScope.post<{ Body: FsWriteBatchCommitRequest }>("/v1/fs/write-batch/commit", async (request) => {
      const body = request.body as FsWriteBatchCommitRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const committed = await context.writeBatchManager.commit({
        opId: body.opId,
        confirmedByUser: body.confirmedByUser,
        traceId: body.traceId,
        site: body.site
      });

      const output: CommandResult = {
        ok: true,
        data: committed,
        auditId: randomUUID(),
        truncated: false
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "fs.writeBatch.commit",
        path: `(batch:${committed.files.length})`,
        outcome: "ok",
        bytes: committed.files.reduce((sum, item) => sum + item.writtenBytes, 0),
        truncated: false,
        userConfirm: body.confirmedByUser,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: ProcessRunRequest }>("/v1/process/run", async (request) => {
      const body = request.body as ProcessRunRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const runResult = await context.processRunner.run({
        command: body.command,
        args: body.args,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        env: body.env
      });

      const output: CommandResult = {
        ok: true,
        data: runResult,
        auditId: randomUUID(),
        truncated: runResult.truncated
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "process.run",
        path: body.cwd,
        outcome: "ok",
        bytes: Buffer.byteLength(runResult.stdout) + Buffer.byteLength(runResult.stderr),
        truncated: output.truncated,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });

    protectedScope.post<{ Body: ShellExecRequest }>("/v1/shell/exec", async (request) => {
      const body = request.body as ShellExecRequest;
      context.pathPolicy.assertSiteAllowed(body.site);

      const execResult = await context.processRunner.exec({
        command: body.command,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        env: body.env
      });

      const output: CommandResult = {
        ok: true,
        data: execResult,
        auditId: randomUUID(),
        truncated: execResult.truncated
      };

      await context.auditLogger.log({
        timestamp: new Date().toISOString(),
        site: body.site,
        command: "shell.exec",
        path: body.cwd,
        outcome: "ok",
        bytes: Buffer.byteLength(execResult.stdout) + Buffer.byteLength(execResult.stderr),
        truncated: output.truncated,
        traceId: body.traceId,
        auditId: output.auditId
      });

      return output;
    });
  });
}
