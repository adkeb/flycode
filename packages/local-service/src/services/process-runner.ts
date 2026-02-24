/**
 * =============================================================================
 * FlyCode V2 - 进程执行沙箱
 * =============================================================================
 * 
 * 【文件作用】
 * 这是 FlyCode 的"命令执行器"，负责安全地运行外部命令和 shell 脚本。
 * 提供两种执行模式：
 * 1. run(): 执行命令（不经过 shell，更安全）
 * 2. exec(): 执行 shell 命令（支持管道/重定向，功能更强但风险更高）
 * 
 * 【为什么需要进程沙箱？】
 * - 安全隔离：防止 AI 执行任意命令破坏系统
 * - 资源控制：限制超时时间、输出大小，防止资源耗尽
 * - 审计追踪：记录所有命令执行，便于追溯
 * - 输出脱敏：自动隐藏命令输出中的敏感信息
 * 
 * 【安全检查流程】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 1. 策略检查：policy.process.enabled 是否允许执行         │
 * │ 2. 命令白名单：command 是否在 allowed_commands 中         │
 * │ 3. 工作目录：cwd 是否在 allowed_cwds/allowed_roots 内     │
 * │ 4. 环境变量：只传递 allow_env_keys 白名单中的变量        │
 * │ 5. 超时控制：timeout 不超过 max_timeout_ms               │
 * │ 6. 输出限制：stdout/stderr 不超过 max_output_bytes       │
 * │ 7. 内容脱敏：输出经过 redactor 处理                      │
 * │ 8. Token 预算：输出经过 applyTokenBudget 控制             │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手学习重点】
 * - run() vs exec(): 安全与功能的权衡
 * - 命令白名单机制：防止任意代码执行
 * - spawn + 流式收集：高效处理命令输出
 * - 超时和输出限制的优雅处理
 * - 环境变量白名单：防止敏感变量泄露
 * 
 * @moduleflycode/local-service/services/process-runner
 * @security-critical
 */

// =============================================================================
// 第一部分：导入依赖
// =============================================================================

/**
 * 【Node.js 原生模块】
 * - path: 路径处理（解析命令名、拼接路径）
 * - child_process.spawn: 创建子进程执行命令
 */
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * 【内部工具】
 * - applyTokenBudget: 控制输出 Token 数量，防止 AI 上下文溢出
 */
import { applyTokenBudget } from "./token-budget.js";

/**
 * 【内部类型】
 * - PathPolicy: 路径策略检查器
 * - PolicyConfig: 策略配置
 * - ProcessRunner: 本类实现的接口
 * - Redactor: 敏感信息脱敏器
 */
import type { PathPolicy, PolicyConfig, ProcessRunner, Redactor } from "../types.js";

/**
 * 【AppError - 统一错误类】
 * 用于抛出策略阻止、参数错误等异常
 */
import { AppError } from "../utils/errors.js";

// =============================================================================
// 第二部分：内部类型定义
// =============================================================================

/**
 * 【SpawnInput - spawn 函数的输入参数】
 * 
 * 作用：封装 spawnAndCollect() 函数所需的所有参数
 * 将 run() 和 exec() 的公共逻辑提取为此接口
 * 
 * 【字段说明】
 * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
 * │ 字段              │ 说明                                    │ 示例         │
 * ├──────────────────┼────────────────────────────────────────┼─────────────┤
 * │ command          │ 要执行的命令或 shell 字符串             │ "npm" 或 "ls | grep ts" │
 * │ args             │ 命令参数数组（shell=false 时使用）      │ ["install"]  │
 * │ cwd              │ 工作目录（绝对路径）                    │ "/root/work" │
 * │ timeoutMs        │ 超时时间（毫秒）                        │ 30000        │
 * │ env              │ 环境变量（已过滤白名单）                │ {PATH: "..."}│
 * │ shell            │ 是否通过 shell 执行                     │ true/false   │
 * │ displayCommand   │ 用于日志显示的命令字符串                │ "npm install"│
 * └──────────────────┴────────────────────────────────────────┴─────────────┘
 * 
 * @private
 */
