/**
 * =============================================================================
 * FlyCode V2 - 本地服务类型定义
 * =============================================================================
 * 
 * 【文件作用】
 * 这是本地服务的"类型字典"，定义了所有内部接口和数据结构。
 * 与 shared-types 的区别：
 * - shared-types: 跨包共享的协议类型（Request/Data）
 * - types.ts: 本地服务内部的接口定义（Service/Manager）
 * 
 * 【为什么需要这个文件？】
 * 1. 依赖倒置：定义接口，具体实现在 services/ 目录下
 * 2. 类型安全：TypeScript 编译时检查类型错误
 * 3. 文档作用：通过接口定义了解系统架构
 * 4. 测试便利：测试时可以创建 mock 实现
 * 
 * 【核心接口分类】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 配置类接口                                              │
 * │ - PolicyConfig: 安全策略配置                            │
 * │ - RedactionRule: 脱敏规则                               │
 * └─────────────────────────────────────────────────────────┘
 * ┌─────────────────────────────────────────────────────────┐
 * │ 服务上下文                                              │
 * │ - ServiceContext: 所有服务的聚合                        │
 * │ - PendingWriteOp: 待确认的写入操作                      │
 * │ - PendingWriteBatchOp: 待确认的批量写入操作             │
 * └─────────────────────────────────────────────────────────┘
 * ┌─────────────────────────────────────────────────────────┐
 * │ 管理器接口 (Manager)                                    │
 * │ - PairCodeManager: 配对码管理                           │
 * │ - TokenManager: JWT Token 管理                           │
 * │ - SiteKeyManager: 站点密钥管理                          │
 * │ - ConfirmationManager: 确认中心管理                     │
 * │ - ConsoleEventLogger: 控制台事件日志                    │
 * │ - AppConfigManager: 应用配置管理                        │
 * │ - AuditLogger: 审计日志                                 │
 * └─────────────────────────────────────────────────────────┘
 * ┌─────────────────────────────────────────────────────────┐
 * │ 服务接口 (Service)                                      │
 * │ - PathPolicy: 路径策略检查                              │
 * │ - Redactor: 敏感信息脱敏                                │
 * │ - FileService: 文件操作服务                             │
 * │ - WriteManager: 写入操作管理（两步写入）                │
 * │ - WriteBatchManager: 批量写入管理                       │
 * │ - ProcessRunner: 进程执行服务                           │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手学习重点】
 * - 接口 vs 实现：这里只定义接口，实现在 services/ 目录
 * - 依赖注入：ServiceContext 聚合所有服务，便于传递
 * - 两步写入：PendingWriteOp + WriteManager 实现安全写入
 * 
 * @moduleflycode/local-service/types
 * type-definitions
 */

// =============================================================================
// 第一部分：导入共享类型
// =============================================================================

/**
 * 【共享类型导入】
 * 
 * 从 @flycode/shared-types 导入跨包共享的类型
 * 这些类型在浏览器扩展和本地服务之间通用
 */
import type {
  ConfirmationEntry,      // 确认条目（确认中心使用）
  ConsoleEventEntry,      // 控制台事件条目（日志使用）
  ReadEncoding,           // 读取编码："utf-8" | "base64" | "hex"
  SiteId,                 // 站点 ID："qwen" | "deepseek" | "gemini" | "unknown"
  SiteKeysResponse,       // 站点密钥响应
  WriteBatchFileInput,    // 批量写入的单个文件输入
  WriteMode               // 写入模式："overwrite" | "append"
} from "@flycode/shared-types";

// =============================================================================
// 第二部分：配置类接口
// =============================================================================

/**
 * 【RedactionRule - 脱敏规则】
 * 
 * 作用：定义敏感信息脱敏的单条规则
 * 
 * 【字段说明】
 * ┌───────────────┬────────────────────────────────────────┬─────────────┐
 * │ 字段           │ 说明                                    │ 示例         │
 * ├───────────────┼────────────────────────────────────────┼─────────────┤
 * │ name          │ 规则名称（用于日志标识）                │ "api_key"    │
 * │ pattern       │ 正则表达式（匹配敏感内容）              │ "sk-[a-z]+"  │
 * │ replacement   │ 替换文本（可选，默认删除匹配内容）      │ "***KEY***"  │
 * │ flags         │ 正则标志（如 "i" 忽略大小写）           │ "i"          │
 * └───────────────┴────────────────────────────────────────┴─────────────┘
 * 
 * 【新手示例】
 * const rule: RedactionRule = {
 *   name: "github_token",
 *   pattern: "ghp_[a-zA-Z0-9]{36}",
 *   replacement: "***GITHUB_TOKEN***",
 *   flags: "g"  // 全局匹配
 * };
 * 
 * 【使用场景】
 * - 文件读取后，返回给 AI 前进行脱敏
 * - 搜索结果中的匹配行脱敏
 * - diff 输出中的敏感信息脱敏
 */
export interface RedactionRule {
  name: string;
  pattern: string;
  replacement?: string;
  flags?: string;
}

