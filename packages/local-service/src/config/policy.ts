/**
 * =============================================================================
 * FlyCode V2 - 安全策略配置加载器
 * =============================================================================
 * 
 * 【文件作用】
 * 这是 FlyCode 的"安全宪法"，负责：
 * 1. 定义默认安全策略（DEFAULT_POLICY）
 * 2. 从 ~/.flycode/policy.yaml 加载用户自定义策略
 * 3. 合并默认值与用户配置
 * 4. 验证并标准化所有策略参数（防止非法值）
 * 5. 将标准化后的策略写回文件（确保配置一致性）
 * 
 * 【为什么需要策略系统？】
 * - 安全隔离：限制 AI 只能访问指定目录，防止误删系统文件
 * - 资源保护：限制文件大小、搜索匹配数，防止资源耗尽
 * - 操作审计：所有敏感操作记录日志，便于追溯
 * - 灵活配置：用户可根据需求调整策略，无需修改代码
 * 
 * 【执行流程】
 * ┌─────────────────────────────────────┐
 * │ 1. 启动时调用 loadPolicyConfig()    │
 * │ 2. 检查 ~/.flycode/policy.yaml      │
 * │    ├─ 存在 → 读取 + 合并 + 标准化    │
 * │    └─ 不存在 → 使用 DEFAULT_POLICY  │
 * │ 3. 写回标准化后的策略文件            │
 * │ 4. 返回 PolicyConfig 供其他模块使用 │
 * └─────────────────────────────────────┘
 * 
 * 【新手学习重点】
 * - allowed_roots: AI 能访问的"安全沙箱"目录
 * - deny_globs: 永远禁止访问的文件模式（如 .env）
 * - redaction.rules: 敏感信息自动脱敏规则
 * - write.require_confirmation: 写入操作是否需要用户确认
 * 
 * @moduleflycode/local-service/config/policy
 * @security-critical
 */

// =============================================================================
// 第一部分：导入依赖
// =============================================================================

/**
 * 【Node.js 原生模块】
 * - fs/promises: 异步文件操作（读取/写入策略文件）
 * - os: 获取用户主目录（~）
 * - path: 路径拼接和标准化（跨平台兼容）
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 【yaml - YAML 解析库】
 * 
 * 作用：解析和序列化 YAML 格式的策略配置文件
 * 
 * 【新手示例 - YAML 配置】
 * # ~/.flycode/policy.yaml
 * allowed_roots:
 *   - /home/user/projects
 *   - /tmp/flycode-work
 * limits:
 *   max_file_bytes: 10485760  # 10MB
 * write:
 *   require_confirmation_default: false
 */
import YAML from "yaml";
import type { PolicyRuntimePatch, PolicyValidationResult } from "@flycode/shared-types";

/**
 * 【PolicyConfig - 策略配置类型】
 * 
 * 来源：../types.ts
 * 
 * 作用：定义策略配置的 TypeScript 类型，确保类型安全
 * 包含：allowed_roots、limits、write、process 等所有策略字段
 */
import type { PolicyConfig } from "../types.js";

// =============================================================================
// 第二部分：默认策略配置（安全基线）
// =============================================================================

