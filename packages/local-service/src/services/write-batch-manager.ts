import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SiteId, WriteMode } from "@flycode/shared-types";
import type {
  FileService,
  PathPolicy,
  PendingWriteBatchOp,
  PendingWriteOp,
  PolicyConfig,
  WriteBatchManager
} from "../types.js";
import { AppError } from "../utils/errors.js";

interface FileSnapshot {
  path: string;
  existed: boolean;
  content?: Buffer;
}

export class InMemoryWriteBatchManager implements WriteBatchManager {
  private readonly pending = new Map<string, PendingWriteBatchOp>();

  constructor(
    private readonly policy: PolicyConfig,
    private readonly pathPolicy: PathPolicy,
    private readonly fileService: FileService
  ) {}

  async prepare(input: {
    files: Array<{ path: string; mode?: WriteMode; content: string; expectedSha256?: string }>;
    traceId: string;
    site: SiteId;
    disableConfirmation?: boolean;
  }): Promise<{ opId: string; requireConfirmation: boolean; summary: string; totalFiles: number; totalBytes: number }> {
    this.cleanupExpired();
    this.assertAllowed();

    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "writeBatch.files cannot be empty"
      });
    }

    const normalizedFiles: PendingWriteBatchOp["files"] = [];
    let totalBytes = 0;

    for (const [index, file] of input.files.entries()) {
      if (!file || typeof file !== "object") {
        throw new AppError({
          statusCode: 422,
          code: "INVALID_INPUT",
          message: `Invalid file item at index ${index}`
        });
      }

      const normalizedPath = this.pathPolicy.normalizeInputPath(String(file.path ?? ""));
      this.pathPolicy.assertAllowed(normalizedPath);
      const mode: WriteMode = file.mode === "append" ? "append" : "overwrite";
      const content = String(file.content ?? "");
      const expectedSha256 = file.expectedSha256 ? String(file.expectedSha256) : undefined;

      if (expectedSha256) {
        const existing = await this.fileService.existingSha256(normalizedPath);
        if (existing && existing !== expectedSha256) {
          throw new AppError({
            statusCode: 409,
            code: "CONFLICT",
            message: `expectedSha256 mismatch at index ${index}`
          });
        }
      }

      totalBytes += Buffer.byteLength(content);
      normalizedFiles.push({
        path: normalizedPath,
        mode,
        content,
        expectedSha256
      });
    }

    const disableAllowed = this.policy.write.allow_disable_confirmation && input.disableConfirmation === true;
    const requireConfirmation = this.policy.write.require_confirmation_default && !disableAllowed;

    const op: PendingWriteBatchOp = {
      id: randomUUID(),
      files: normalizedFiles,
      requireConfirmation,
      traceId: input.traceId,
      site: input.site,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + this.policy.write.pending_ttl_seconds * 1000)
    };

    this.pending.set(op.id, op);

    return {
      opId: op.id,
      requireConfirmation: op.requireConfirmation,
      summary: `writeBatch ${normalizedFiles.length} files (${totalBytes} bytes)`,
      totalFiles: normalizedFiles.length,
      totalBytes
    };
  }

  async commit(input: {
    opId: string;
    confirmedByUser: boolean;
    traceId: string;
    site: SiteId;
  }): Promise<{ files: Array<{ path: string; mode: WriteMode; writtenBytes: number; backupPath?: string; newSha256: string }> }> {
    this.cleanupExpired();
    this.assertAllowed();

    const op = this.pending.get(input.opId);
    if (!op) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Write batch operation not found: ${input.opId}`
      });
    }

    if (op.site !== input.site) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: "Site mismatch for write batch operation"
      });
    }

    if (op.requireConfirmation && !input.confirmedByUser) {
      throw new AppError({
        statusCode: 409,
        code: "WRITE_CONFIRMATION_REQUIRED",
        message: "Write batch operation requires confirmation"
      });
    }

    const snapshots: FileSnapshot[] = [];
    const results: Array<{ path: string; mode: WriteMode; writtenBytes: number; backupPath?: string; newSha256: string }> = [];
    let failedIndex = -1;

    try {
      for (let i = 0; i < op.files.length; i += 1) {
        failedIndex = i;
        const file = op.files[i];

        const existing = await safeStat(file.path);
        if (existing?.isDirectory()) {
          throw new AppError({
            statusCode: 409,
            code: "CONFLICT",
            message: `Target path is a directory at index ${i}: ${file.path}`
          });
        }

        if (existing?.isFile()) {
          const content = await fs.readFile(file.path);
          snapshots.push({ path: file.path, existed: true, content });
        } else {
          snapshots.push({ path: file.path, existed: false });
        }

        const writeOp: PendingWriteOp = {
          id: randomUUID(),
          path: file.path,
          mode: file.mode,
          content: file.content,
          requireConfirmation: false,
          traceId: input.traceId,
          site: input.site,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + this.policy.write.pending_ttl_seconds * 1000),
          expectedSha256: file.expectedSha256
        };

        const committed = await this.fileService.commitWrite(writeOp);
        results.push({
          path: committed.path,
          mode: file.mode,
          writtenBytes: committed.writtenBytes,
          backupPath: committed.backupPath,
          newSha256: committed.newSha256
        });
      }

      this.pending.delete(op.id);
      return { files: results };
    } catch (error: unknown) {
      const rollbackErrors = await rollbackSnapshots(snapshots);
      this.pending.delete(op.id);

      const detail = error instanceof AppError ? error.message : (error as Error).message;
      const rollbackInfo =
        rollbackErrors.length === 0
          ? "Rollback succeeded."
          : `Rollback errors: ${rollbackErrors.join("; ")}`;

      throw new AppError({
        statusCode: error instanceof AppError ? error.statusCode : 500,
        code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
        message: `writeBatch failed at index ${failedIndex}: ${detail}. ${rollbackInfo}`
      });
    }
  }

  private assertAllowed(): void {
    if (!this.policy.mutation.allow_write_batch) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: "writeBatch is disabled by policy"
      });
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [opId, op] of this.pending.entries()) {
      if (op.expiresAt.getTime() <= now) {
        this.pending.delete(opId);
      }
    }
  }
}

async function safeStat(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function rollbackSnapshots(snapshots: FileSnapshot[]): Promise<string[]> {
  const errors: string[] = [];
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const snapshot = snapshots[i];
    try {
      if (snapshot.existed) {
        await fs.writeFile(snapshot.path, snapshot.content ?? Buffer.alloc(0));
      } else {
        await fs.rm(snapshot.path, { recursive: false, force: true });
      }
    } catch (error: unknown) {
      errors.push(`${snapshot.path}: ${(error as Error).message}`);
    }
  }
  return errors;
}