/**
 * 【PolicyConfig - 安全策略配置】
 * 
 * 作用：定义完整的安全策略配置结构
 * 这是 FlyCode 的"安全宪法"，所有操作都受其约束
 * 
 * 【配置详解】
 * 请参考 config/policy.ts 中的 DEFAULT_POLICY 注释
 * 本接口只定义类型，默认值在 policy.ts 中定义
 * 
 * 【新手示例 - 完整配置】
 * const config: PolicyConfig = {
 *   allowed_roots: ["/home/user/projects"],
 *   deny_globs: ["**git/**", "*node_modules/**"],
 *   site_allowlist: ["qwen", "deepseek"],
 *   limits: {
 *     max_file_bytes: 5 * 1024 * 1024,
 *     max_inject_tokens: 12000,
 *     max_search_matches: 200
 *   },
 *   write: {
 *     require_confirmation_default: true,
 *     allow_disable_confirmation: true,
 *     backup_on_overwrite: true,
 *     pending_ttl_seconds: 600
 *   },
 *   mutation: {
 *     allow_rm: true,
 *     allow_mv: true,
 *     allow_chmod: true,
 *     allow_write_batch: true
 *   },
 *   process: {
 *     enabled: true,
 *     allowed_commands: ["npm", "node", "git"],
 *     allowed_cwds: [],
 *     default_timeout_ms: 30000,
 *     max_timeout_ms: 120000,
 *     max_output_bytes: 200000,
 *     allow_env_keys: ["CI", "NODE_ENV"]
 *   },
 *   redaction: {
 *     enabled: true,
 *     rules: [...]
 *   },
 *   audit: {
 *     enabled: true,
 *     include_content_hash: true
 *   },
 *   auth: {
 *     token_ttl_days: 30,
 *     pair_code_ttl_minutes: 5
 *   }
 * };
 * 
 * 【安全设计原则】
 * 1. 最小权限：allowed_roots 只包含必要目录
 * 2. 默认拒绝：deny_globs 明确禁止敏感文件
 * 3. 资源限制：limits 防止资源耗尽
 * 4. 操作审计：audit 记录所有敏感操作
 */
export interface PolicyConfig {
  // ── 路径控制 ──
  /**
   * allowed_roots: AI 可访问的目录白名单
   * 所有文件操作前都会检查路径是否在此列表内
   */
  allowed_roots: string[];

  /**
   * deny_globs: 禁止访问的文件模式（glob 语法）
   * 即使文件在 allowed_roots 内，匹配此模式也会被拒绝
   */
  deny_globs: string[];

  /**
   * site_allowlist: 允许连接的 AI 站点
   * 防止恶意网站通过浏览器扩展调用本地服务
   */
  site_allowlist: string[];

  // ── 资源限制 ──
  limits: {
    /** 单文件最大读取大小（字节） */
    max_file_bytes: number;
    /** 注入到 AI 的最大 Token 数 */
    max_inject_tokens: number;
    /** 搜索最大返回匹配数 */
    max_search_matches: number;
  };

  // ── 写入控制 ──
  write: {
    /** 写入操作默认需用户确认 */
    require_confirmation_default: boolean;
    /** 是否允许用户关闭确认 */
    allow_disable_confirmation: boolean;
    /** 覆盖写入前自动备份 */
    backup_on_overwrite: boolean;
    /** 确认请求有效期（秒） */
    pending_ttl_seconds: number;
  };

  // ── 变更操作控制 ──
  mutation: {
    /** 是否允许删除文件 */
    allow_rm: boolean;
    /** 是否允许移动/重命名文件 */
    allow_mv: boolean;
    /** 是否允许修改文件权限 */
    allow_chmod: boolean;
    /** 是否允许批量写入 */
    allow_write_batch: boolean;
  };

  // ── 进程执行控制 ──
  process: {
    /** 是否允许执行进程命令 */
    enabled: boolean;
    /** 允许执行的命令白名单 */
    allowed_commands: string[];
    /** 允许的工作目录白名单 */
    allowed_cwds: string[];
    /** 命令默认超时时间（毫秒） */
    default_timeout_ms: number;
    /** 命令最大超时时间（毫秒） */
    max_timeout_ms: number;
    /** 命令输出最大字节数 */
    max_output_bytes: number;
    /** 允许传递的环境变量白名单 */
    allow_env_keys: string[];
  };

  // ── 敏感信息脱敏 ──
  redaction: {
    /** 是否启用脱敏 */
    enabled: boolean;
    /** 脱敏规则列表 */
    rules: RedactionRule[];
  };

  // ── 审计日志 ──
  audit: {
    /** 是否启用审计日志 */
    enabled: boolean;
    /** 日志中是否包含文件哈希 */
    include_content_hash: boolean;
  };

  // ── 认证配置 ──
  auth: {
    /** JWT Token 有效期（天） */
    token_ttl_days: number;
    /** 配对码有效期（分钟） */
    pair_code_ttl_minutes: number;
  };
}

// =============================================================================
// 第三部分：服务上下文
// =============================================================================

/**
 * 【ServiceContext - 服务上下文】
 * 
 * 作用：聚合所有服务实例，作为依赖注入的容器
 * 
 * 【设计模式】
 * - 组合模式：将多个服务组合成一个上下文对象
 * - 依赖注入：通过上下文传递所有依赖，避免参数爆炸
 * 
 * 【新手示例 - 创建上下文】
 * const context: ServiceContext = {
 *   policy: policyConfig,
 *   pairCodeManager: new PairCodeManagerImpl(),
 *   tokenManager: new TokenManagerImpl(),
 *   siteKeyManager: new SiteKeyManagerImpl(),
 *   confirmationManager: new ConfirmationManagerImpl(),
 *   consoleEventLogger: new ConsoleEventLoggerImpl(),
 *   appConfigManager: new AppConfigManagerImpl(),
 *   pathPolicy: new PathPolicyImpl(policyConfig),
 *   redactor: new RedactorImpl(policyConfig),
 *   auditLogger: new AuditLoggerImpl(policyConfig),
 *   fileService: new FileServiceImpl(policyConfig, pathPolicy, redactor),
 *   writeManager: new WriteManagerImpl(...),
 *   writeBatchManager: new WriteBatchManagerImpl(...),
 *   processRunner: new ProcessRunnerImpl(...)
 * };
 * 
 * 【使用场景】
 * - app.ts 中创建上下文，传递给路由处理器
 * - 测试时创建 mock 上下文
 * - 需要访问多个服务时，从上下文获取
 */
export interface ServiceContext {
  /** 策略配置（所有服务的配置来源） */
  policy: PolicyConfig;

