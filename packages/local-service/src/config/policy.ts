import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { PolicyConfig } from "../types.js";

const DEFAULT_POLICY: PolicyConfig = {
  allowed_roots: [process.cwd()],
  deny_globs: ["**/.git/**", "**/node_modules/**", "**/.env*"],
  site_allowlist: ["qwen", "deepseek"],
  limits: {
    max_file_bytes: 5 * 1024 * 1024,
    max_inject_tokens: 12_000,
    max_search_matches: 200
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
    allowed_commands: ["npm", "node", "git", "rg", "pnpm", "yarn"],
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
        name: "openai_api_key",
        pattern: "sk-[a-zA-Z0-9]{20,}",
        replacement: "***REDACTED***"
      },
      {
        name: "password_assignment",
        pattern: "(password\\s*[:=]\\s*)([^\\s\"']+)",
        replacement: "$1***REDACTED***",
        flags: "i"
      },
      {
        name: "private_key_block",
        pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]*PRIVATE KEY-----",
        replacement: "***REDACTED_PRIVATE_KEY***"
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

export function getFlycodeHomeDir(): string {
  return path.join(os.homedir(), ".flycode");
}

export function getPolicyFilePath(): string {
  return path.join(getFlycodeHomeDir(), "policy.yaml");
}

export async function loadPolicyConfig(): Promise<PolicyConfig> {
  const home = getFlycodeHomeDir();
  const policyPath = getPolicyFilePath();
  await fs.mkdir(home, { recursive: true });

  try {
    const raw = await fs.readFile(policyPath, "utf8");
    const parsed = YAML.parse(raw);
    const merged = mergePolicy(parsed ?? {});
    await fs.writeFile(policyPath, YAML.stringify(merged), "utf8");
    return merged;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    const initial = normalizePolicy(DEFAULT_POLICY);
    await fs.writeFile(policyPath, YAML.stringify(initial), "utf8");
    return initial;
  }
}

function mergePolicy(raw: unknown): PolicyConfig {
  const candidate = typeof raw === "object" && raw !== null ? (raw as Partial<PolicyConfig>) : {};

  const merged: PolicyConfig = {
    allowed_roots: Array.isArray(candidate.allowed_roots)
      ? candidate.allowed_roots.map(String)
      : DEFAULT_POLICY.allowed_roots,
    deny_globs: Array.isArray(candidate.deny_globs)
      ? candidate.deny_globs.map(String)
      : DEFAULT_POLICY.deny_globs,
    site_allowlist: Array.isArray(candidate.site_allowlist)
      ? candidate.site_allowlist.map(String)
      : DEFAULT_POLICY.site_allowlist,
    limits: {
      max_file_bytes: Number(candidate.limits?.max_file_bytes ?? DEFAULT_POLICY.limits.max_file_bytes),
      max_inject_tokens: Number(candidate.limits?.max_inject_tokens ?? DEFAULT_POLICY.limits.max_inject_tokens),
      max_search_matches: Number(candidate.limits?.max_search_matches ?? DEFAULT_POLICY.limits.max_search_matches)
    },
    write: {
      require_confirmation_default: Boolean(
        candidate.write?.require_confirmation_default ?? DEFAULT_POLICY.write.require_confirmation_default
      ),
      allow_disable_confirmation: Boolean(
        candidate.write?.allow_disable_confirmation ?? DEFAULT_POLICY.write.allow_disable_confirmation
      ),
      backup_on_overwrite: Boolean(candidate.write?.backup_on_overwrite ?? DEFAULT_POLICY.write.backup_on_overwrite),
      pending_ttl_seconds: Number(candidate.write?.pending_ttl_seconds ?? DEFAULT_POLICY.write.pending_ttl_seconds)
    },
    mutation: {
      allow_rm: Boolean(candidate.mutation?.allow_rm ?? DEFAULT_POLICY.mutation.allow_rm),
      allow_mv: Boolean(candidate.mutation?.allow_mv ?? DEFAULT_POLICY.mutation.allow_mv),
      allow_chmod: Boolean(candidate.mutation?.allow_chmod ?? DEFAULT_POLICY.mutation.allow_chmod),
      allow_write_batch: Boolean(candidate.mutation?.allow_write_batch ?? DEFAULT_POLICY.mutation.allow_write_batch)
    },
    process: {
      enabled: Boolean(candidate.process?.enabled ?? DEFAULT_POLICY.process.enabled),
      allowed_commands: Array.isArray(candidate.process?.allowed_commands)
        ? candidate.process.allowed_commands.map(String).filter(Boolean)
        : DEFAULT_POLICY.process.allowed_commands,
      allowed_cwds: Array.isArray(candidate.process?.allowed_cwds)
        ? candidate.process.allowed_cwds.map(String).filter(Boolean)
        : DEFAULT_POLICY.process.allowed_cwds,
      default_timeout_ms: Number(candidate.process?.default_timeout_ms ?? DEFAULT_POLICY.process.default_timeout_ms),
      max_timeout_ms: Number(candidate.process?.max_timeout_ms ?? DEFAULT_POLICY.process.max_timeout_ms),
      max_output_bytes: Number(candidate.process?.max_output_bytes ?? DEFAULT_POLICY.process.max_output_bytes),
      allow_env_keys: Array.isArray(candidate.process?.allow_env_keys)
        ? candidate.process.allow_env_keys.map(String).filter(Boolean)
        : DEFAULT_POLICY.process.allow_env_keys
    },
    redaction: {
      enabled: Boolean(candidate.redaction?.enabled ?? DEFAULT_POLICY.redaction.enabled),
      rules: Array.isArray(candidate.redaction?.rules)
        ? candidate.redaction!.rules!.map((rule) => ({
            name: String((rule as { name?: string }).name ?? "custom"),
            pattern: String((rule as { pattern?: string }).pattern ?? ""),
            replacement: (rule as { replacement?: string }).replacement,
            flags: (rule as { flags?: string }).flags
          })).filter((rule) => Boolean(rule.pattern))
        : DEFAULT_POLICY.redaction.rules
    },
    audit: {
      enabled: true,
      include_content_hash: Boolean(candidate.audit?.include_content_hash ?? DEFAULT_POLICY.audit.include_content_hash)
    },
    auth: {
      token_ttl_days: Number(candidate.auth?.token_ttl_days ?? DEFAULT_POLICY.auth.token_ttl_days),
      pair_code_ttl_minutes: Number(candidate.auth?.pair_code_ttl_minutes ?? DEFAULT_POLICY.auth.pair_code_ttl_minutes)
    }
  };

  return normalizePolicy(merged);
}

function normalizePolicy(policy: PolicyConfig): PolicyConfig {
  const maxTimeout = clamp(policy.process.max_timeout_ms, 1000, 10 * 60 * 1000);
  const defaultTimeout = Math.min(clamp(policy.process.default_timeout_ms, 1000, 10 * 60 * 1000), maxTimeout);

  return {
    ...policy,
    allowed_roots: policy.allowed_roots.map((root) => path.resolve(root)).filter(Boolean),
    limits: {
      max_file_bytes: clamp(policy.limits.max_file_bytes, 1, 100 * 1024 * 1024),
      max_inject_tokens: clamp(policy.limits.max_inject_tokens, 200, 200_000),
      max_search_matches: clamp(policy.limits.max_search_matches, 1, 10_000)
    },
    write: {
      ...policy.write,
      pending_ttl_seconds: clamp(policy.write.pending_ttl_seconds, 30, 3600)
    },
    process: {
      ...policy.process,
      allowed_commands: policy.process.allowed_commands.length > 0 ? policy.process.allowed_commands : ["node"],
      allowed_cwds: policy.process.allowed_cwds.map((cwd) => path.resolve(cwd)).filter(Boolean),
      default_timeout_ms: defaultTimeout,
      max_timeout_ms: maxTimeout,
      max_output_bytes: clamp(policy.process.max_output_bytes, 1024, 5 * 1024 * 1024),
      allow_env_keys: policy.process.allow_env_keys.filter(Boolean)
    },
    auth: {
      token_ttl_days: clamp(policy.auth.token_ttl_days, 1, 365),
      pair_code_ttl_minutes: clamp(policy.auth.pair_code_ttl_minutes, 1, 60)
    },
    audit: {
      enabled: true,
      include_content_hash: policy.audit.include_content_hash
    },
    mutation: {
      ...policy.mutation
    }
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(Math.floor(value), min), max);
}