interface SpawnInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  displayCommand: string;
}

// =============================================================================
// 第三部分：DefaultProcessRunner 类
// =============================================================================

/**
 * 【DefaultProcessRunner - 默认进程执行器实现】
 * 
 * 作用：实现 ProcessRunner 接口，提供安全的命令执行功能
 * 
 * 【设计特点】
 * 1. 依赖注入：构造函数接收 policy/pathPolicy/redactor
 * 2. 双重接口：run() 安全模式 + exec() 灵活模式
 * 3. 流式收集：使用 Buffer 数组收集输出，避免内存溢出
 * 4. 优雅降级：超时/输出超限时优雅终止进程
 * 
 * 【新手示例 - 实例化】
 * const runner = new DefaultProcessRunner(
 *   policyConfig,      // 策略配置
 *   pathPolicy,        // 路径检查器
 *   redactor           // 脱敏器
 * );
 * 
 * // 使用 run() 执行 npm install
 * const result = await runner.run({
 *   command: "npm",
 *   args: ["install"],
 *   cwd: "/root/work/flycode",
 *   timeoutMs: 60000
 * });
 * console.log(`退出码：${result.exitCode}`);
 * console.log(`输出：${result.stdout}`);
 * 
 * // 使用 exec() 执行带管道的命令
 * const result = await runner.exec({
 *   command: "grep -r 'function' src/ | head -20",
 *   cwd: "/root/work/flycode",
 *   timeoutMs: 30000
 * });
 */
export class DefaultProcessRunner implements ProcessRunner {
  /**
   * 【构造函数】
   * 
   * 作用：初始化进程执行器，注入必要依赖
   * 
   * @param policy - 策略配置（控制开关、白名单、限制等）
   * @param pathPolicy - 路径策略检查器（验证 cwd）
   * @param redactor - 敏感信息脱敏器（处理输出）
   */
  constructor(
    private readonly policy: PolicyConfig,
    private readonly pathPolicy: PathPolicy,
    private readonly redactor: Redactor
  ) {}

  // ===========================================================================
  // 方法 1: run - 执行命令（安全模式，不经过 shell）
  // ===========================================================================

  /**
   * 【run - 执行命令（安全模式）】
   * 
   * 作用：执行指定的命令，不经过 shell 解析
   * 
   * 【为什么更安全？】
   * - 命令和参数分离，防止 shell 注入攻击
   * - 不支持管道、重定向等 shell 特性，减少攻击面
   * - 参数作为数组传递，自动处理空格和特殊字符
   * 
   * 【参数详解】
   * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
   * │ 参数名            │ 说明                                    │ 示例         │
   * ├──────────────────┼────────────────────────────────────────┼─────────────┤
   * │ command          │ 命令名称（必须在白名单中）              │ "npm"        │
   * │ args             │ 命令参数数组                            │ ["install"]  │
   * │ cwd              │ 工作目录（可选，默认策略配置）          │ "/root/work" │
   * │ timeoutMs        │ 超时时间（可选，受策略限制）            │ 60000        │
   * │ env              │ 环境变量（可选，受白名单限制）          │ {NODE_ENV}   │
   * └──────────────────┴────────────────────────────────────────┴─────────────┘
   * 
   * 【返回值】
   * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
   * │ 字段              │ 说明                                    │ 示例         │
   * ├──────────────────┼────────────────────────────────────────┼─────────────┤
   * │ command          │ 执行的命令字符串                        │ "npm install"│
   * │ cwd              │ 实际工作目录                            │ "/root/work" │
   * │ exitCode         │ 进程退出码（null=未正常退出）           │ 0            │
   * │ stdout           │ 标准输出（已脱敏+Token 控制）            │ "..."        │
   * │ stderr           │ 标准错误（已脱敏+Token 控制）            │ "..."        │
   * │ durationMs       │ 执行耗时（毫秒）                        │ 5432         │
   * │ timedOut         │ 是否因超时被终止                        │ false        │
   * │ truncated        │ 输出是否被截断                          │ false        │
   * └──────────────────┴────────────────────────────────────────┴─────────────┘
   * 
   * 【新手示例 - 运行 npm install】
   * const result = await runner.run({
   *   command: "npm",
   *   args: ["install", "--save"],
   *   cwd: "/root/work/flycode",
   *   timeoutMs: 120000,
   *   env: { NODE_ENV: "production" }
   * });
   * 
   * if (result.exitCode === 0) {
   *   console.log("安装成功");
   *   console.log(result.stdout);
   * } else {
   *   console.error("安装失败:", result.stderr);
   * }
   * 
   * 【安全检查流程】
   * 1. assertEnabled(): 检查 policy.process.enabled
   * 2. normalizeCommandName(): 标准化命令名（去掉.exe 等后缀）
   * 3. assertCommandAllowed(): 检查命令是否在白名单中
   * 4. resolveCwd(): 解析并验证工作目录
   * 5. resolveTimeout(): 解析并限制超时时间
   * 6. buildEnv(): 构建并过滤环境变量
   * 7. spawnAndCollect(): 执行命令并收集输出
   */
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
    // ── 步骤 1: 检查进程执行是否启用 ──
    this.assertEnabled();

