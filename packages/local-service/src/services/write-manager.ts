import { randomUUID } from "node:crypto";
import type { SiteId, WriteMode } from "@flycode/shared-types";
import type { FileService, PathPolicy, PendingWriteOp, PolicyConfig, WriteManager } from "../types.js";
import { AppError } from "../utils/errors.js";

export class InMemoryWriteManager implements WriteManager {
  private readonly pending = new Map<string, PendingWriteOp>();

  constructor(
    private readonly policy: PolicyConfig,
    private readonly pathPolicy: PathPolicy,
    private readonly fileService: FileService
  ) {}

  async prepare(input: {
    path: string;
    mode: WriteMode;
    content: string;
    traceId: string;
    site: SiteId;
    expectedSha256?: string;
    disableConfirmation?: boolean;
  }): Promise<{ opId: string; requireConfirmation: boolean; summary: string }> {
    this.cleanupExpired();
    const normalized = this.pathPolicy.normalizeInputPath(input.path);
    this.pathPolicy.assertAllowed(normalized);

    if (!input.content) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Write content cannot be empty"
      });
    }

    if (input.expectedSha256) {
      const existing = await this.fileService.existingSha256(normalized);
      if (existing && existing !== input.expectedSha256) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "expectedSha256 mismatch"
        });
      }
    }

    const disableAllowed = this.policy.write.allow_disable_confirmation && input.disableConfirmation === true;
    const requireConfirmation = this.policy.write.require_confirmation_default && !disableAllowed;

    const op: PendingWriteOp = {
      id: randomUUID(),
      path: normalized,
      mode: input.mode,
      content: input.content,
      requireConfirmation,
      traceId: input.traceId,
      site: input.site,
      expectedSha256: input.expectedSha256,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + this.policy.write.pending_ttl_seconds * 1000)
    };

    this.pending.set(op.id, op);

    return {
      opId: op.id,
      requireConfirmation: op.requireConfirmation,
      summary: `${op.mode} ${normalized} (${Buffer.byteLength(op.content)} bytes)`
    };
  }

  async commit(input: {
    opId: string;
    confirmedByUser: boolean;
    traceId: string;
    site: SiteId;
  }): Promise<{ path: string; writtenBytes: number; backupPath?: string; newSha256: string }> {
    this.cleanupExpired();

    const op = this.pending.get(input.opId);
    if (!op) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Write operation not found: ${input.opId}`
      });
    }

    if (op.site !== input.site) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: "Site mismatch for write operation"
      });
    }

    if (op.requireConfirmation && !input.confirmedByUser) {
      throw new AppError({
        statusCode: 409,
        code: "WRITE_CONFIRMATION_REQUIRED",
        message: "Write operation requires confirmation"
      });
    }

    const result = await this.fileService.commitWrite(op);
    this.pending.delete(op.id);
    return result;
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