  /** 配对码管理器（首次连接认证） */
  pairCodeManager: PairCodeManager;

  /** JWT Token 管理器（持续认证） */
  tokenManager: TokenManager;

  /** 站点密钥管理器（分站点认证） */
  siteKeyManager: SiteKeyManager;

  /** 确认中心管理器（用户确认高风险操作） */
  confirmationManager: ConfirmationManager;

  /** 控制台事件日志（记录所有 API 调用） */
  consoleEventLogger: ConsoleEventLogger;

  /** 应用配置管理器（主题、偏好等） */
  appConfigManager: AppConfigManager;

  /** 路径策略检查器（路径白名单验证） */
  pathPolicy: PathPolicy;

  /** 敏感信息脱敏器 */
  redactor: Redactor;

  /** 审计日志记录器 */
  auditLogger: AuditLogger;

  /** 文件操作服务 */
  fileService: FileService;

  /** 单次写入管理器（两步写入） */
  writeManager: WriteManager;

  /** 批量写入管理器 */
  writeBatchManager: WriteBatchManager;

  /** 进程执行服务 */
  processRunner: ProcessRunner;
}

/**
 * 【PendingWriteOp - 待确认的写入操作】
 * 
 * 作用：表示一个等待用户确认的写入操作
 * 这是"两步写入"流程中的中间状态
 * 
 * 【两步写入流程】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 步骤 1: prepare                                         │
 * │   WriteManager.prepare() 创建 PendingWriteOp            │
 * │   返回 opId 和 requireConfirmation                      │
 * ├─────────────────────────────────────────────────────────┤
 * │ 步骤 2: 用户确认（如果需要）                            │
 * │   桌面应用显示确认对话框                                │
 * │   用户点击"批准"或"拒绝"                                │
 * ├─────────────────────────────────────────────────────────┤
 * │ 步骤 3: commit                                          │
 * │   WriteManager.commit() 执行实际写入                    │
 * │   使用 opId 找到对应的 PendingWriteOp                   │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【字段说明】
 * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
 * │ 字段              │ 说明                                    │ 示例         │
 * ├──────────────────┼────────────────────────────────────────┼─────────────┤
 * │ id               │ 操作唯一 ID（用于 commit 时引用）        │ "op-abc123"  │
 * │ path             │ 目标文件路径                            │ "/src/a.ts"  │
 * │ mode             │ 写入模式                                │ "overwrite"  │
 * │ content          │ 要写入的内容                            │ "..."        │
 * │ requireConfirmation│ 是否需要用户确认                      │ true         │
 * │ traceId          │ 追踪 ID（用于日志关联）                 │ "trace-001"  │
 * │ site             │ 请求来源站点                            │ "qwen"       │
 * │ createdAt        │ 创建时间                                │ Date         │
 * │ expiresAt        │ 过期时间（超时自动拒绝）                │ Date         │
 * │ expectedSha256   │ 期望的文件哈希（并发控制）              │ "abc123..."  │
 * └──────────────────┴────────────────────────────────────────┴─────────────┘
 * 
 * 【新手示例】
 * const pendingOp: PendingWriteOp = {
 *   id: "op-001",
 *   path: "/root/work/flycode/src/new.ts",
 *   mode: "overwrite",
 *   content: "export const hello = 'world';",
 *   requireConfirmation: true,
 *   traceId: "trace-001",
 *   site: "qwen",
 *   createdAt: new Date(),
 *   expiresAt: new Date(Date.now() + 600000),  // 10 分钟后过期
 *   expectedSha256: undefined
 * };
 * 
 * 【并发控制】
 * expectedSha256 用于防止并发写入冲突：
 * - 如果文件当前哈希与 expectedSha256 不匹配
 * - 说明文件已被其他操作修改
 * - commit 时会拒绝写入，避免覆盖他人修改
 */
export interface PendingWriteOp {
  id: string;
  path: string;
  mode: WriteMode;
  content: string;
  requireConfirmation: boolean;
  traceId: string;
  site: SiteId;
  createdAt: Date;
  expiresAt: Date;
  expectedSha256?: string;
}

/**
 * 【PendingWriteBatchOp - 待确认的批量写入操作】
 * 
 * 作用：表示一个等待用户确认的批量写入操作
 * 与 PendingWriteOp 类似，但包含多个文件
 * 
 * 【新手示例】
 * const batchOp: PendingWriteBatchOp = {
 *   id: "batch-001",
 *   files: [
 *     { path: "/src/a.ts", mode: "overwrite", content: "..." },
 *     { path: "/src/b.ts", mode: "overwrite", content: "..." }
 *   ],
 *   requireConfirmation: true,
 *   traceId: "trace-002",
 *   site: "qwen",
 *   createdAt: new Date(),
 *   expiresAt: new Date(Date.now() + 600000)
 * };
 * 
 * 【原子性保证】
 * - 批量写入要么全部成功，要么全部失败
 * - 如果某个文件写入失败，会回滚已写入的文件
 * - 回滚通过备份文件恢复
 */
export interface PendingWriteBatchOp {
  id: string;
  files: Array<{
    path: string;
    mode: WriteMode;
    content: string;
    expectedSha256?: string;
  }>;
  requireConfirmation: boolean;
  traceId: string;
  site: SiteId;
  createdAt: Date;
  expiresAt: Date;
}

// =============================================================================
// 第四部分：错误与审计
// =============================================================================

/**
 * 【AppErrorOptions - 应用错误选项】
 * 
 * 作用：定义 AppError 构造函数的参数类型
 * 
 * 【新手示例】
 * throw new AppError({
 *   statusCode: 404,
 *   code: "NOT_FOUND",
 *   message: "文件不存在"
 * });
 * 
 * 【错误码规范】
 * - UNAUTHORIZED: 401，认证失败
 * - FORBIDDEN: 403，权限不足
 * - NOT_FOUND: 404，资源不存在
 * - INVALID_INPUT: 422，输入参数错误
 * - LIMIT_EXCEEDED: 413，超出限制
 * - CONFLICT: 409，资源冲突
 * - INTERNAL_ERROR: 500，服务器内部错误
 */