    // ── 步骤 2: 标准化并检查命令白名单 ──
    // normalizeCommandName: "npm.exe" → "npm" (去掉后缀)
    const commandName = normalizeCommandName(input.command);
    this.assertCommandAllowed(commandName);

    // ── 步骤 3: 解析工作目录 ──
    // 验证 cwd 是否在 allowed_cwds 或 allowed_roots 内
    const cwd = this.resolveCwd(input.cwd);

    // ── 步骤 4: 解析超时时间 ──
    // 限制在 [100ms, max_timeout_ms] 范围内
    const timeoutMs = this.resolveTimeout(input.timeoutMs);

    // ── 步骤 5: 构建环境变量 ──
    // 只包含安全基础变量 + allow_env_keys 白名单中的变量
    const env = this.buildEnv(input.env);

    // ── 步骤 6: 标准化参数 ──
    // 确保 args 是字符串数组
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    
    // ── 步骤 7: 构建显示命令（用于日志） ──
    const displayCommand = [input.command, ...args].join(" ").trim();

    // ── 步骤 8: 执行命令并收集输出 ──
    // shell: false 表示不经过 shell，更安全
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

  // ===========================================================================
  // 方法 2: exec - 执行 shell 命令（灵活模式，经过 shell）
  // ===========================================================================