/**
 * 【DEFAULT_POLICY - 默认安全策略】
 * 
 * 作用：当用户没有自定义策略时，使用此配置作为安全基线。
 * 所有字段都有合理的默认值，遵循"最小权限原则"。
 * 
 * 【策略字段详解表】
 * ┌─────────────────────────┬────────────────────────────────────┬─────────────┐
 * │ 字段类别                │ 字段说明                              │ 默认值       │
 * ├─────────────────────────┼────────────────────────────────────┼─────────────┤
 * │ allowed_roots           │ AI 可访问的目录白名单                 │ [process.cwd()] │
 * │ deny_globs              │ 禁止访问的文件模式（glob 语法）       │ [.git, node_modules, .env*] │
 * │ site_allowlist          │ 允许连接的 AI 站点                    │ ["qwen", "deepseek"] │
 * ├─────────────────────────┼────────────────────────────────────┼─────────────┤
 * │ limits.max_file_bytes   │ 单文件最大读取大小                    │ 5MB         │
 * │ limits.max_inject_tokens│ 注入到 AI 的最大 Token 数              │ 12,000      │
 * │ limits.max_search_matches│ 搜索最大返回匹配数                   │ 200         │
 * ├─────────────────────────┼────────────────────────────────────┼─────────────┤
 * │ write.require_confirmation_default │ 写入操作默认需用户确认     │ true        │
 * │ write.backup_on_overwrite | 覆盖写入前自动备份                 │ true        │
 * │ write.pending_ttl_seconds | 确认请求有效期（秒）               │ 600 (10 分钟) │
 * ├─────────────────────────┼────────────────────────────────────┼─────────────┤
 * │ mutation.allow_rm       │ 是否允许删除文件                      │ true        │
 * │ mutation.allow_mv       │ 是否允许移动/重命名文件               │ true        │
 * │ mutation.allow_chmod    │ 是否允许修改文件权限                  │ true        │
 * ├─────────────────────────┼────────────────────────────────────┼─────────────┤
 * │ process.enabled         │ 是否允许执行进程命令                  │ true        │
 * │ process.allowed_commands│ 允许执行的命令白名单                  │ [npm,node,git,rg,pnpm,yarn] │
 * │ process.default_timeout_ms | 命令默认超时时间                  │ 30,000ms    │
 * │ process.max_output_bytes│ 命令输出最大字节数                    │ 200KB       │
 * ├─────────────────────────┼────────────────────────────────────┼─────────────┤
 * │ redaction.enabled       │ 是否启用敏感信息脱敏                  │ true        │
 * │ redaction.rules         │ 脱敏规则列表（正则匹配）              │ [API Key, Password, Private Key] │
 * ├─────────────────────────┼────────────────────────────────────┼─────────────┤
 * │ audit.enabled           │ 是否启用审计日志                      │ true        │
 * │ audit.include_content_hash | 日志中是否包含文件哈希            │ true        │
 * ├─────────────────────────┼────────────────────────────────────┼─────────────┤
 * │ auth.token_ttl_days     │ JWT Token 有效期                      │ 30 天       │
 * │ auth.pair_code_ttl_minutes | 配对码有效期                      │ 5 分钟      │
 * └─────────────────────────┴────────────────────────────────────┴─────────────┘
 * 
 * 【新手配置示例 - 自定义策略】
 * # ~/.flycode/policy.yaml
 * allowed_roots:
 *   - /home/user/my-project    # 只允许访问特定项目目录
 * deny_globs:
 *   - ".key"               # 额外禁止 .key 文件
 *   - "*secrets/**"          # 禁止访问 secrets 目录
 * limits:
 *   max_file_bytes: 10485760   # 放宽到 10MB
 * write:
 *   require_confirmation_default: false  # 开发环境关闭确认（不推荐生产）
 * redaction:
 *   rules:
 *     - name: "aws_access_key"
 *       pattern: "AKIA[0-9A-Z]{16}"
 *       replacement: "***AWS_KEY***"
 */