export interface AppErrorOptions {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * 【AuditEntry - 审计日志条目】
 * 
 * 作用：记录单次文件操作的审计信息
 * 
 * 【字段说明】
 * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
 * │ 字段              │ 说明                                    │ 示例         │
 * ├──────────────────┼────────────────────────────────────────┼─────────────┤
 * │ timestamp        │ 操作时间（ISO 字符串）                   │ "2026-02-23T10:00:00.000Z" │
 * │ site             │ 请求来源站点                            │ "qwen"       │
 * │ command          │ 执行的命令（如 "fs.read"）              │ "fs.read"    │
 * │ path             │ 操作的文件路径                          │ "/src/a.ts"  │
 * │ outcome          │ 操作结果（"ok" | "error"）              │ "ok"         │
 * │ bytes            │ 操作的字节数（读取/写入大小）           │ 1024         │
 * │ truncated        │ 内容是否被截断                          │ false        │
 * │ userConfirm      │ 是否经过用户确认                        │ true         │
 * │ traceId          │ 追踪 ID（关联请求和响应）               │ "trace-001"  │
 * │ auditId          │ 审计 ID（唯一标识此次操作）             │ "audit-001"  │
 * │ errorCode        │ 错误码（outcome="error" 时）            │ "NOT_FOUND"  │
 * │ message          │ 错误信息                                │ "..."        │
 * └──────────────────┴────────────────────────────────────────┴─────────────┘
 * 
 * 【新手示例】
 * const entry: AuditEntry = {
 *   timestamp: "2026-02-23T10:00:00.000Z",
 *   site: "qwen",
 *   command: "fs.read",
 *   path: "/root/work/flycode/README.md",
 *   outcome: "ok",
 *   bytes: 3481,
 *   truncated: false,
 *   userConfirm: false,
 *   traceId: "trace-001",
 *   auditId: "audit-001"
 * };
 * 
 * 【存储位置】
 * 审计日志存储在 ~/.flycode/audit/YYYY-MM-DD.jsonl
 * 每行一个 JSON 对象，便于流式处理和日志轮转
 */
export interface AuditEntry {
  timestamp: string;
  site: SiteId;
  command: string;
  path?: string;
  outcome: "ok" | "error";
  bytes?: number;
  truncated: boolean;
  userConfirm?: boolean;
  traceId: string;
  auditId: string;
  errorCode?: string;
  message?: string;
}

// =============================================================================
// 第五部分：管理器接口 (Manager)
// =============================================================================

/**
 * 【PairCodeManager - 配对码管理器接口】
 * 
 * 作用：管理配对码的生成、验证和过期
 * 
 * 【配对流程】
 * 1. 服务启动时生成配对码（如 FLYCODE-123456）
 * 2. 用户在扩展 Options 页面输入配对码
 * 3. 扩展调用 /pair/verify 接口验证
 * 4. 验证成功后返回 JWT Token
 * 5. 配对码使用后失效（一次性）
 * 
 * 【新手示例 - 实现类使用】
 * const code = pairCodeManager.getCurrentCode();
 * console.log(`配对码：${code}（有效期至 ${pairCodeManager.getExpiry()}）`);
 * 
 * const isValid = pairCodeManager.verify("FLYCODE-123456");
 * if (isValid) {
 *   const { token, expiresAt } = await tokenManager.issueToken();
 * }
 */
export interface PairCodeManager {
  /** 生成新的配对码（服务启动时调用） */
  issueCode(): string;

  /** 获取当前有效的配对码 */
  getCurrentCode(): string;

  /** 验证配对码是否正确且未过期 */
  verify(code: string): boolean;

  /** 获取当前配对码的过期时间 */
  getExpiry(): Date;
}

/**
 * 【TokenManager - JWT Token 管理器接口】
 * 
 * 作用：管理 JWT Token 的颁发和验证
 * 
 * 【Token 生命周期】
 * 1. 用户配对成功后，issueToken() 颁发 Token
 * 2. Token 有效期 30 天（policy.auth.token_ttl_days）
 * 3. 每次请求携带 Token（Authorization: Bearer <token>）
 * 4. requireBearerAuth() 验证 Token 有效性
 * 5. Token 过期后需重新配对
 * 
 * 【安全设计】
 * - Token 使用 JWT 格式，包含签名防止篡改
 * - Token 包含 exp claim，自动过期
 * - 可添加撤销列表，支持主动失效
 * 
 * 【新手示例】
 * const { token, expiresAt } = await tokenManager.issueToken();
 * console.log(`Token: ${token}（有效期至 ${expiresAt}）`);
 * 
 * const isValid = await tokenManager.verifyToken(token);
 * console.log(`Token 有效：${isValid}`);
 */
export interface TokenManager {
  /** 颁发新的 JWT Token */
  issueToken(): Promise<{ token: string; expiresAt: Date }>;