  /**
   * 【exec - 执行 shell 命令（灵活模式）】
   * 
   * 作用：通过 shell 执行命令字符串，支持管道、重定向等特性
   * 
   * 【为什么更灵活？】
   * - 支持 shell 语法：管道 (|)、重定向 (>)、变量 ($VAR) 等
   * - 适合复杂命令：如 "grep -r 'foo' src/ | head -20"
   * 
   * 【为什么风险更高？】
   * - shell 注入风险：用户输入可能被解释为 shell 命令
   * 因此 command 参数必须是常量或严格验证的字符串
   * 
   * 【参数详解】
   * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
   * │ 参数名            │ 说明                                    │ 示例         │
   * ├──────────────────┼────────────────────────────────────────┼─────────────┤
   * │ command          │ 完整的 shell 命令字符串                 │ "ls | grep ts"│
   * │ cwd              │ 工作目录（可选）                        │ "/root/work" │
   * │ timeoutMs        │ 超时时间（可选）                        │ 30000        │
   * │ env              │ 环境变量（可选）                        │ {NODE_ENV}   │
   * └──────────────────┴────────────────────────────────────────┴─────────────┘
   * 
   * 【新手示例 - 执行带管道的命令】
   * const result = await runner.exec({
   *   command: "grep -r 'function' src/ | head -20",
   *   cwd: "/root/work/flycode",
   *   timeoutMs: 30000
   * });
   * console.log(result.stdout);
   * 
   * 【安全检查】
   * 1. 提取命令字符串的第一个 token 作为命令名
   * 2. 检查该命令名是否在 allowed_commands 白名单中
   * 3. 其他安全检查同 run() 方法
   * 
   * 【run() vs exec() 选择指南】
   * ┌─────────────────────────────────────────────────────────┐
   * │ 场景                      │ 推荐方法  │ 原因              │
   * ├───────────────────────────┼───────────┼───────────────────┤
   * │ 执行 npm/git 等标准命令   │ run()     │ 更安全，参数分离  │
   * │ 需要管道/重定向           │ exec()    │ shell 特性必需    │
   │ 用户输入作为命令参数       │ run()     │ 防止 shell 注入   │
   * │ 执行复杂 shell 脚本       │ exec()    │ 需要 shell 解析   │
   * └───────────────────────────┴───────────┴───────────────────┘
   */
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
    // ── 步骤 1: 检查进程执行是否启用 ──
    this.assertEnabled();