const DEFAULT_POLICY: PolicyConfig = {
  // ── 路径控制 ──
  /**
   * allowed_roots: AI 可访问的目录白名单
   * 
   * 安全原理：
   * - 所有文件操作前都会检查路径是否在 allowed_roots 内
   * - 路径会经过 normalize 标准化，防止 ../ 逃逸
   * - 默认值为 process.cwd()，即启动服务的当前目录
   * 
   * 【新手注意】
   * ❌ 不要添加 "/" 或 "/home" 等系统目录
   * ✅ 只添加项目目录，如 "/home/user/projects/my-app"
   */
  allowed_roots: [process.cwd()],

  /**
   * deny_globs: 禁止访问的文件模式（glob 语法）
   * 
   * 作用：即使文件在 allowed_roots 内，匹配此模式也会被拒绝
   * 
   * 默认规则说明：
   * - "**.git/**"     : 禁止访问 Git 仓库元数据
   * - "**node_modules/**": 禁止访问依赖包（避免读取大量无关代码）
   * - "**.env*"       : 禁止访问环境变量文件（防止密钥泄露）
   * 
   * 【新手扩展】
   * 可添加："**.pem", "*id_rsa*", "*.aws/credentials"
   */
  deny_globs: ["**/.git/**", "**/node_modules/**", "**/.env*"],

  /**
   * site_allowlist: 允许连接的 AI 站点
   * 
   * 作用：限制只有白名单中的站点能使用本服务
   * 防止恶意网站通过浏览器扩展调用本地服务
   */
  site_allowlist: ["qwen", "deepseek"],

  // ── 资源限制 ──
  limits: {
    /**
     * max_file_bytes: 单文件最大读取大小
     * 
     * 作用：防止 AI 读取超大文件（如日志、视频）导致内存溢出
     * 默认 5MB，可根据需求调整（范围：1B ~ 100MB，normalize 时会 clamp）
     */
    max_file_bytes: 5 * 1024 * 1024,

    /**
     * max_inject_tokens: 注入到 AI 的最大 Token 数
     * 
     * 作用：
     * - 控制 AI 上下文长度，避免 Token 消耗过快
     * - 脱敏和截断后，内容超过此值会被截断
     * 默认 12,000 Token（约 9KB 中文文本）
     */
    max_inject_tokens: 12_000,

    /**
     * max_search_matches: 搜索最大返回匹配数
     * 
     * 作用：防止搜索返回过多结果导致响应过大
     * 默认 200 条，超过会被截断并标记 truncated: true
     */
    max_search_matches: 200
  },

  // ── 写入控制 ──
  write: {
    /**
     * require_confirmation_default: 写入操作默认需用户确认
     * 
     * 安全原理：
     * - 高风险操作（如覆盖文件）会进入"确认中心"
     * - 用户需在桌面应用中点击"批准"才能执行
     * - 防止 AI 误操作或恶意修改文件
     * 
     * 【新手建议】
     * 开发环境可设为 false 提高效率，但生产环境务必保持 true
     */
    require_confirmation_default: true,

    /**
     * allow_disable_confirmation: 是否允许用户关闭确认
     * 
     * 作用：给用户选择权，但受策略控制
     * 如果设为 false，即使用户想关闭确认也不允许
     */
    allow_disable_confirmation: true,

    /**
     * backup_on_overwrite: 覆盖写入前自动备份
     * 
     * 安全原理：
     * - 覆盖文件前，先复制为 .flycode.bak.{timestamp}
     * - 即使写错也可从备份恢复
     * - 备份文件也受 allowed_roots 保护
     * 
     * 【新手示例】
     * 原文件: /src/index.ts
     * 备份后: /src/index.ts.flycode.bak.1771875757122
     */
    backup_on_overwrite: true,

    /**
     * pending_ttl_seconds: 确认请求有效期
     * 
     * 作用：用户未确认的请求在此时间后自动过期
     * 默认 600 秒（10 分钟），范围：30~3600 秒
     */
    pending_ttl_seconds: 600
  },

  // ── 变更操作控制 ──
  mutation: {
    /**
     * allow_rm: 是否允许删除文件
     * 
     * 【安全提醒】
     * 即使允许，也不能删除 allowed_roots 中的根目录
     * 删除操作会记录审计日志
     */
    allow_rm: true,

    /**
     * allow_mv: 是否允许移动/重命名文件
     */
    allow_mv: true,

    /**
     * allow_chmod: 是否允许修改文件权限
     * 
     * 【注意】Windows 上 chmod 不被支持，会返回 NOT_SUPPORTED
     */
    allow_chmod: true,

    /**
     * allow_write_batch: 是否允许批量写入
     * 
     * 作用：控制 fs.writeBatch 工具是否可用
     * 批量写入也受 confirmation 和 backup 策略控制
     */
    allow_write_batch: true
  },

  // ── 进程执行控制 ──
  process: {
    /**
     * enabled: 是否允许执行进程命令
     * 
     * 【安全原理】
     * 进程执行是高风险操作，可完全关闭以增强安全
     * 关闭后，process.run 和 shell.exec 都会返回 FORBIDDEN
     */
    enabled: true,

    /**
     * allowed_commands: 允许执行的命令白名单
     * 
     * 安全原理：
     * - 只允许执行白名单中的命令，防止任意代码执行
     * - 命令名精确匹配（如 "npm" 不等于 "npm install"）
     * - 参数由命令自身解析，服务不干预
     * 
     * 【新手扩展】
     * 可添加: "tsc", "eslint", "prettier", "docker"
     * ❌ 不要添加: "bash", "sh", "curl", "wget"（风险高）
     */
    allowed_commands: ["npm", "node", "git", "rg", "pnpm", "yarn"],

    /**
     * allowed_cwds: 允许的工作目录白名单
     * 
     * 作用：限制命令只能在指定目录执行
     * 空数组表示允许在 allowed_roots 内任意目录执行
     * 
     * 【新手示例】
     * allowed_cwds: ["/home/user/projects/my-app"]
     * // 命令只能在 my-app 目录执行，不能在其他目录
     */
    allowed_cwds: [],

    /**
     * default_timeout_ms: 命令默认超时时间
     * 
     * 作用：防止命令卡死导致服务无响应
     * 默认 30 秒，范围：1s ~ 10min（normalize 时会 clamp）
     */
    default_timeout_ms: 30_000,

    /**
     * max_timeout_ms: 命令最大超时时间
     * 
     * 作用：即使用户请求更长超时，也不会超过此值
     * 默认 120 秒，范围：1s ~ 10min
     */
    max_timeout_ms: 120_000,

    /**
     * max_output_bytes: 命令输出最大字节数
     * 
     * 作用：防止命令输出过大（如 cat /dev/urandom）
     * 超过此值的输出会被截断并标记 truncated: true
     */
    max_output_bytes: 200_000,

    /**
     * allow_env_keys: 允许传递的环境变量白名单
     * 
     * 安全原理：
     * - 只允许传递白名单中的环境变量
     * - 防止泄露敏感环境变量（如 AWS_SECRET_KEY）
     * - 默认只允许 CI 和 NODE_ENV（构建常用）
     * 
     * 【新手示例】
     * allow_env_keys: ["CI", "NODE_ENV", "DEBUG"]
     */
    allow_env_keys: ["CI", "NODE_ENV"]
  },

  // ── 敏感信息脱敏 ──
  redaction: {
    /**
     * enabled: 是否启用脱敏
     * 
     * 作用：在内容返回给 AI 前，自动替换敏感信息
     * 即使关闭，审计日志仍会记录原始内容哈希
     */
    enabled: true,

    /**
     * rules: 脱敏规则列表
     * 
     * 每条规则包含：
     * - name: 规则名称（用于日志）
     * - pattern: 正则表达式（匹配敏感内容）
     * - replacement: 替换文本
     * - flags: 正则标志（如 "i" 表示忽略大小写）
     * 
     * 【默认规则详解】
     * 1. openai_api_key:
     *    pattern: sk-[a-zA-Z0-9]{20,}
     *    → 匹配 OpenAI API Key 格式
     * 
     * 2. password_assignment:
     *    pattern: (password\\s*[:=]\\s*)([^\\s"']+)
     *    → 匹配 password = "xxx" 或 password: xxx
     * 
     * 3. private_key_block:
     *    pattern: -----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]+?-----END...
     *    → 匹配 PEM 格式的私钥块
     * 
     * 【新手扩展示例】
     * rules:
     *   - name: "github_token"
     *     pattern: "ghp_[a-zA-Z0-9]{36}"
     *     replacement: "***GITHUB_TOKEN***"
     *   - name: "jwt_token"
     *     pattern: "eyJ[a-zA-Z0-9_-]*\\.eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*"
     *     replacement: "***JWT***"
     */
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

  // ── 审计日志 ──
  audit: {
    /**
     * enabled: 是否启用审计日志
     * 
     * 作用：记录所有文件操作、进程执行等敏感操作
     * 日志路径：~/.flycode/audit/YYYY-MM-DD.jsonl
     * 
     * 【新手建议】
     * 生产环境务必保持 enabled: true，便于安全审计
     */
    enabled: true,

    /**
     * include_content_hash: 日志中是否包含文件内容哈希
     * 
     * 作用：
     * - 记录文件内容的 SHA256，便于验证完整性
     * - 不记录原始内容，保护隐私
     * - 可用于检测文件是否被篡改
     */
    include_content_hash: true
  },

  // ── 认证配置 ──
  auth: {
    /**
     * token_ttl_days: JWT Token 有效期
     * 
     * 作用：配对成功后颁发的 Token 在此时间后过期
     * 默认 30 天，范围：1~365 天
     * 
     * 【安全建议】
     * 开发环境可设短些（如 7 天），生产环境可延长
     * 过期后需重新配对获取新 Token
     */
    token_ttl_days: 30,

    /**
     * pair_code_ttl_minutes: 配对码有效期
     * 
     * 作用：启动时显示的 6 位配对码在此时间后失效
     * 默认 5 分钟，范围：1~60 分钟
     * 
     * 【安全原理】
     * 短有效期防止配对码被截获后重用
     * 过期后需重启服务或等待新配对码生成
     */
    pair_code_ttl_minutes: 5
  }
};

// =============================================================================
// 第三部分：路径工具函数
// =============================================================================

/**
 * 【getFlycodeHomeDir - 获取 FlyCode 配置目录】
 * 
 * 作用：返回 ~/.flycode 的绝对路径
 * 
 * 【新手示例】
 * const home = getFlycodeHomeDir();
 * console.log(home);
 * // Linux/Mac: /home/user/.flycode
 * // Windows: C:\\Users\\user\\.flycode
 * 
 * 【目录结构】
 * ~/.flycode/
 * ├── policy.yaml          # 策略配置（本文件管理）
 * ├── site-keys.json       # 站点密钥
 * ├── app-config.json      # 应用偏好
 * ├── audit/               # 审计日志
 * │   └── 2026-02-23.jsonl
 * └── console/             # 控制台事件日志
 *     └── 2026-02-23.jsonl
 */
export function getFlycodeHomeDir(): string {
  // os.homedir(): 获取当前用户的主目录
  // path.join(): 跨平台路径拼接（自动处理 / 或 \\）
  return path.join(os.homedir(), ".flycode");
}

/**
 * 【getPolicyFilePath - 获取策略文件路径】
 * 
 * 作用：返回 policy.yaml 的绝对路径
 * 
 * 【新手示例】
 * const policyPath = getPolicyFilePath();
 * // 输出: /home/user/.flycode/policy.yaml
 */
export function getPolicyFilePath(): string {
  // 复用 getFlycodeHomeDir()，确保路径一致性
  return path.join(getFlycodeHomeDir(), "policy.yaml");
}

// =============================================================================
// 第四部分：策略加载主函数
// =============================================================================

/**
 * 【loadPolicyConfig - 加载并初始化策略配置】
 * 
 * 作用：服务启动时调用，确保策略配置可用且标准化
 * 
 * 执行流程详解：
 * ┌─────────────────────────────────────────────┐
 * │ 1. 获取配置目录和策略文件路径                │
 * │ 2. 确保 ~/.flycode 目录存在 (mkdir -p)       │
 * │ 3. 尝试读取 policy.yaml                      │
 * │    ├─ 成功 → 解析 YAML → 合并默认值 → 标准化 │
 * │    └─ 失败 (ENOENT) → 使用 DEFAULT_POLICY   │
 * │ 4. 将标准化后的策略写回文件（确保一致性）    │
 * │ 5. 返回 PolicyConfig 供其他模块使用          │
 * └─────────────────────────────────────────────┘
 * 
 * 【新手示例 - 首次启动】
 * // 1. ~/.flycode/policy.yaml 不存在
 * // 2. loadPolicyConfig() 使用 DEFAULT_POLICY
 * // 3. 写回标准化的 policy.yaml
 * // 4. 后续启动直接读取该文件
 * 
 * 【新手示例 - 自定义配置】
 * // 1. 用户编辑 ~/.flycode/policy.yaml
 * // 2. 添加: allowed_roots: ["/my/project"]
 * // 3. 重启服务
 * // 4. loadPolicyConfig() 合并用户配置与默认值
 * // 5. 标准化后写回（确保所有字段都有值）
 * 
 * 【错误处理】
 * - ENOENT (文件不存在): 正常情况，使用默认策略
 * - 其他错误: 直接抛出，由上层捕获处理
 * 
 * 【新手调试】
 * 如果策略加载失败，检查:
 * 1. ~/.flycode 目录权限 (应为 700)
 * 2. policy.yaml 语法 (使用 YAML 校验工具)
 * 3. 磁盘空间 (写入需要空间)
 */
export async function loadPolicyConfig(): Promise<PolicyConfig> {
  // 步骤 1: 获取配置目录和策略文件路径
  const home = getFlycodeHomeDir();
  const policyPath = getPolicyFilePath();

  // 步骤 2: 确保配置目录存在 (类似 mkdir -p)
  // recursive: true 表示如果父目录不存在也一并创建
  await fs.mkdir(home, { recursive: true });

  try {
    // 步骤 3a: 尝试读取用户策略文件
    const raw = await fs.readFile(policyPath, "utf8");
    
    // 解析 YAML 字符串为 JavaScript 对象
    const parsed = YAML.parse(raw);
    
    // 合并用户配置与默认值 (用户配置优先)
    const merged = mergePolicy(parsed ?? {});
    
    // 将标准化后的策略写回文件
    // 确保下次启动时配置一致，且所有字段都有默认值
    await fs.writeFile(policyPath, YAML.stringify(merged), "utf8");
    
    // 返回最终策略配置
    return merged;
  } catch (error: unknown) {
    // 步骤 3b: 处理文件不存在的情况
    // ENOENT = "Error NO ENTry"，即文件不存在
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // 其他错误（如权限不足、磁盘满）直接抛出
      throw error;
    }

    // 文件不存在是正常情况（首次启动）
    // 使用默认策略并标准化
    const initial = normalizePolicy(DEFAULT_POLICY);
    
    // 写回默认策略，方便用户后续编辑
    await fs.writeFile(policyPath, YAML.stringify(initial), "utf8");
    
    // 返回初始化的默认策略
    return initial;
  }
}