  /** 验证 Token 是否有效且未过期 */
  verifyToken(token: string): Promise<boolean>;
}

/**
 * 【SiteKeyManager - 站点密钥管理器接口】
 * 
 * 作用：管理各 AI 站点的独立密钥
 * 
 * 【为什么需要站点密钥？】
 * - 分站点隔离：qwen 的密钥不能用于 deepseek 路由
 * - 独立轮换：某个站点密钥泄露，不影响其他站点
 * - 审计追踪：可以追溯每个站点的操作记录
 * 
 * 【密钥存储】
 * 密钥存储在 ~/.flycode/site-keys.json
 * 格式：
 * {
 *   "createdAt": "...",
 *   "rotatedAt": "...",
 *   "sites": {
 *     "qwen": { "site": "qwen", "key": "sk-...", ... },
 *     "deepseek": { "site": "deepseek", "key": "sk-...", ... }
 *   }
 * }
 * 
 * 【新手示例】
 * const keys = await siteKeyManager.getSiteKeys();
 * console.log(`qwen 密钥创建时间：${keys.sites.qwen?.createdAt}`);
 * 
 * // 轮换密钥（密钥泄露时）
 * const newKeys = await siteKeyManager.rotateSiteKey("qwen");
 * 
 * // 验证站点密钥
 * const isValid = await siteKeyManager.verifySiteKey("qwen", "sk-...");
 */
export interface SiteKeyManager {
  /** 获取当前站点密钥配置 */
  getSiteKeys(): Promise<SiteKeysResponse>;

  /** 确保站点密钥存在（不存在则创建） */
  ensureSiteKeys(): Promise<SiteKeysResponse>;

  /** 轮换指定站点的密钥 */
  rotateSiteKey(site: Exclude<SiteId, "unknown">): Promise<SiteKeysResponse>;

  /** 验证站点密钥是否正确 */
  verifySiteKey(site: Exclude<SiteId, "unknown">, token: string): Promise<boolean>;
}

/**
 * 【ConfirmationDecision - 确认决策】
 * 
 * 作用：表示用户对确认请求的决策
 * 
 * 【新手示例】
 * const approve: ConfirmationDecision = {
 *   approved: true,
 *   alwaysAllow: false  // 不记住选择，下次还要确认
 * };
 * 
 * const reject: ConfirmationDecision = {
 *   approved: false
 * };
 * 
 * const approveAlways: ConfirmationDecision = {
 *   approved: true,
 *   alwaysAllow: true  // 记住选择，该站点该工具不再确认
 * };
 */
export interface ConfirmationDecision {
  /** 是否批准 */
  approved: boolean;

  /** 是否记住选择（总是允许该站点使用该工具） */
  alwaysAllow?: boolean;
}

/**
 * 【ConfirmationManager - 确认中心管理器接口】
 * 
 * 作用：管理高风险操作的用户确认流程
 * 
 * 【确认流程】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 1. 创建确认请求                                          │
 * │    confirmationManager.createPending({...})              │
 * │    返回 ConfirmationEntry（含 id 和 status="pending"）   │
 * ├─────────────────────────────────────────────────────────┤
 * │ 2. 桌面应用显示确认对话框                                │
 * │    显示 summary（如"覆盖写入 /src/a.ts (1.2KB)"）       │
 * │    用户点击"批准"或"拒绝"                                │
 * ├─────────────────────────────────────────────────────────┤
 * │ 3. 记录决策                                              │
 * │    confirmationManager.resolve(id, { approved: true })   │
 * │    status 变为 "approved" 或 "rejected"                 │
 * ├─────────────────────────────────────────────────────────┤
 * │ 4. 执行或拒绝操作                                        │
 * │    approved=true → 执行实际写入                          │
 * │    approved=false → 返回 FORBIDDEN 错误                  │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【超时处理】
 * - 确认请求有效期 pending_ttl_seconds（默认 600 秒）
 * - 超时后 status 自动变为 "timeout"
 * - 操作被拒绝
 * 
 * 【新手示例】
 * // 创建确认请求
 * const entry = await confirmationManager.createPending({
 *   site: "qwen",
 *   tool: "fs.write",
 *   summary: "覆盖写入 /src/index.ts (1.2KB)",
 *   traceId: "trace-001",
 *   request: { path: "/src/index.ts", content: "..." }
 * });
 * console.log(`确认 ID: ${entry.id}`);
 * 
 * // 用户批准后
 * await confirmationManager.resolve(entry.id, { approved: true });
 * 
 * // 检查是否可以跳过确认（用户设置了 alwaysAllow）
 * const shouldSkip = await confirmationManager.shouldSkipConfirmation("qwen", "fs.write");
 */
export interface ConfirmationManager {
  /** 创建待确认的操作请求 */
  createPending(input: {
    site: Exclude<SiteId, "unknown">;
    tool: string;
    summary: string;
    traceId: string;
    request: unknown;
  }): Promise<ConfirmationEntry>;

  /** 根据 ID 获取确认条目 */
  getById(id: string): Promise<ConfirmationEntry | null>;

  /** 记录用户决策（批准/拒绝） */
  resolve(id: string, input: ConfirmationDecision): Promise<ConfirmationEntry>;

  /** 检查是否可以跳过确认（用户设置了 alwaysAllow） */
  shouldSkipConfirmation(site: Exclude<SiteId, "unknown">, tool: string): Promise<boolean>;

  /** 列出最近的确认记录 */
  listRecent(limit: number): Promise<ConfirmationEntry[]>;

  /** 获取确认请求的原始负载（用于执行操作） */
  getRequestPayload(id: string): unknown | undefined;
}

/**
 * 【ConsoleEventLogger - 控制台事件日志接口】
 * 
 * 作用：记录所有 API 调用事件，用于调试和审计
 * 
 * 【与 AuditLogger 的区别】
 * - AuditLogger: 记录文件操作等敏感操作（安全审计）
 * - ConsoleEventLogger: 记录所有 API 调用（调试用途）
 * 
 * 【存储位置】
 * 日志存储在 ~/.flycode/console/YYYY-MM-DD.jsonl
 * 
 * 【新手示例】
 * // 记录事件
 * await consoleEventLogger.log({
 *   id: "event-001",
 *   timestamp: new Date().toISOString(),
 *   site: "qwen",
 *   method: "tools/call",
 *   tool: "fs.read",
 *   status: "success",
 *   durationMs: 123,
 *   request: { path: "/README.md" },
 *   response: { content: "..." }
 * });
 * 
 * // 查询最近事件
 * const events = await consoleEventLogger.listRecent({
 *   site: "qwen",
 *   status: "failed",
 *   limit: 50
 * });
 * 
 * // 清理过期日志
 * await consoleEventLogger.cleanupExpired(30);  // 保留 30 天
 */
export interface ConsoleEventLogger {
  /** 记录单个事件 */
  log(entry: ConsoleEventEntry): Promise<void>;

