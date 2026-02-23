/**
 * FlyCode Note: Hash helpers
 * Provides SHA-256 utility used for read metadata and write conflict validation.
 */
import { createHash } from "node:crypto";

export function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}