    // ── 步骤 2: 提取命令名的第一个 token ──
    // exec 的 command 是完整 shell 字符串，需要提取第一个词作为命令名
    const first = firstToken(input.command);
    if (!first) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "shell.exec command cannot be empty"
      });
    }
    
    // 检查提取的命令名是否在白名单中
    this.assertCommandAllowed(normalizeCommandName(first));

    // ── 步骤 3-5: 同 run() 方法 ──
    const cwd = this.resolveCwd(input.cwd);
    const timeoutMs = this.resolveTimeout(input.timeoutMs);
    const env = this.buildEnv(input.env);

    // ── 步骤 6: 执行命令 ──
    // shell: true 表示通过 shell 执行，支持管道等特性
    return spawnAndCollect({
      command: input.command,  // 完整 shell 字符串
      args: [],                 // exec 不使用 args 数组
      cwd,
      timeoutMs,
      env,
      shell: true,
      displayCommand: input.command
    }, this.policy, this.redactor);
  }

  // ===========================================================================
  // 私有辅助方法
  // ===========================================================================

  /**
   * 【assertEnabled - 检查进程执行是否启用】
   * 
   * 作用：验证 policy.process.enabled 是否为 true
   * 
   * 【新手示例】
   * // 如果 policy.process.enabled = false
   * this.assertEnabled();
   * // 抛出: 403 FORBIDDEN - Process execution is disabled by policy
   */
  private assertEnabled(): void {
    if (!this.policy.process.enabled) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: "Process execution is disabled by policy"
      });
    }
  }

  /**
   * 【assertCommandAllowed - 检查命令是否允许】
   * 
   * 作用：验证命令名是否在 policy.process.allowed_commands 白名单中
   * 
   * 【新手示例】
   * // 假设 allowed_commands = ["npm", "node", "git"]
   * this.assertCommandAllowed("npm");      // ✓ 通过
   * this.assertCommandAllowed("NPM");      // ✓ 通过（不区分大小写）
   * this.assertCommandAllowed("curl");     // ✗ 403 FORBIDDEN
   * 
   * 【安全原理】
   * 白名单机制确保只能执行预先批准的命令
   * 防止 AI 执行任意命令（如 rm -rf /）
   */
  private assertCommandAllowed(commandName: string): void {
    // 将 allowed_commands 标准化后存入 Set，便于快速查找
    // normalizeCommandName: 去掉.exe/.cmd 等后缀，转小写
    const allowed = new Set(
      this.policy.process.allowed_commands.map((item) => normalizeCommandName(item))
    );
    
    if (!allowed.has(commandName)) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: `Command is not allowed by policy: ${commandName}`
      });
    }
  }

  /**
   * 【resolveCwd - 解析工作目录】
   * 
   * 作用：解析并验证命令的工作目录
   * 
   * 【优先级】
   * 1. 用户传入的 inputCwd（如果提供且有效）
   * 2. policy.process.allowed_cwds[0]（策略配置的首选目录）
   * 3. policy.allowed_roots[0]（策略配置的首选根目录）
   * 4. process.cwd()（当前进程工作目录，最后兜底）
   * 
   * 【安全检查】
   * 1. pathPolicy.normalizeInputPath(): 标准化为绝对路径
   * 2. pathPolicy.assertAllowed(): 验证在 allowed_roots 内
   * 
   * 【新手示例】
   * // 假设 allowed_roots = ["/root/work/flycode"]
   * resolveCwd("./src")
   * // → "/root/work/flycode/src" (标准化 + 验证通过)
   * 
   * resolveCwd("/etc")
   * // → 抛出: 403 POLICY_BLOCKED - Path is outside allowed roots
   */
  private resolveCwd(inputCwd: string | undefined): string {
    const candidate = inputCwd?.trim();
    
    // 确定默认目录的优先级
    const defaultCwd = this.policy.process.allowed_cwds[0] ?? 
                       this.policy.allowed_roots[0] ?? 
                       process.cwd();
    
    // 标准化路径（解析../, ~/等）
    const normalized = this.pathPolicy.normalizeInputPath(candidate || defaultCwd);
    
    // 验证路径是否允许访问
    this.pathPolicy.assertAllowed(normalized);
    
    return normalized;
  }

  /**
   * 【resolveTimeout - 解析超时时间】
   * 
   * 作用：解析用户请求的超时时间，并限制在策略范围内
   * 
   * 【限制规则】
   * - 最小值：100ms（防止过短的超时导致误判）
   * - 最大值：policy.process.max_timeout_ms（策略配置）
   * - 默认值：policy.process.default_timeout_ms（用户未指定时）
   * 
   * 【新手示例】
   * // 假设 default=30000, max=120000
   * resolveTimeout(60000)   // → 60000 (在范围内)
   * resolveTimeout(50)      // → 100 (低于最小值，提升到 100)
   * resolveTimeout(200000)  // → 120000 (超过最大值，限制到 120000)
   * resolveTimeout(undefined) // → 30000 (使用默认值)
   */
  private resolveTimeout(requested: number | undefined): number {
    const defaultTimeout = this.policy.process.default_timeout_ms;
    const maxTimeout = this.policy.process.max_timeout_ms;
    
    // 如果用户提供了有效数字则使用，否则用默认值
    const raw = Number.isFinite(requested) ? Number(requested) : defaultTimeout;
    
    // 限制在 [100, maxTimeout] 范围内
    const clamped = Math.max(100, Math.min(Math.floor(raw), maxTimeout));
    
    return clamped;
  }

  /**
   * 【buildEnv - 构建环境变量】
   * 
   * 作用：构建命令执行的环境变量，只包含白名单中的变量
   * 
   * 【环境变量策略】
   * 1. 安全基础变量：PATH, SystemRoot, HOME 等（系统必需）
   * 2. 用户指定变量：仅在 policy.process.allow_env_keys 白名单中
   * 
   * 【为什么需要白名单？】
   * - 防止泄露敏感变量：AWS_SECRET_KEY, DATABASE_URL 等
   * - 防止环境变量注入攻击
   * - 确保命令行为可预测
   * 
   * 【新手示例】
   * // 假设 allow_env_keys = ["CI", "NODE_ENV"]
   * buildEnv({ NODE_ENV: "production", DEBUG: "*" })
   * // 返回: { PATH: "...", NODE_ENV: "production" }
   * // DEBUG 被过滤掉，因为不在白名单中
   */
  private buildEnv(input: Record<string, string> | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    
    // 安全基础变量列表（系统运行必需）
    const safeBaseKeys = [
      "PATH", "SystemRoot", "ComSpec", "PATHEXT",  // Windows
      "HOME", "USERPROFILE", "TMP", "TEMP"          // 跨平台
    ];
    
    // 复制安全基础变量
    for (const key of safeBaseKeys) {
      const value = process.env[key];
      if (typeof value === "string") {
        env[key] = value;
      }
    }

    // 如果用户没有指定额外变量，直接返回
    if (!input) {
      return env;
    }

    // 构建允许的环境变量白名单 Set
    const allowed = new Set(this.policy.process.allow_env_keys);
    
    // 只复制白名单中的变量
    for (const [key, value] of Object.entries(input)) {
      if (!allowed.has(key)) {
        continue;  // 跳过不在白名单中的变量
      }
      env[key] = String(value);
    }

    return env;
  }
}

