/**
 * FlyCode Note: Sensitive data redaction
 * Compiles configured regex rules and masks matching content before data is returned to browser pages.
 */
import type { PolicyConfig, Redactor, RedactionRule } from "../types.js";

interface CompiledRule {
  name: string;
  regex: RegExp;
  replacement: string;
}

export class DefaultRedactor implements Redactor {
  private readonly enabled: boolean;
  private readonly rules: CompiledRule[];

  constructor(policy: PolicyConfig) {
    this.enabled = policy.redaction.enabled;
    this.rules = compileRules(policy.redaction.rules);
  }

  redact(content: string): { content: string; changed: boolean } {
    if (!this.enabled || this.rules.length === 0 || content.length === 0) {
      return { content, changed: false };
    }

    let out = content;
    let changed = false;

    for (const rule of this.rules) {
      const next = out.replace(rule.regex, rule.replacement);
      if (next !== out) {
        changed = true;
      }
      out = next;
    }

    return { content: out, changed };
  }
}

function compileRules(rules: RedactionRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    try {
      const flags = normalizeFlags(rule.flags);
      compiled.push({
        name: rule.name,
        regex: new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`),
        replacement: rule.replacement ?? "***REDACTED***"
      });
    } catch {
      // Ignore invalid user rules so the service can still start.
    }
  }
  return compiled;
}

function normalizeFlags(flags: string | undefined): string {
  if (!flags) {
    return "";
  }

  return [...new Set(flags.split("").filter((flag) => "gimsuy".includes(flag)))].join("");
}