export async function savePolicyConfig(next: PolicyConfig): Promise<PolicyConfig> {
  const policyPath = getPolicyFilePath();
  const normalized = normalizePolicy(next);
  await fs.writeFile(policyPath, YAML.stringify(normalized), "utf8");
  return normalized;
}

export function validatePolicyPatch(current: PolicyConfig, patch: PolicyRuntimePatch): PolicyValidationResult {
  const errors: PolicyValidationResult["errors"] = [];
  const hasAllowedRoots = Object.prototype.hasOwnProperty.call(patch, "allowed_roots");
  const hasProcess = Object.prototype.hasOwnProperty.call(patch, "process");

  if (!hasAllowedRoots && !hasProcess) {
    errors.push({
      field: "patch",
      message: "Patch cannot be empty"
    });
  }

  if (hasAllowedRoots) {
    if (!Array.isArray(patch.allowed_roots)) {
      errors.push({ field: "allowed_roots", message: "allowed_roots must be an array of absolute paths" });
    } else {
      if (patch.allowed_roots.length === 0) {
        errors.push({ field: "allowed_roots", message: "allowed_roots cannot be empty" });
      }
      for (const [index, item] of patch.allowed_roots.entries()) {
        const value = String(item ?? "").trim();
        if (!value) {
          errors.push({ field: `allowed_roots[${index}]`, message: "Path cannot be empty" });
          continue;
        }
        if (!path.isAbsolute(value)) {
          errors.push({ field: `allowed_roots[${index}]`, message: "Path must be absolute" });
        }
      }
    }
  }

  if (patch.process) {
    if (Object.prototype.hasOwnProperty.call(patch.process, "allowed_commands")) {
      if (!Array.isArray(patch.process.allowed_commands)) {
        errors.push({
          field: "process.allowed_commands",
          message: "process.allowed_commands must be an array of command names"
        });
      } else if (patch.process.allowed_commands.length === 0) {
        errors.push({ field: "process.allowed_commands", message: "process.allowed_commands cannot be empty" });
      } else {
        for (const [index, item] of patch.process.allowed_commands.entries()) {
          const command = String(item ?? "").trim();
          if (!command) {
            errors.push({ field: `process.allowed_commands[${index}]`, message: "Command cannot be empty" });
          }
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch.process, "allowed_cwds")) {
      if (!Array.isArray(patch.process.allowed_cwds)) {
        errors.push({
          field: "process.allowed_cwds",
          message: "process.allowed_cwds must be an array of absolute paths"
        });
      } else {
        for (const [index, item] of patch.process.allowed_cwds.entries()) {
          const cwd = String(item ?? "").trim();
          if (!cwd) {
            errors.push({ field: `process.allowed_cwds[${index}]`, message: "Path cannot be empty" });
            continue;
          }
          if (!path.isAbsolute(cwd)) {
            errors.push({ field: `process.allowed_cwds[${index}]`, message: "Path must be absolute" });
          }
        }
      }
    }
  }

  try {
    mergePolicyPatch(current, patch);
  } catch (error: unknown) {
    errors.push({
      field: "patch",
      message: (error as Error).message ?? "Invalid policy patch"
    });
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function mergePolicyPatch(current: PolicyConfig, patch: PolicyRuntimePatch): PolicyConfig {
  const next: PolicyConfig = JSON.parse(JSON.stringify(current));

  if (Array.isArray(patch.allowed_roots)) {
    next.allowed_roots = patch.allowed_roots.map((item) => String(item).trim());
  }

  if (patch.process?.allowed_commands) {
    const dedup = new Set<string>();
    for (const item of patch.process.allowed_commands) {
      const command = String(item).trim();
      if (command) {
        dedup.add(command);
      }
    }
    next.process.allowed_commands = Array.from(dedup);
  }

  if (patch.process?.allowed_cwds) {
    const dedup = new Set<string>();
    for (const item of patch.process.allowed_cwds) {
      const cwd = String(item).trim();
      if (cwd) {
        dedup.add(cwd);
      }
    }
    next.process.allowed_cwds = Array.from(dedup);
  }

  return normalizePolicy(next);
}

// =============================================================================
// 第五部分：策略合并函数
// =============================================================================

/**
 * 【mergePolicy - 合并用户配置与默认策略】
 * 
 * 作用：将用户提供的部分配置与 DEFAULT_POLICY 合并
 * 原则：用户配置优先，缺失字段使用默认值
 * 
 * 【合并逻辑详解】
 * ┌─────────────────────────────────────┐
 * │ 输入: raw (用户配置，可能不完整)     │
 * │ 输出: PolicyConfig (完整且类型安全)  │
 * │                                     │
 * │ 对每个字段:                          │
 * │   if (用户提供了该字段) {           │
 * │     使用用户值 (并做类型转换)        │
 * │   } else {                          │
 * │     使用 DEFAULT_POLICY 的默认值    │
 * │   }                                 │
 * └─────────────────────────────────────┘
 * 
 * 【新手示例 - 合并过程】
 * // 用户配置:
 * { limits: { max_file_bytes: 10485760 } }
 * 
 * // 合并后:
 * {
 *   allowed_roots: [process.cwd()],  // ← 使用默认值
 *   deny_globs: ["*.git/**", ...], // ← 使用默认值
 *   limits: {
 *     max_file_bytes: 10485760,      // ← 使用用户值
 *     max_inject_tokens: 12000,      // ← 使用默认值
 *     max_search_matches: 200        // ← 使用默认值
 *   },
 *   // ... 其他字段都使用默认值
 * }
 * 
 * 【类型安全处理】
 * - Array.isArray(): 确保数组字段是数组
 * - .map(String): 将数组元素转为字符串（防止类型污染）
 * - Number()/Boolean(): 显式类型转换
 * - ?? 运算符: 空值合并，null/undefined 时使用默认值
 * 
 * 【新手注意】
 * YAML 解析可能返回任意类型，所以合并时必须做类型检查和转换
 * 这确保了 PolicyConfig 的类型安全，避免运行时错误
 */
function mergePolicy(raw: unknown): PolicyConfig {
  // 类型守卫：确保 raw 是对象，否则使用空对象
  const candidate = typeof raw === "object" && raw !== null ? (raw as Partial<PolicyConfig>) : {};

  // 逐字段合并，确保每个字段都有值且类型正确
  const merged: PolicyConfig = {
    // ── 数组字段：用户数组优先，否则用默认数组 ──
    allowed_roots: Array.isArray(candidate.allowed_roots)
      ? candidate.allowed_roots.map(String)  // 转为字符串数组
      : DEFAULT_POLICY.allowed_roots,

    deny_globs: Array.isArray(candidate.deny_globs)
      ? candidate.deny_globs.map(String)
      : DEFAULT_POLICY.deny_globs,

    site_allowlist: Array.isArray(candidate.site_allowlist)
      ? candidate.site_allowlist.map(String)
      : DEFAULT_POLICY.site_allowlist,

    // ── 嵌套对象：逐字段合并 ──
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
        ? candidate.process.allowed_commands.map(String).filter(Boolean)  // 过滤空字符串
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
      // 脱敏规则：逐条处理，确保每条规则都有 pattern
      rules: Array.isArray(candidate.redaction?.rules)
        ? candidate.redaction!.rules!.map((rule) => ({
            name: String((rule as { name?: string }).name ?? "custom"),
            pattern: String((rule as { pattern?: string }).pattern ?? ""),
            replacement: (rule as { replacement?: string }).replacement,
            flags: (rule as { flags?: string }).flags
          })).filter((rule) => Boolean(rule.pattern))  // 过滤掉没有 pattern 的规则
        : DEFAULT_POLICY.redaction.rules
    },

    audit: {
      enabled: true,  // 审计日志强制启用，不能关闭
      include_content_hash: Boolean(candidate.audit?.include_content_hash ?? DEFAULT_POLICY.audit.include_content_hash)
    },

    auth: {
      token_ttl_days: Number(candidate.auth?.token_ttl_days ?? DEFAULT_POLICY.auth.token_ttl_days),
      pair_code_ttl_minutes: Number(candidate.auth?.pair_code_ttl_minutes ?? DEFAULT_POLICY.auth.pair_code_ttl_minutes)
    }
  };

  // 合并后还需要标准化（clamp 范围、解析路径等）
  return normalizePolicy(merged);
}

// =============================================================================
// 第六部分：策略标准化函数
// =============================================================================

/**
 * 【normalizePolicy - 标准化策略参数】
 * 
 * 作用：对合并后的策略进行最终验证和标准化
 * 确保所有数值在合理范围内，路径是绝对路径等
 * 
 * 【标准化操作详解】
 * ┌─────────────────────────────────────┐
 * │ 1. 路径标准化:                        │
 * │    - allowed_roots: path.resolve()   │
 * │    - 转为绝对路径，防止相对路径逃逸  │
 * │                                     │
 * │ 2. 数值范围限制 (clamp):              │
 * │    - max_file_bytes: 1B ~ 100MB     │
 * │    - max_inject_tokens: 200 ~ 200K  │
 * │    - timeout: 1s ~ 10min            │
 * │    - 防止用户配置极端值导致问题      │
 * │                                     │
 * │ 3. 默认值兜底:                        │
 * │    - allowed_commands 为空时设为 ["node"] │
 * │    - audit.enabled 强制为 true      │
 * │                                     │
 * │ 4. 依赖关系处理:                      │
 * │    - default_timeout <= max_timeout │
 * │    - 防止配置矛盾                   │
 * └─────────────────────────────────────┘
 * 
 * 【新手示例 - 标准化效果】
 * // 输入:
 * {
 *   limits: { max_file_bytes: -100 },  // 非法值
 *   process: { default_timeout_ms: 999 }  // 小于最小值
 * }
 * 
 * // 标准化后:
 * {
 *   limits: { max_file_bytes: 1 },  // ← clamp 到最小值
 *   process: {
 *     default_timeout_ms: 1000,     // ← clamp 到最小值
 *     max_timeout_ms: 1000          // ← 确保 default <= max
 *   }
 * }
 * 
 * 【clamp 函数原理】
 * clamp(value, min, max) = Math.min(Math.max(value, min), max)
 * 确保值在 [min, max] 范围内
 */
function normalizePolicy(policy: PolicyConfig): PolicyConfig {
  // 步骤 1: 先处理有依赖关系的字段
  // max_timeout 先 clamp，确保 default_timeout 不会超过它
  const maxTimeout = clamp(policy.process.max_timeout_ms, 1000, 10 * 60 * 1000);
  const defaultTimeout = Math.min(clamp(policy.process.default_timeout_ms, 1000, 10 * 60 * 1000), maxTimeout);

  // 步骤 2: 返回标准化后的策略对象
  return {
    // 使用展开运算符保留未修改的字段
    ...policy,

    // ── 路径标准化 ──
    // path.resolve(): 转为绝对路径
    // .filter(Boolean): 过滤空字符串
    allowed_roots: policy.allowed_roots.map((root) => path.resolve(root)).filter(Boolean),

    // ── 数值范围限制 ──
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
      // 命令白名单不能为空，至少允许 "node"
      allowed_commands: policy.process.allowed_commands.length > 0 ? policy.process.allowed_commands : ["node"],
      // 工作目录转为绝对路径
      allowed_cwds: policy.process.allowed_cwds.map((cwd) => path.resolve(cwd)).filter(Boolean),
      // 使用之前计算好的 timeout 值
      default_timeout_ms: defaultTimeout,
      max_timeout_ms: maxTimeout,
      max_output_bytes: clamp(policy.process.max_output_bytes, 1024, 5 * 1024 * 1024),
      allow_env_keys: policy.process.allow_env_keys.filter(Boolean)
    },

    auth: {
      token_ttl_days: clamp(policy.auth.token_ttl_days, 1, 365),
      pair_code_ttl_minutes: clamp(policy.auth.pair_code_ttl_minutes, 1, 60)
    },

    // 审计日志强制启用
    audit: {
      enabled: true,
      include_content_hash: policy.audit.include_content_hash
    },

    // mutation 字段直接保留（无特殊标准化逻辑）
    mutation: {
      ...policy.mutation
    }
  };
}

// =============================================================================
// 第七部分：工具函数
// =============================================================================

/**
 * 【clamp - 数值范围限制工具】
 * 
 * 作用：确保数值在 [min, max] 范围内
 * 
 * 【算法原理】
 * clamp(value, min, max) =
 *   if value < min: return min
 *   if value > max: return max
 *   else: return value
 * 
 * 【实现技巧】
 * Math.min(Math.max(value, min), max)
 * 1. Math.max(value, min): 确保不小于 min
 * 2. Math.min(..., max): 确保不大于 max
 * 
 * 【新手示例】
 * clamp(50, 10, 100)   → 50   (在范围内)
 * clamp(5, 10, 100)    → 10   (小于最小值，提升到 min)
 * clamp(150, 10, 100)  → 100  (大于最大值，降低到 max)
 * clamp(NaN, 10, 100)  → 10   (非法值，返回 min)
 * 
 * 【应用场景】
 * - 限制文件大小、超时时间、Token 数等
 * - 防止用户配置极端值导致系统异常
 */
function clamp(value: number, min: number, max: number): number {
  // 处理非法数值（NaN, Infinity 等）
  if (!Number.isFinite(value)) {
    return min;  // 非法值返回最小值（保守策略）
  }

  // 向下取整（策略参数通常为整数）
  // 然后限制在 [min, max] 范围内
  return Math.min(Math.max(Math.floor(value), min), max);
}

// =============================================================================
// 文件结束 - 新手学习指引
// =============================================================================
// 
// 【理解这个文件后，你应该掌握】
// ✅ 策略系统的核心作用：安全隔离 + 资源保护 + 操作审计
// ✅ 默认策略的每个字段含义和默认值
// ✅ 配置加载流程：读取 → 合并 → 标准化 → 持久化
// ✅ 安全设计原则：最小权限、白名单、范围限制
// 
// 【实践任务】
// 1. 查看 ~/.flycode/policy.yaml 的实际内容
// 2. 尝试修改 allowed_roots，重启服务验证效果
// 3. 添加一条自定义脱敏规则，测试是否生效
// 4. 将 require_confirmation_default 设为 false，观察写入行为变化
// 
// 【调试技巧】
// - 在 loadPolicyConfig() 添加 console.log 查看加载过程
// - 检查 ~/.flycode/console/*.jsonl 获取策略相关日志
// - 使用 YAML 校验工具验证 policy.yaml 语法
// 
// 【安全提醒】
// ⚠️ 不要将 allowed_roots 设为系统目录（如 / 或 C:\\）
// ⚠️ 不要关闭 redaction.enabled，可能导致密钥泄露
// ⚠️ 生产环境保持 require_confirmation_default: true
// ⚠️ 定期备份 ~/.flycode/policy.yaml
// 
// 【下一步学习】
// 建议继续阅读:
// - ./services/path-policy.ts: 路径白名单检查实现
// - ./services/redactor.ts: 敏感信息脱敏实现
// - ./services/audit.ts: 审计日志记录实现
// =============================================================================
