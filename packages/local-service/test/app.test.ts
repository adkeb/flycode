import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditEntry, AuditLogger, PolicyConfig, ServiceContext } from "../src/types.js";
import { buildApp } from "../src/app.js";
import { FileTokenManager, InMemoryPairCodeManager } from "../src/security/pairing.js";
import { DefaultFileService } from "../src/services/file-service.js";
import { DefaultPathPolicy } from "../src/services/path-policy.js";
import { DefaultProcessRunner } from "../src/services/process-runner.js";
import { DefaultRedactor } from "../src/services/redactor.js";
import { InMemoryWriteBatchManager } from "../src/services/write-batch-manager.js";
import { InMemoryWriteManager } from "../src/services/write-manager.js";

class InMemoryAuditLogger implements AuditLogger {
  readonly entries: AuditEntry[] = [];

  async log(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

describe("local-service app", () => {
  it("issues token through pair verify and serves expanded fs/process routes", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flycode-test-"));
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "flycode-home-"));
    process.env.HOME = homeDir;

    const targetFile = path.join(tmpRoot, "note.txt");
    const moveTarget = path.join(tmpRoot, "moved-note.txt");
    await fs.writeFile(targetFile, "password = 123456\nhello world\nTODO item\n", "utf8");

    const policy: PolicyConfig = {
      allowed_roots: [tmpRoot],
      deny_globs: ["**/*.secret"],
      site_allowlist: ["qwen", "deepseek"],
      limits: {
        max_file_bytes: 1024 * 1024,
        max_inject_tokens: 12000,
        max_search_matches: 100
      },
      write: {
        require_confirmation_default: true,
        allow_disable_confirmation: true,
        backup_on_overwrite: true,
        pending_ttl_seconds: 600
      },
      mutation: {
        allow_rm: true,
        allow_mv: true,
        allow_chmod: true,
        allow_write_batch: true
      },
      process: {
        enabled: true,
        allowed_commands: ["node", "git", "npm"],
        allowed_cwds: [],
        default_timeout_ms: 30_000,
        max_timeout_ms: 120_000,
        max_output_bytes: 200_000,
        allow_env_keys: ["CI", "NODE_ENV"]
      },
      redaction: {
        enabled: true,
        rules: [
          {
            name: "password",
            pattern: "(password\\s*=\\s*)([^\\s]+)",
            replacement: "$1***REDACTED***",
            flags: "i"
          }
        ]
      },
      audit: {
        enabled: true,
        include_content_hash: true
      },
      auth: {
        token_ttl_days: 30,
        pair_code_ttl_minutes: 5
      }
    };

    const pairCodeManager = new InMemoryPairCodeManager(policy.auth.pair_code_ttl_minutes);
    const tokenManager = new FileTokenManager(policy.auth.token_ttl_days);
    const pathPolicy = new DefaultPathPolicy(policy);
    const redactor = new DefaultRedactor(policy);
    const auditLogger = new InMemoryAuditLogger();
    const fileService = new DefaultFileService(policy, pathPolicy, redactor);
    const writeManager = new InMemoryWriteManager(policy, pathPolicy, fileService);
    const writeBatchManager = new InMemoryWriteBatchManager(policy, pathPolicy, fileService);
    const processRunner = new DefaultProcessRunner(policy, pathPolicy, redactor);

    const context: ServiceContext = {
      policy,
      pairCodeManager,
      tokenManager,
      pathPolicy,
      redactor,
      auditLogger,
      fileService,
      writeManager,
      writeBatchManager,
      processRunner
    };

    const { app } = await buildApp(context);

    const unauth = await app.inject({
      method: "POST",
      url: "/v1/fs/ls",
      payload: {
        path: tmpRoot,
        traceId: "t1",
        site: "qwen"
      }
    });
    expect(unauth.statusCode).toBe(401);

    const pairCode = pairCodeManager.getCurrentCode();
    const pairRes = await app.inject({
      method: "POST",
      url: "/v1/pair/verify",
      payload: { pairCode }
    });
    expect(pairRes.statusCode).toBe(200);
    const token = (pairRes.json() as { token: string }).token;
    expect(token).toBeTruthy();

    const readRes = await app.inject({
      method: "POST",
      url: "/v1/fs/read",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        path: targetFile,
        line: 1,
        includeMeta: true,
        traceId: "t2",
        site: "qwen"
      }
    });
    expect(readRes.statusCode).toBe(200);
    const readPayload = readRes.json() as {
      ok: boolean;
      data: { content: string; meta?: { size: number } };
    };
    expect(readPayload.ok).toBe(true);
    expect(readPayload.data.content).toContain("***REDACTED***");
    expect(readPayload.data.meta?.size).toBeGreaterThan(0);

    const mkdirPath = path.join(tmpRoot, "nested", "child");
    const mkdirRes = await app.inject({
      method: "POST",
      url: "/v1/fs/mkdir",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        path: mkdirPath,
        parents: true,
        traceId: "t-mkdir",
        site: "qwen"
      }
    });
    expect(mkdirRes.statusCode).toBe(200);

