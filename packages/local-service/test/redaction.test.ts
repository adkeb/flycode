/**
 * FlyCode Note: Redaction and budget tests
 * Checks regex-based secret masking and token budget truncation safeguards.
 */
import { describe, expect, it } from "vitest";
import { applyTokenBudget, estimateTokens } from "../src/services/token-budget.js";
import { DefaultRedactor } from "../src/services/redactor.js";
import type { PolicyConfig } from "../src/types.js";

describe("redaction and token budget", () => {
  const policy: PolicyConfig = {
    allowed_roots: ["."],
    deny_globs: [],
    site_allowlist: ["qwen"],
    limits: {
      max_file_bytes: 1000,
      max_inject_tokens: 4,
      max_search_matches: 10
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
      allowed_commands: ["node"],
      allowed_cwds: [],
      default_timeout_ms: 30_000,
      max_timeout_ms: 120_000,
      max_output_bytes: 200_000,
      allow_env_keys: ["CI"]
    },
    redaction: {
      enabled: true,
      rules: [
        {
          name: "api",
          pattern: "sk-[a-zA-Z0-9]{5,}",
          replacement: "***REDACTED***"
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

  it("redacts secret patterns", () => {
    const redactor = new DefaultRedactor(policy);
    const redacted = redactor.redact("token=sk-abcdefghi");
    expect(redacted.content).toContain("***REDACTED***");
    expect(redacted.changed).toBe(true);
  });

  it("truncates content by token budget", () => {
    const source = "012345678901234567890123456789";
    const result = applyTokenBudget(source, 4);
    expect(estimateTokens(source)).toBeGreaterThan(4);
    expect(result.truncated).toBe(true);
  });
});