// =============================================================================
// 第四部分：核心执行函数 spawnAndCollect
// =============================================================================

/**
 * 【spawnAndCollect - 执行命令并收集输出】
 * 
 * 作用：使用 child_process.spawn 执行命令，流式收集 stdout/stderr
 * 
 * 【为什么用 spawn 而不是 exec？】
 * 1. 流式处理：大输出不会一次性加载到内存
 * 2. 实时控制：可以在输出过程中检查大小限制
 * 3. 精细控制：可以分别处理 stdout 和 stderr
 * 
 * 【执行流程】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 1. 初始化：记录开始时间、设置输出限制                   │
 * │ 2. 创建子进程：spawn(command, args, options)            │
 * │ 3. 设置超时定时器：超时则 kill 进程                     │
 * │ 4. 监听 stdout/stderr 的 data 事件：流式收集输出        │
 * │ 5. 检查输出大小：超过 max_output_bytes 则截断并终止    │
 * │ 6. 监听 close 事件：获取退出码，清理定时器              │
 * │ 7. 处理输出：脱敏 + Token 预算控制                      │
 * │ 8. 返回结果：包含退出码、输出、耗时、状态标志           │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手示例 - 内部调用】
 * // run() 和 exec() 都会调用此函数
 * const result = await spawnAndCollect({
 *   command: "npm",
 *   args: ["install"],
 *   cwd: "/root/work/flycode",
 *   timeoutMs: 60000,
 *   env: { NODE_ENV: "production" },
 *   shell: false,
 *   displayCommand: "npm install"
 * }, policy, redactor);
 */
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
  // ── 步骤 1: 初始化 ──
  const startedAt = Date.now();  // 记录开始时间（用于计算耗时）
  const maxBytes = policy.process.max_output_bytes;  // 输出大小限制

  // 使用 Buffer 数组收集输出（比字符串拼接更高效）
  const stdoutBuffers: Buffer[] = [];
  const stderrBuffers: Buffer[] = [];
  
  let capturedBytes = 0;  // 已收集的字节数
  let timedOut = false;   // 是否因超时终止
  let truncated = false;  // 输出是否被截断
  let finished = false;   // 进程是否已结束

  // ── 步骤 2: 创建子进程 ──
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    shell: input.shell,     // true=通过 shell 执行，false=直接执行
    windowsHide: true       // Windows 上不显示控制台窗口
  });

  // ── 步骤 3: 定义强制终止函数 ──
  const forceStop = () => {
    if (finished) {
      return;  // 已结束则无需终止
    }
    child.kill("SIGTERM");  // 发送终止信号
  };

  // ── 步骤 4: 设置超时定时器 ──
  const timeout = setTimeout(() => {
    timedOut = true;
    forceStop();  // 超时则终止进程
  }, input.timeoutMs);

  // ── 步骤 5: 定义输出收集函数 ──
  const appendChunk = (target: Buffer[], chunk: Buffer) => {
    // 如果已达到最大字节数，标记截断并终止
    if (capturedBytes >= maxBytes) {
      truncated = true;
      forceStop();
      return;
    }

    // 计算剩余可收集的字节数
    const remaining = maxBytes - capturedBytes;
    
    if (chunk.length > remaining) {
      // 如果当前 chunk 超出剩余容量，只收集部分
      target.push(chunk.subarray(0, remaining));
      capturedBytes = maxBytes;
      truncated = true;
      forceStop();  // 达到限制，终止进程
      return;
    }

    // 正常收集 chunk
    target.push(chunk);
    capturedBytes += chunk.length;
  };

  // ── 步骤 6: 监听 stdout 输出 ──
  child.stdout?.on("data", (chunk: Buffer | string) => {
    // 确保 chunk 是 Buffer 类型
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    appendChunk(stdoutBuffers, buffer);
  });

  // ── 步骤 7: 监听 stderr 输出 ──
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    appendChunk(stderrBuffers, buffer);
  });

  // ── 步骤 8: 等待进程结束并获取退出码 ──
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    // 监听 error 事件：spawn 失败（如命令不存在）
    child.on("error", (error) => reject(error));
    
    // 监听 close 事件：进程正常退出
    child.on("close", (code) => resolve(code));
  }).catch((error: unknown) => {
    // 将 spawn 错误转换为 AppError
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: `Failed to execute command: ${(error as Error).message}`
    });
  }).finally(() => {
    // 无论成功失败，标记已结束并清理定时器
    finished = true;
    clearTimeout(timeout);
  });

  // ── 步骤 9: 处理输出内容 ──
  // 合并 Buffer 数组并转为字符串
  const stdoutText = Buffer.concat(stdoutBuffers).toString("utf8");
  const stderrText = Buffer.concat(stderrBuffers).toString("utf8");
  
  // 脱敏处理：替换敏感信息
  const stdoutRedacted = redactor.redact(stdoutText).content;
  const stderrRedacted = redactor.redact(stderrText).content;
  
  // Token 预算控制：限制返回给 AI 的内容长度
  const stdoutBudgeted = applyTokenBudget(stdoutRedacted, policy.limits.max_inject_tokens);
  const stderrBudgeted = applyTokenBudget(stderrRedacted, policy.limits.max_inject_tokens);

  // ── 步骤 10: 返回结果 ──
  return {
    command: input.displayCommand || path.basename(input.command),
    cwd: input.cwd,
    exitCode,
    stdout: stdoutBudgeted.content,
    stderr: stderrBudgeted.content,
    durationMs: Date.now() - startedAt,
    timedOut,
    // truncated 为 true 如果：输出超限 或 Token 预算截断
    truncated: truncated || stdoutBudgeted.truncated || stderrBudgeted.truncated
  };
}