    const searchRes = await app.inject({
      method: "POST",
      url: "/v1/fs/search",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        path: tmpRoot,
        query: "TODO",
        extensions: [".txt"],
        contextLines: 1,
        traceId: "t-search",
        site: "qwen"
      }
    });
    expect(searchRes.statusCode).toBe(200);
    const searchPayload = searchRes.json() as { data: { total: number; matches: Array<{ before?: unknown[]; after?: unknown[] }> } };
    expect(searchPayload.data.total).toBeGreaterThan(0);
    expect(searchPayload.data.matches[0]?.before || searchPayload.data.matches[0]?.after).toBeTruthy();

    const diffRes = await app.inject({
      method: "POST",
      url: "/v1/fs/diff",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        leftPath: targetFile,
        rightContent: "password = 123456\nhello world\n",
        contextLines: 2,
        traceId: "t-diff",
        site: "qwen"
      }
    });
    expect(diffRes.statusCode).toBe(200);
    const diffPayload = diffRes.json() as { data: { changed: boolean; unifiedDiff: string } };
    expect(diffPayload.data.changed).toBe(true);
    expect(diffPayload.data.unifiedDiff).toContain("---");

    const mvRes = await app.inject({
      method: "POST",
      url: "/v1/fs/mv",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        fromPath: targetFile,
        toPath: moveTarget,
        traceId: "t-mv",
        site: "qwen"
      }
    });
    expect(mvRes.statusCode).toBe(200);
    const movedContent = await fs.readFile(moveTarget, "utf8");
    expect(movedContent).toContain("TODO item");

    if (process.platform !== "win32") {
      const chmodRes = await app.inject({
        method: "POST",
        url: "/v1/fs/chmod",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          path: moveTarget,
          mode: "644",
          traceId: "t-chmod",
          site: "qwen"
        }
      });
      expect(chmodRes.statusCode).toBe(200);
    }

    const rmRes = await app.inject({
      method: "POST",
      url: "/v1/fs/rm",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        path: moveTarget,
        traceId: "t-rm",
        site: "qwen"
      }
    });
    expect(rmRes.statusCode).toBe(200);
    await expect(fs.stat(moveTarget)).rejects.toMatchObject({ code: "ENOENT" });

    const batchGood = path.join(tmpRoot, "batch", "a.txt");
    const batchBadDir = path.join(tmpRoot, "batch", "conflict-dir");
    await fs.mkdir(batchBadDir, { recursive: true });

    const batchPrepare = await app.inject({
      method: "POST",
      url: "/v1/fs/write-batch/prepare",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        files: [
          { path: batchGood, mode: "overwrite", content: "hello" },
          { path: batchBadDir, mode: "overwrite", content: "will-fail" }
        ],
        traceId: "t-batch-prepare",
        site: "qwen"
      }
    });
    expect(batchPrepare.statusCode).toBe(200);
    const batchOpId = (batchPrepare.json() as { data: { opId: string } }).data.opId;

    const batchCommit = await app.inject({
      method: "POST",
      url: "/v1/fs/write-batch/commit",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        opId: batchOpId,
        confirmedByUser: true,
        traceId: "t-batch-commit",
        site: "qwen"
      }
    });
    expect(batchCommit.statusCode).toBe(409);
    await expect(fs.stat(batchGood)).rejects.toMatchObject({ code: "ENOENT" });

    const processRun = await app.inject({
      method: "POST",
      url: "/v1/process/run",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        command: "node",
        args: ["-e", "console.log('proc-ok')"],
        cwd: tmpRoot,
        traceId: "t-proc",
        site: "qwen"
      }
    });
    expect(processRun.statusCode).toBe(200);
    const processPayload = processRun.json() as { data: { stdout: string; exitCode: number | null } };
    expect(processPayload.data.stdout).toContain("proc-ok");
    expect(processPayload.data.exitCode).toBe(0);

    const shellExec = await app.inject({
      method: "POST",
      url: "/v1/shell/exec",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        command: "node -e \"console.log('shell-ok')\"",
        cwd: tmpRoot,
        traceId: "t-shell",
        site: "qwen"
      }
    });
    expect(shellExec.statusCode).toBe(200);
    const shellPayload = shellExec.json() as { data: { stdout: string } };
    expect(shellPayload.data.stdout).toContain("shell-ok");

    expect(auditLogger.entries.length).toBeGreaterThan(0);
    await app.close();
  });
});
