import path from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultPathPolicy } from "../src/services/path-policy.js";
import type { PolicyConfig } from "../src/types.js";

describe("DefaultPathPolicy", () => {
  const policy: PolicyConfig = {
    allowed_roots: ["/tmp/project"],
    deny_globs: ["**/.env*"],
    site_allowlist: ["qwen", "deepseek"],
    limits: {
      max_file_bytes: 1024,
      max_inject_tokens: 1000,
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
      allowed_commands: ["node"],
      allowed_cwds: [],
      default_timeout_ms: 30_000,
      max_timeout_ms: 120_000,
      max_output_bytes: 200_000,
      allow_env_keys: ["CI"]
    },
    redaction: {
      enabled: true,
      rules: []
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

  it("normalizes windows path to /mnt on linux/wsl runtime", () => {
    const pathPolicy = new DefaultPathPolicy(policy, "linux");
    const normalized = pathPolicy.normalizeInputPath("C:\\Users\\dev\\app\\file.txt");
    expect(normalized).toBe("/mnt/c/Users/dev/app/file.txt");
  });

  it("normalizes /mnt path to windows path on win32 runtime", () => {
    const pathPolicy = new DefaultPathPolicy(
      {
        ...policy,
        allowed_roots: ["C:\\Users\\dev\\app"]
      },
      "win32"
    );
    const normalized = pathPolicy.normalizeInputPath("/mnt/c/Users/dev/app/file.txt");
    expect(normalized).toBe("C:\\Users\\dev\\app\\file.txt");
  });

  it("keeps windows absolute path on win32 runtime", () => {
    const pathPolicy = new DefaultPathPolicy(
      {
        ...policy,
        allowed_roots: ["C:\\Users\\dev\\app"]
      },
      "win32"
    );
    const normalized = pathPolicy.normalizeInputPath("C:\\Users\\dev\\app\\file.txt");
    expect(normalized).toBe("C:\\Users\\dev\\app\\file.txt");
  });

  it("blocks path outside allowed roots", () => {
    const pathPolicy = new DefaultPathPolicy(policy);
    expect(() => pathPolicy.assertAllowed("/etc/passwd")).toThrowError(/outside allowed roots/i);
  });

  it("blocks deny glob paths", () => {
    const pathPolicy = new DefaultPathPolicy({
      ...policy,
      allowed_roots: [path.resolve("/tmp/project")]
    });
    expect(() => pathPolicy.assertAllowed("/tmp/project/.env")).toThrowError(/deny pattern/i);
  });
});
