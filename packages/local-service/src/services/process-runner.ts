/**
 * FlyCode Note: Process execution sandbox
 * Runs allowed commands with cwd/timeout/output limits, then redacts and truncates command output safely.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { applyTokenBudget } from "./token-budget.js";
import type { PathPolicy, PolicyConfig, ProcessRunner, Redactor } from "../types.js";
import { AppError } from "../utils/errors.js";

interface SpawnInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  displayCommand: string;
}

export class DefaultProcessRunner implements ProcessRunner {
  constructor(
    private readonly policy: PolicyConfig,
    private readonly pathPolicy: PathPolicy,
    private readonly redactor: Redactor
  ) {}

  async run(input: {
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<{
    command: string;
    cwd: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    truncated: boolean;
  }> {
    this.assertEnabled();
    const commandName = normalizeCommandName(input.command);
    this.assertCommandAllowed(commandName);

    const cwd = this.resolveCwd(input.cwd);
    const timeoutMs = this.resolveTimeout(input.timeoutMs);
    const env = this.buildEnv(input.env);
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const displayCommand = [input.command, ...args].join(" ").trim();

    return spawnAndCollect({
      command: input.command,
      args,
      cwd,
      timeoutMs,
      env,
      shell: false,
      displayCommand
    }, this.policy, this.redactor);
  }

  async exec(input: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<{
    command: string;
    cwd: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    truncated: boolean;
  }> {
    this.assertEnabled();

    const first = firstToken(input.command);
    if (!first) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "shell.exec command cannot be empty"
      });
    }
    this.assertCommandAllowed(normalizeCommandName(first));

    const cwd = this.resolveCwd(input.cwd);
    const timeoutMs = this.resolveTimeout(input.timeoutMs);
    const env = this.buildEnv(input.env);

    return spawnAndCollect({
      command: input.command,
      args: [],
      cwd,
      timeoutMs,
      env,
      shell: true,
      displayCommand: input.command
    }, this.policy, this.redactor);
  }

  private assertEnabled(): void {
    if (!this.policy.process.enabled) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: "Process execution is disabled by policy"
      });
    }
  }

  private assertCommandAllowed(commandName: string): void {
    const allowed = new Set(this.policy.process.allowed_commands.map((item) => normalizeCommandName(item)));
    if (!allowed.has(commandName)) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: `Command is not allowed by policy: ${commandName}`
      });
    }
  }

  private resolveCwd(inputCwd: string | undefined): string {
    const candidate = inputCwd?.trim();
    const defaultCwd = this.policy.process.allowed_cwds[0] ?? this.policy.allowed_roots[0] ?? process.cwd();
    const normalized = this.pathPolicy.normalizeInputPath(candidate || defaultCwd);
    this.pathPolicy.assertAllowed(normalized);
    return normalized;
  }

  private resolveTimeout(requested: number | undefined): number {
    const defaultTimeout = this.policy.process.default_timeout_ms;
    const maxTimeout = this.policy.process.max_timeout_ms;
    const raw = Number.isFinite(requested) ? Number(requested) : defaultTimeout;
    const clamped = Math.max(100, Math.min(Math.floor(raw), maxTimeout));
    return clamped;
  }

  private buildEnv(input: Record<string, string> | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const safeBaseKeys = ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "HOME", "USERPROFILE", "TMP", "TEMP"];
    for (const key of safeBaseKeys) {
      const value = process.env[key];
      if (typeof value === "string") {
        env[key] = value;
      }
    }

    if (!input) {
      return env;
    }

    const allowed = new Set(this.policy.process.allow_env_keys);
    for (const [key, value] of Object.entries(input)) {
      if (!allowed.has(key)) {
        continue;
      }
      env[key] = String(value);
    }

    return env;
  }
}

async function spawnAndCollect(
  input: SpawnInput,
  policy: PolicyConfig,
  redactor: Redactor
): Promise<{
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}> {
  const startedAt = Date.now();
  const maxBytes = policy.process.max_output_bytes;

  const stdoutBuffers: Buffer[] = [];
  const stderrBuffers: Buffer[] = [];
  let capturedBytes = 0;
  let timedOut = false;
  let truncated = false;
  let finished = false;

  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    shell: input.shell,
    windowsHide: true
  });

  const forceStop = () => {
    if (finished) {
      return;
    }
    child.kill("SIGTERM");
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    forceStop();
  }, input.timeoutMs);

  const appendChunk = (target: Buffer[], chunk: Buffer) => {
    if (capturedBytes >= maxBytes) {
      truncated = true;
      forceStop();
      return;
    }

    const remaining = maxBytes - capturedBytes;
    if (chunk.length > remaining) {
      target.push(chunk.subarray(0, remaining));
      capturedBytes = maxBytes;
      truncated = true;
      forceStop();
      return;
    }

    target.push(chunk);
    capturedBytes += chunk.length;
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    appendChunk(stdoutBuffers, buffer);
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    appendChunk(stderrBuffers, buffer);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve(code));
  }).catch((error: unknown) => {
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: `Failed to execute command: ${(error as Error).message}`
    });
  }).finally(() => {
    finished = true;
    clearTimeout(timeout);
  });

  const stdoutText = Buffer.concat(stdoutBuffers).toString("utf8");
  const stderrText = Buffer.concat(stderrBuffers).toString("utf8");
  const stdoutRedacted = redactor.redact(stdoutText).content;
  const stderrRedacted = redactor.redact(stderrText).content;
  const stdoutBudgeted = applyTokenBudget(stdoutRedacted, policy.limits.max_inject_tokens);
  const stderrBudgeted = applyTokenBudget(stderrRedacted, policy.limits.max_inject_tokens);

  return {
    command: input.displayCommand || path.basename(input.command),
    cwd: input.cwd,
    exitCode,
    stdout: stdoutBudgeted.content,
    stderr: stderrBudgeted.content,
    durationMs: Date.now() - startedAt,
    timedOut,
    truncated: truncated || stdoutBudgeted.truncated || stderrBudgeted.truncated
  };
}

function normalizeCommandName(command: string): string {
  const normalized = path.basename(command.trim()).toLowerCase();
  return normalized.replace(/(\.exe|\.cmd|\.bat|\.ps1)$/i, "");
}

function firstToken(value: string): string | null {
  const input = value.trim();
  if (!input) {
    return null;
  }

  if (input[0] === "\"" || input[0] === "'") {
    const quote = input[0];
    const end = input.indexOf(quote, 1);
    if (end > 1) {
      return input.slice(1, end);
    }
  }

  const match = input.match(/^\S+/);
  return match ? match[0] : null;
}