  /** 查询最近事件（支持多种过滤条件） */
  listRecent(input?: {
    site?: SiteId | "all";
    status?: "success" | "failed" | "pending" | "all";
    tool?: string;
    keyword?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<ConsoleEventEntry[]>;

  /** 清理过期日志 */
  cleanupExpired(retentionDays: number): Promise<void>;
}

/**
 * 【AppConfigData - 应用配置数据】
 * 
 * 作用：定义桌面应用的用户偏好配置
 * 
 * 【存储位置】
 * 配置存储在 ~/.flycode/app-config.json
 * 
 * 【新手示例】
 * const config: AppConfigData = {
 *   theme: "dark",
 *   logRetentionDays: 30,
 *   servicePort: 39393,
 *   alwaysAllow: {
 *     "qwen:fs.read": true,  // qwen 站点读取文件无需确认
 *     "deepseek:fs.search": true
 *   }
 * };
 */
export interface AppConfigData {
  /** 主题："light" | "dark" | "system" */
  theme: "light" | "dark" | "system";

  /** 日志保留天数 */
  logRetentionDays: number;

  /** 服务监听端口 */
  servicePort: number;

  /** 始终允许的操作（跳过确认） */
  alwaysAllow: Record<string, boolean>;
}

/**
 * 【AppConfigManager - 应用配置管理器接口】
 * 
 * 作用：管理应用配置的加载、保存和更新
 * 
 * 【新手示例】
 * // 加载配置
 * const config = await appConfigManager.load();
 * console.log(`当前主题：${config.theme}`);
 * 
 * // 保存配置
 * await appConfigManager.save({
 *   ...config,
 *   theme: "dark"
 * });
 * 
 * // 更新 alwaysAllow
 * await appConfigManager.updateAlwaysAllow("qwen", "fs.read", true);
 */
export interface AppConfigManager {
  /** 加载应用配置 */
  load(): Promise<AppConfigData>;

  /** 保存新配置 */
  save(next: AppConfigData): Promise<AppConfigData>;

  /** 更新 alwaysAllow 配置 */
  updateAlwaysAllow(site: Exclude<SiteId, "unknown">, tool: string, allow: boolean): Promise<AppConfigData>;
}

// =============================================================================
// 第六部分：服务接口 (Service)
// =============================================================================

/**
 * 【PathPolicy - 路径策略检查器接口】
 * 
 * 作用：验证路径是否在允许的范围内
 * 
 * 【安全检查流程】
 * 1. normalizeInputPath(): 将输入路径标准化为绝对路径
 * 2. assertAllowed(): 检查路径是否在 allowed_roots 内
 * 3. 检查是否匹配 deny_globs
 * 4. 通过则允许操作，否则抛异常
 * 
 * 【新手示例】
 * const normalized = pathPolicy.normalizeInputPath("./src/../README.md");
 * // 返回："/root/work/flycode/README.md"
 * 
 * pathPolicy.assertAllowed("/root/work/flycode/README.md");
 * // 如果在 allowed_roots 内，不抛异常
 * 
 * pathPolicy.assertAllowed("/etc/passwd");
 * // 抛出：403 POLICY_BLOCKED - Path not in allowed roots
 * 
 * pathPolicy.assertSiteAllowed("qwen");
 * // 如果 qwen 在 site_allowlist 内，不抛异常
 */
export interface PathPolicy {
  /** 标准化输入路径（转为绝对路径，解析 ../ 等） */
  normalizeInputPath(inputPath: string): string;

  /** 断言路径允许访问（不允许则抛异常） */
  assertAllowed(path: string): void;

  /** 断言站点允许访问（不允许则抛异常） */
  assertSiteAllowed(site: SiteId): void;
}

/**
 * 【Redactor - 敏感信息脱敏器接口】
 * 
 * 作用：从内容中识别并替换敏感信息
 * 
 * 【脱敏规则】
 * 规则定义在 policy.redaction.rules 中，包括：
 * - API Key（sk-开头）
 * - 密码赋值（password = "xxx"）
 * - 私钥块（-----BEGIN PRIVATE KEY-----）
 * 
 * 【新手示例】
 * const result = redactor.redact(`
 *   const apiKey = "sk-abc123def456";
 *   const password = "secret123";
 * `);
 * 
 * console.log(result.content);
 * // 输出:
 * //   const apiKey = "***REDACTED***";
 * //   const password = "***REDACTED***";
 * 
 * console.log(result.changed);  // true（有内容被脱敏）
 * 
 * 【使用场景】
 * - 文件读取后，返回给 AI 前脱敏
 * - 搜索结果中的匹配行脱敏
 * - diff 输出中的敏感信息脱敏
 */
export interface Redactor {
  /**
   * 脱敏内容
   * @param content 原始内容
   * @returns 脱敏后的内容和是否变更标志
   */
  redact(content: string): { content: string; changed: boolean };
}

/**
 * 【AuditLogger - 审计日志记录器接口】
 * 
 * 作用：记录敏感操作的审计日志
 * 
 * 【与 ConsoleEventLogger 的区别】
 * - AuditLogger: 安全审计，记录文件操作等敏感操作
 * - ConsoleEventLogger: 调试用途，记录所有 API 调用
 * 
 * 【新手示例】
 * await auditLogger.log({
 *   timestamp: new Date().toISOString(),
 *   site: "qwen",
 *   command: "fs.write",
 *   path: "/src/index.ts",
 *   outcome: "ok",
 *   bytes: 1024,
 *   truncated: false,
 *   userConfirm: true,
 *   traceId: "trace-001",
 *   auditId: "audit-001"
 * });
 */
export interface AuditLogger {
  /** 记录单条审计日志 */
  log(entry: AuditEntry): Promise<void>;
}

/**
 * 【FileService - 文件操作服务接口】
 * 
 * 作用：定义所有文件操作的方法签名
 * 
 * 【方法列表】
 * ┌───────────────┬────────────────────────────────────────┬─────────────┐
 * │ 方法           │ 说明                                    │ 返回值       │
 * ├───────────────┼────────────────────────────────────────┼─────────────┤
 * │ ls            │ 列出目录内容                            │ 条目列表     │
 * │ mkdir         │ 创建目录                                │ 创建结果     │
 * │ read          │ 读取文件内容                            │ 内容 + 元数据 │
 * │ search        │ 搜索文件内容                            │ 匹配结果列表 │
 * │ rm            │ 删除文件/目录                           │ 删除结果     │
 * │ mv            │ 移动/重命名文件                         │ 移动结果     │
 * │ chmod         │ 修改文件权限                            │ 权限结果     │
 * │ diff          │ 比较文件差异                            │ unified diff │
 * │ commitWrite   │ 提交写入操作（两步写入第二步）          │ 写入结果     │
 * │ existingSha256│ 获取现有文件哈希                        │ 哈希或 null  │
 * └───────────────┴────────────────────────────────────────┴─────────────┘
 * 
 * 【详细文档】
 * 请参考 services/file-service.ts 中的详细注释
 * 
 * 【新手示例】
 * // 列出目录
 * const lsResult = await fileService.ls("/root/work/flycode", 2, undefined);
 * 
 * // 读取文件
 * const readResult = await fileService.read("/root/work/flycode/README.md", {
 *   range: "head:500"
 * });
 * 
 * // 搜索内容
 * const searchResult = await fileService.search("/root/work/flycode/src", {
 *   query: "function main",
 *   limit: 50
 * });
 */
export interface FileService {
  ls(
    inputPath: string,
    depth: number | undefined,
    glob: string | undefined
  ): Promise<{ entries: Array<{ path: string; type: "file" | "directory"; bytes?: number }>; truncated: boolean }>;

  mkdir(inputPath: string, parents: boolean | undefined): Promise<{ path: string; created: boolean; parents: boolean }>;

  read(
    inputPath: string,
    options: {
      range?: string;
      line?: number;
      lines?: string;
      encoding?: ReadEncoding;
      includeMeta?: boolean;
    }
  ): Promise<{
    content: string;
    mime: string;
    bytes: number;
    sha256: string;
    truncated: boolean;
    meta?: {
      size: number;
      mtime: string;
      ctime: string;
      mode: string;
    };
  }>;

  search(
    inputPath: string,
    options: {
      query: string;
      regex?: boolean;
      glob?: string;
      limit?: number;
      extensions?: string[];
      minBytes?: number;
      maxBytes?: number;
      mtimeFrom?: string;
      mtimeTo?: string;
      contextLines?: number;
    }
  ): Promise<{
    matches: Array<{
      path: string;
      line: number;
      column: number;
      text: string;
      before?: Array<{ line: number; text: string }>;
      after?: Array<{ line: number; text: string }>;
    }>;
    total: number;
    truncated: boolean;
  }>;

  rm(
    inputPath: string,
    options: { recursive?: boolean; force?: boolean }
  ): Promise<{ path: string; removed: boolean; type: "file" | "directory" | "missing"; recursive: boolean }>;

  mv(
    fromPath: string,
    toPath: string,
    overwrite: boolean | undefined
  ): Promise<{ fromPath: string; toPath: string; overwritten: boolean }>;

  chmod(inputPath: string, mode: string): Promise<{ path: string; mode: string }>;

  diff(input: {
    leftPath: string;
    rightPath?: string;
    rightContent?: string;
    contextLines?: number;
  }): Promise<{ leftPath: string; rightPath?: string; changed: boolean; unifiedDiff: string; truncated: boolean }>;

  commitWrite(op: PendingWriteOp): Promise<{ path: string; writtenBytes: number; backupPath?: string; newSha256: string }>;

  existingSha256(inputPath: string): Promise<string | null>;
}

/**
 * 【WriteManager - 写入管理器接口】
 * 
 * 作用：管理单次写入的两步确认流程
 * 
 * 【两步写入流程】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 步骤 1: prepare                                         │
 * │   创建 PendingWriteOp，存储在内存中                     │
 * │   返回 opId 和 requireConfirmation                      │
 * │   如果需要确认，桌面应用显示确认对话框                  │
 * ├─────────────────────────────────────────────────────────┤
 * │ 步骤 2: commit                                          │
 * │   用户确认后调用                                        │
 * │   根据 opId 找到 PendingWriteOp                         │
 * │   调用 fileService.commitWrite() 执行实际写入           │
 * │   清理 PendingWriteOp                                   │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手示例】
 * // 步骤 1: 准备写入
 * const prepareResult = await writeManager.prepare({
 *   path: "/root/work/flycode/src/new.ts",
 *   mode: "overwrite",
 *   content: "export const hello = 'world';",
 *   traceId: "trace-001",
 *   site: "qwen"
 * });
 * 
 * console.log(`操作 ID: ${prepareResult.opId}`);
 * console.log(`需要确认：${prepareResult.requireConfirmation}`);
 * 
 * // 步骤 2: 提交写入（用户确认后）
 * const writeResult = await writeManager.commit({
 *   opId: prepareResult.opId,
 *   confirmedByUser: true,
 *   traceId: "trace-001",
 *   site: "qwen"
 * });
 * 
 * console.log(`写入成功：${writeResult.path}`);
 * console.log(`备份文件：${writeResult.backupPath}`);
 */
export interface WriteManager {
  /** 准备写入操作（第一步） */
  prepare(input: {
    path: string;
    mode: WriteMode;
    content: string;
    traceId: string;
    site: SiteId;
    expectedSha256?: string;
    disableConfirmation?: boolean;
  }): Promise<{ opId: string; requireConfirmation: boolean; summary: string }>;

  /** 提交写入操作（第二步） */
  commit(input: {
    opId: string;
    confirmedByUser: boolean;
    traceId: string;
    site: SiteId;
  }): Promise<{ path: string; writtenBytes: number; backupPath?: string; newSha256: string }>;
}

/**
 * 【WriteBatchManager - 批量写入管理器接口】
 * 
 * 作用：管理批量写入的两步确认流程
 * 
 * 【与 WriteManager 的区别】
 * - WriteManager: 单次写入一个文件
 * - WriteBatchManager: 单次写入多个文件（原子操作）
 * 
 * 【原子性保证】
 * - 所有文件要么全部写入成功，要么全部失败
 * - 如果某个文件写入失败，会回滚已写入的文件
 * - 回滚通过备份文件恢复
 * 
 * 【新手示例】
 * // 步骤 1: 准备批量写入
 * const prepareResult = await writeBatchManager.prepare({
 *   files: [
 *     { path: "/src/a.ts", mode: "overwrite", content: "..." },
 *     { path: "/src/b.ts", mode: "overwrite", content: "..." }
 *   ],
 *   traceId: "trace-002",
 *   site: "qwen"
 * });
 * 
 * console.log(`操作 ID: ${prepareResult.opId}`);
 * console.log(`文件数：${prepareResult.totalFiles}`);
 * console.log(`总字节：${prepareResult.totalBytes}`);
 * 
 * // 步骤 2: 提交批量写入
 * const batchResult = await writeBatchManager.commit({
 *   opId: prepareResult.opId,
 *   confirmedByUser: true,
 *   traceId: "trace-002",
 *   site: "qwen"
 * });
 * 
 * console.log(`写入文件：${batchResult.files.map(f => f.path)}`);
 */
export interface WriteBatchManager {
  /** 准备批量写入操作（第一步） */
  prepare(input: {
    files: WriteBatchFileInput[];
    traceId: string;
    site: SiteId;
    disableConfirmation?: boolean;
  }): Promise<{ opId: string; requireConfirmation: boolean; summary: string; totalFiles: number; totalBytes: number }>;

  /** 提交批量写入操作（第二步） */
  commit(input: {
    opId: string;
    confirmedByUser: boolean;
    traceId: string;
    site: SiteId;
  }): Promise<{ files: Array<{ path: string; mode: WriteMode; writtenBytes: number; backupPath?: string; newSha256: string }> }>;
}

/**
 * 【ProcessRunner - 进程执行服务接口】
 * 
 * 作用：执行外部命令和 shell 脚本
 * 
 * 【方法说明】
 * ┌───────────────┬────────────────────────────────────────┬─────────────┐
 * │ 方法           │ 说明                                    │ 安全级别     │
 * ├───────────────┼────────────────────────────────────────┼─────────────┤
 * │ run           │ 执行命令（不经过 shell，更安全）        │ ⭐⭐⭐⭐⭐      │
 * │ exec          │ 执行 shell 命令（支持管道等，风险较高）  │ ⭐⭐⭐        │
 * └───────────────┴────────────────────────────────────────┴─────────────┘
 * 
 * 【新手示例 - run】
 * const result = await processRunner.run({
 *   command: "npm",
 *   args: ["install"],
 *   cwd: "/root/work/flycode",
 *   timeoutMs: 60000
 * });
 * 
 * console.log(`退出码：${result.exitCode}`);
 * console.log(`输出：${result.stdout}`);
 * console.log(`耗时：${result.durationMs}ms`);
 * 
 * 【新手示例 - exec】
 * const result = await processRunner.exec({
 *   command: "grep -r 'function' src/ | head -20",
 *   cwd: "/root/work/flycode",
 *   timeoutMs: 30000
 * });
 * 
 * 【安全限制】
 * - 命令必须在 policy.process.allowed_commands 白名单中
 * - 工作目录必须在 allowed_cwds 或 allowed_roots 内
 * - 环境变量只能在 allow_env_keys 白名单中
 * - 输出大小受 max_output_bytes 限制
 */
export interface ProcessRunner {
  /** 执行命令（不经过 shell） */
  run(input: {
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
  }>;

  /** 执行 shell 命令（支持管道、重定向等） */
  exec(input: {
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
  }>;
}

// =============================================================================
// 文件结束 - 新手学习指引
// =============================================================================
// 
// 【理解这个文件后，你应该掌握】
// ✅ 所有管理器接口的职责和方法
// ✅ 所有服务接口的职责和方法
// ✅ 配置类接口的结构和用途
// ✅ 两步写入流程（prepare → commit）
// ✅ 认证流程（PairCode → Token → SiteKey）
// ✅ 审计和控制台日志的区别
// 
// 【架构理解】
// - ServiceContext 聚合所有服务，便于依赖注入
// - Manager 负责业务逻辑（如确认流程）
// - Service 负责具体操作（如文件读写）
// - 接口与实现分离，便于测试和替换
// 
// 【下一步学习】
// 建议继续阅读:
// - services/path-policy.ts: PathPolicy 接口实现
// - services/redactor.ts: Redactor 接口实现
// - services/write-manager.ts: WriteManager 接口实现
// - services/confirmation-center.ts: ConfirmationManager 接口实现
// - app.ts: 如何组装所有服务
// =============================================================================
