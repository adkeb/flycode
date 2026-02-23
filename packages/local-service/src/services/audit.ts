import fs from "node:fs/promises";
import path from "node:path";
import { getFlycodeHomeDir } from "../config/policy.js";
import type { AuditEntry, AuditLogger } from "../types.js";

export class FileAuditLogger implements AuditLogger {
  private readonly auditDir: string;

  constructor() {
    this.auditDir = path.join(getFlycodeHomeDir(), "audit");
  }

  async log(entry: AuditEntry): Promise<void> {
    await fs.mkdir(this.auditDir, { recursive: true });
    const fileName = `${entry.timestamp.slice(0, 10)}.jsonl`;
    const fullPath = path.join(this.auditDir, fileName);
    await fs.appendFile(fullPath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