// =============================================================================
// 第五部分：独立工具函数
// =============================================================================

/**
 * 【normalizeCommandName - 标准化命令名】
 * 
 * 作用：将命令字符串标准化为可比较的名称
 * 
 * 【处理内容】
 * 1. path.basename(): 提取命令名（去掉路径）
 *    - "/usr/bin/npm" → "npm"
 *    - "C:\\Program Files\\node\\npm.exe" → "npm.exe"
 * 2. toLowerCase(): 转小写（不区分大小写匹配）
 * 3. 去掉常见后缀：.exe, .cmd, .bat, .ps1
 * 
 * 【新手示例】
 * normalizeCommandName("npm")           // → "npm"
 * normalizeCommandName("NPM")           // → "npm"
 * normalizeCommandName("/usr/bin/npm")  // → "npm"
 * normalizeCommandName("npm.exe")       // → "npm"
 * normalizeCommandName("  git  ")       // → "git" (trim)
 * 
 * 【为什么需要标准化？】
 * - 白名单匹配："npm" 和 "npm.exe" 应视为同一命令
 * - 跨平台：Windows 和 Linux 的命令名格式不同
 * - 安全：防止通过路径或后缀绕过白名单
 */
function normalizeCommandName(command: string): string {
  // 提取文件名 + 转小写
  const normalized = path.basename(command.trim()).toLowerCase();
  
  // 去掉常见可执行文件后缀
  return normalized.replace(/(\.exe|\.cmd|\.bat|\.ps1)$/i, "");
}

/**
 * 【firstToken - 提取 shell 命令的第一个 token】
 * 
 * 作用：从 shell 命令字符串中提取第一个词（命令名）
 * 用于 exec() 方法的白名单检查
 * 
 * 【处理逻辑】
 * 1. 去除首尾空格
 * 2. 如果以引号开头（" 或 '），提取引号内的内容
 * 3. 否则提取第一个非空白字符串
 * 
 * 【新手示例】
 * firstToken("npm install")              // → "npm"
 * firstToken("  git commit  ")           // → "git"
 * firstToken('"/path/to/npm" install')   // → "/path/to/npm"
 * firstToken("grep -r 'foo' src/")       // → "grep"
 * firstToken("")                         // → null
 * firstToken("   ")                      // → null
 * 
 * 【为什么需要提取第一个 token？】
 * exec() 的 command 是完整 shell 字符串，如 "npm install --save"
 * 白名单检查只需要命令名 "npm"，不需要参数
 */
function firstToken(value: string): string | null {
  const input = value.trim();
  if (!input) {
    return null;
  }

  // 处理带引号的命令："/path/to/npm" → /path/to/npm
  if (input[0] === '"' || input[0] === "'") {
    const quote = input[0];
    const end = input.indexOf(quote, 1);
    if (end > 1) {
      return input.slice(1, end);
    }
  }

  // 提取第一个非空白字符串
  const match = input.match(/^\S+/);
  return match ? match[0] : null;
}

// =============================================================================
// 文件结束 - 新手学习指引
// =============================================================================
// 
// 【理解这个文件后，你应该掌握】
// ✅ run() vs exec() 的区别和使用场景
// ✅ 命令白名单机制：防止任意代码执行
// ✅ 流式输出收集：高效处理大输出
// ✅ 超时和输出限制的优雅处理
// ✅ 环境变量白名单：防止敏感变量泄露
// ✅ 脱敏和 Token 预算：保护输出内容安全
// 
// 【实践任务】
// 1. 测试 run() 方法：
//    await runner.run({ command: "node", args: ["--version"] })
// 
// 2. 测试 exec() 方法：
//    await runner.exec({ command: "echo hello | grep hello" })
// 
// 3. 测试安全限制：
//    - 执行不在白名单的命令 → 应返回 403
//    - 设置 cwd 为不允许的目录 → 应返回 403
//    - 执行超长输出命令 → 应被截断
// 
// 【调试技巧】
// - 在 spawnAndCollect 中添加 console.log 查看执行过程
// - 检查 ~/.flycode/console/*.jsonl 获取命令执行日志
// - 使用 process.env.DEBUG 启用 Node.js 调试输出
// 
// 【安全提醒】
// ⚠️ 永远不要将用户输入直接作为 exec() 的 command
// ⚠️ 命令白名单要谨慎配置，只允许必要的命令
// ⚠️ 环境变量白名单防止泄露敏感信息
// ⚠️ 输出脱敏确保密钥不泄露给 AI
// ⚠️ 超时限制防止命令卡死导致服务无响应
// 
// 【命令白名单配置建议】
// ✅ 允许: npm, node, git, rg (ripgrep), pnpm, yarn
// ✅ 开发环境可添加: tsc, eslint, prettier, vitest
// ❌ 禁止: bash, sh, curl, wget, python, perl (风险高)
// ❌ 禁止: rm, mv, chmod (应使用 fs.* API 代替)
// 
// 【下一步学习】
// 建议继续阅读:
// - services/token-budget.ts: Token 预算控制实现
// - services/redactor.ts: 敏感信息脱敏实现
// - config/policy.ts: process 相关策略配置
// - services/audit.ts: 命令执行的审计日志
// =============================================================================
