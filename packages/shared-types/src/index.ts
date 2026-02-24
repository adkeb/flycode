/**
 * =============================================================================
 * FlyCode V2 - 共享协议类型定义
 * =============================================================================
 * 
 * 【文件作用】
 * 这是 FlyCode 项目的"类型字典"，定义了所有包之间通信时使用的数据结构。
 * 想象它是一个"合同模板库"，确保浏览器扩展、本地服务、桌面应用三方
 * 在对话时使用相同的语言格式。
 * 
 * 【为什么需要共享类型？】
 * - 类型安全：TypeScript 可以在编译时发现字段拼写错误
 * - 版本同步：所有包引用同一份类型，避免接口不一致
 * - 文档作用：通过类型定义可以了解系统支持哪些功能
 * 
 * 【使用场景】
 * 1. 浏览器扩展发送请求时，使用 FsReadRequest 类型构建请求体
 * 2. 本地服务接收请求后，用相同类型验证参数完整性
 * 3. 返回响应时，使用 ReadData 类型确保返回格式正确
 * 
 * @moduleflycode/shared-types
 * @version0.1.0
 */

// =============================================================================
// 第一部分：基础类型定义
// =============================================================================

/**
 * 【SiteId - AI 站点标识】
 * 
 * 作用：标识请求来自哪个 AI 平台，用于分站点管理密钥和审计日志。
 * 
 * 可选值说明：
 * - "qwen"     : 通义千问 (阿里云)
 * - "deepseek" : 深度求索 (国产大模型)
 * - "gemini"   : 谷歌 Gemini (预留适配位)
 * - "unknown"  : 未识别的站点（用于本地直接调用）
 * 
 * 【新手示例】
 * const request: FsReadRequest = {
 *   path: "/home/user/file.txt",
 *   site: "qwen",        // ← 标记请求来源
 *   traceId: "trace-001"
 * };
 */
export type SiteId = "qwen" | "deepseek" | "gemini" | "unknown";

/**
 * 【ApiErrorCode - API 错误码枚举】
 * 
 * 作用：统一错误处理，让调用方能根据错误码做出不同响应。
 * 
 * 错误码详解：
 * ┌─────────────────────────────┬────────────────────────────────────┐
 * │ 错误码                       │ 触发场景                            │
 * ├─────────────────────────────┼────────────────────────────────────┤
 * │ UNAUTHORIZED                │ Token 缺失或过期                     │
 * │ FORBIDDEN                   │ Token 有效但无权限（如站点密钥不匹配） │
 * │ INVALID_INPUT               │ 参数格式错误（如路径不合法）          │
 * │ NOT_FOUND                   │ 文件/目录不存在                      │
 * │ LIMIT_EXCEEDED              │ 超出策略限制（如文件>5MB）           │
 * │ CONFLICT                    │ 资源冲突（如覆盖写入但目标已存在）    │
 * │ INTERNAL_ERROR              │ 服务器内部错误                       │
 * │ NOT_SUPPORTED               │ 功能不支持（如 Windows 上 chmod）     │
 * │ POLICY_BLOCKED              │ 被安全策略阻止（如删除根目录）        │
 * │ WRITE_CONFIRMATION_REQUIRED │ 需要用户确认写入操作                 │
 * │ PAIRING_FAILED              │ 配对码验证失败                       │
 * └─────────────────────────────┴────────────────────────────────────┘
 * 
 * 【新手示例】
 * if (result.errorCode === "NOT_FOUND") {
 *   console.log("文件不存在，请检查路径");
 * } else if (result.errorCode === "LIMIT_EXCEEDED") {
 *   console.log("文件太大，请分段读取");
 * }
 */
export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "LIMIT_EXCEEDED"
  | "CONFLICT"
  | "INTERNAL_ERROR"
  | "NOT_SUPPORTED"
  | "POLICY_BLOCKED"
  | "WRITE_CONFIRMATION_REQUIRED"
  | "PAIRING_FAILED";

/**
 * 【CommandResult - 命令执行结果通用包装器】
 * 
 * 作用：所有 API 调用的统一返回格式，便于前端统一处理。
 * 
 * 字段说明：
 * - ok          : 是否成功（true/false），判断的第一依据
 * - errorCode   : 失败时的错误码，ok=false 时才有意义
 * - message     : 人类可读的错误/成功信息
 * - data        : 成功时的实际数据（泛型 T）
 * - auditId     : 审计日志 ID，用于追踪和排查问题
 * - truncated   : 数据是否被截断（如内容太长只返回部分）
 * 
 * 【新手示例】
 * interface ReadData { content: string; }
 * 
 * const result: CommandResult<ReadData> = await api.read(...);
 * 
 * if (result.ok) {
 *   console.log("读取成功:", result.data.content);
 * } else {
 *   console.error(`失败 [${result.errorCode}]: ${result.message}`);
 * }
 */
export interface CommandResult<T = unknown> {
  ok: boolean;
  errorCode?: ApiErrorCode;
  message?: string;
  data?: T;
  auditId: string;
  truncated: boolean;
}

// =============================================================================
// 第二部分：文件操作请求类型（Request）
// =============================================================================
// 说明：这些类型定义了"客户端可以发起哪些文件操作请求"
// 每个请求都包含 traceId（追踪 ID）和 site（站点标识）用于审计

/**
 * 【FsLsRequest - 列出目录内容请求】
 * 
 * 作用：请求列出某个目录下的文件和子目录。
 * 
 * 参数详解：
 * - path   : 要列出的目录绝对路径（必填）
 * - depth  : 递归深度，2 表示只列两层（可选，默认 2）
 * - glob   : 文件名匹配模式，如 "*.ts"（可选）
 * - traceId: 本次请求的唯一追踪 ID（必填，用于日志关联）
 * - site   : 请求来源站点（必填，用于分站点审计）
 * 
 * 【新手示例】
 * const lsRequest: FsLsRequest = {
 *   path: "/root/work/flycode",
 *   depth: 2,              // 只列两层，避免 node_modules 爆炸
 *   glob: "*.json",        // 只匹配 JSON 文件
 *   traceId: "req-001",
 *   site: "deepseek"
 * };
 */
export interface FsLsRequest {
  path: string;
  depth?: number;
  glob?: string;
  traceId: string;
  site: SiteId;
}

/**
 * 【FsReadRequest - 读取文件内容请求】
 * 
 * 作用：请求读取文件内容，支持多种读取方式。
 * 
 * 参数详解：
 * - path        : 文件绝对路径（必填）
 * - range       : 字节范围，如 "head:1000" 读前 1000 字节（可选）
 * - line        : 读取指定行号（可选，与 range/lines 互斥）
 * - lines       : 读取行范围，如 "10-20"（可选）
 * - encoding    : 编码方式：utf-8 | base64 | hex（可选，默认 utf-8）
 * - includeMeta : 是否返回文件元数据（大小、时间等）（可选）
 * - traceId     : 追踪 ID（必填）
 * - site        : 站点标识（必填）
 * 
 * 【新手示例 - 读取前 500 字符】
 * const readRequest: FsReadRequest = {
 *   path: "/root/work/flycode/README.md",
 *   range: "head:500",     // 只读前 500 字符，节省 Token
 *   traceId: "req-002",
 *   site: "qwen"
 * };
 * 
 * 【新手示例 - 读取指定行】
 * const readLineRequest: FsReadRequest = {
 *   path: "/root/work/flycode/src/index.ts",
 *   line: 42,              // 读取第 42 行
 *   traceId: "req-003",
 *   site: "qwen"
 * };
 */
export interface FsReadRequest {
  path: string;
  range?: string;
  line?: number;
  lines?: string;
  encoding?: ReadEncoding;
  includeMeta?: boolean;
  traceId: string;
  site: SiteId;
}

/**
 * 【FsSearchRequest - 文件内容搜索请求】
 * 
 * 作用：在指定目录中搜索包含特定内容的文件。
 * 
 * 参数详解：
 * - path        : 搜索起始目录（必填）
 * - query       : 搜索关键词或正则表达式（必填）
 * - regex       : 是否将 query 当作正则（可选，默认 false）
 * - glob        : 文件名过滤模式，如 "*.ts"（可选）
 * - limit       : 最大返回匹配数（可选，受策略限制）
 * - extensions  : 文件扩展名过滤，如 [".ts", ".js"]（可选）
 * - minBytes    : 最小文件大小过滤（可选）
 * - maxBytes    : 最大文件大小过滤（可选）
 * - mtimeFrom   : 修改时间起始（ISO 日期字符串）（可选）
 * - mtimeTo     : 修改时间截止（ISO 日期字符串）（可选）
 * - contextLines: 匹配行前后各显示多少行上下文（可选，0-5）
 * - traceId     : 追踪 ID（必填）
 * - site        : 站点标识（必填）
 * 
 * 【新手示例 - 搜索 TypeScript 文件中的函数定义】
 * const searchRequest: FsSearchRequest = {
 *   path: "/root/work/flycode/src",
 *   query: "function \\w+\\(",    // 正则匹配函数定义
 *   regex: true,
 *   extensions: [".ts"],
 *   contextLines: 2,              // 显示前后各 2 行上下文
 *   limit: 50,
 *   traceId: "req-004",
 *   site: "deepseek"
 * };
 */
export interface FsSearchRequest {
  path: string;
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
  traceId: string;
  site: SiteId;
}

/**
 * 【FsMkdirRequest - 创建目录请求】
 * 
 * 作用：创建新目录。
 * 
 * 参数详解：
 * - path    : 要创建的目录路径（必填）
 * - parents : 是否递归创建父目录，类似 mkdir -p（可选）
 * - traceId : 追踪 ID（必填）
 * - site    : 站点标识（必填）
 * 
 * 【新手示例】
 * const mkdirRequest: FsMkdirRequest = {
 *   path: "/root/work/flycode/dist/assets",
 *   parents: true,           // 如果 dist 不存在也一并创建
 *   traceId: "req-005",
 *   site: "qwen"
 * };
 */
export interface FsMkdirRequest {
  path: string;
  parents?: boolean;
  traceId: string;
  site: SiteId;
}

/**
 * 【WriteMode - 写入模式枚举】
 * 
 * - "overwrite" : 覆盖写入（文件存在则替换）
 * - "append"    : 追加写入（在文件末尾添加内容）
 * 
 * 【新手示例】
 * const overwriteMode: WriteMode = "overwrite";  // 覆盖
 * const appendMode: WriteMode = "append";        // 追加
 */
export type WriteMode = "overwrite" | "append";

/**
 * 【ReadEncoding - 读取编码方式枚举】
 * 
 * - "utf-8"  : 文本文件默认编码
 * - "base64" : 二进制文件（如图片）编码
 * - "hex"    : 十六进制编码（用于调试）
 * 
 * 【新手示例】
 * const textEncoding: ReadEncoding = "utf-8";    // 读文本
 * const imageEncoding: ReadEncoding = "base64";  // 读图片
 */
export type ReadEncoding = "utf-8" | "base64" | "hex";

/**
 * 【FsWritePrepareRequest - 写入文件准备请求】
 * 
 * 作用：发起写入请求，系统会返回是否需要用户确认。
 * 这是"两步写入"的第一步，用于安全控制。
 * 
 * 参数详解：
 * - path              : 目标文件路径（必填）
 * - mode              : 写入模式：overwrite | append（必填）
 * - content           : 要写入的内容（必填）
 * - expectedSha256    : 期望的文件哈希，用于防止并发冲突（可选）
 * - disableConfirmation: 是否跳过确认（可选，受策略限制）
 * - traceId           : 追踪 ID（必填）
 * - site              : 站点标识（必填）
 * 
 * 【新手示例 - 创建新文件】
 * const writePrepare: FsWritePrepareRequest = {
 *   path: "/root/work/flycode/src/new-file.ts",
 *   mode: "overwrite",
 *   content: "export const hello = 'world';",
 *   traceId: "req-006",
 *   site: "qwen"
 * };
 * 
 * 【安全说明】
 * 高风险写入（如覆盖现有文件）会返回 pendingConfirmationId，
 * 需要用户在桌面应用中点击"批准"后才能执行第二步 commit。
 */
export interface FsWritePrepareRequest {
  path: string;
  mode: WriteMode;
  content: string;
  expectedSha256?: string;
  disableConfirmation?: boolean;
  traceId: string;
  site: SiteId;
}

/**
 * 【FsWriteCommitRequest - 写入文件确认提交请求】
 * 
 * 作用："两步写入"的第二步，用户确认后执行实际写入。
 * 
 * 参数详解：
 * - opId            : 准备阶段返回的操作 ID（必填）
 * - confirmedByUser : 用户是否确认（必填，true=批准，false=拒绝）
 * - traceId         : 追踪 ID（必填）
 * - site            : 站点标识（必填）
 * 
 * 【新手示例】
 * // 第一步：准备写入
 * const prepareResult = await api.writePrepare(writePrepare);
 * 
 * // 第二步：用户确认后提交
 * const commitRequest: FsWriteCommitRequest = {
 *   opId: prepareResult.data.opId,    // 使用第一步返回的 opId
 *   confirmedByUser: true,            // 用户点击了"批准"
 *   traceId: "req-006",
 *   site: "qwen"
 * };
 * const finalResult = await api.writeCommit(commitRequest);
 */
export interface FsWriteCommitRequest {
  opId: string;
  confirmedByUser: boolean;
  traceId: string;
  site: SiteId;
}

/**
 * 【FsRmRequest - 删除文件/目录请求】
 * 
 * 作用：删除指定路径的文件或目录。
 * 
 * 参数详解：
 * - path      : 要删除的路径（必填）
 * - recursive : 是否递归删除目录（必填，删除目录时必须为 true）
 * - force     : 是否强制删除（不报错如果文件不存在）（可选）
 * - traceId   : 追踪 ID（必填）
 * - site      : 站点标识（必填）
 * 
 * 【新手示例 - 删除文件】
 * const rmFileRequest: FsRmRequest = {
 *   path: "/root/work/flycode/temp.txt",
 *   recursive: false,
 *   traceId: "req-007",
 *   site: "qwen"
 * };
 * 
 * 【新手示例 - 删除目录】
 * const rmDirRequest: FsRmRequest = {
 *   path: "/root/work/flycode/dist",
 *   recursive: true,           // 目录删除必须 recursive=true
 *   traceId: "req-008",
 *   site: "qwen"
 * };
 * 
 * 【安全说明】
 * - 不能删除 allowed_roots 中的根目录
 * - 受 policy.mutation.allow_rm 策略控制
 */
export interface FsRmRequest {
  path: string;
  recursive?: boolean;
  force?: boolean;
  traceId: string;
  site: SiteId;
}

/**
 * 【FsMvRequest - 移动/重命名文件请求】
 * 
 * 作用：将文件从一个位置移动到另一个位置（可跨文件系统）。
 * 
 * 参数详解：
 * - fromPath  : 源路径（必填）
 * - toPath    : 目标路径（必填）
 * - overwrite : 如果目标已存在是否覆盖（可选，默认 false）
 * - traceId   : 追踪 ID（必填）
 * - site      : 站点标识（必填）
 * 
 * 【新手示例 - 重命名文件】
 * const mvRequest: FsMvRequest = {
 *   fromPath: "/root/work/flycode/old-name.txt",
 *   toPath: "/root/work/flycode/new-name.txt",
 *   overwrite: false,          // 如果 new-name.txt 已存在则报错
 *   traceId: "req-009",
 *   site: "qwen"
 * };
 * 
 * 【安全说明】
 * - 不能移动 allowed_roots 中的根目录
 * - 受 policy.mutation.allow_mv 策略控制
 */
export interface FsMvRequest {
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
  traceId: string;
  site: SiteId;
}

/**
 * 【FsChmodRequest - 修改文件权限请求】
 * 
 * 作用：修改文件的读写执行权限（仅 Linux/Mac 支持）。
 * 
 * 参数详解：
 * - path    : 文件路径（必填）
 * - mode    : 权限模式，3-4 位八进制字符串，如 "755"（必填）
 * - traceId : 追踪 ID（必填）
 * - site    : 站点标识（必填）
 * 
 * 【新手示例】
 * const chmodRequest: FsChmodRequest = {
 *   path: "/root/work/flycode/scripts/deploy.sh",
 *   mode: "755",               // rwxr-xr-x（可执行）
 *   traceId: "req-010",
 *   site: "qwen"
 * };
 * 
 * 【权限说明】
 * 755 = 所有者读写执行 + 组用户读执行 + 其他用户读执行
 * 644 = 所有者读写 + 组用户读 + 其他用户读（文件默认）
 * 
 * 【注意】Windows 上调用会返回 NOT_SUPPORTED 错误
 */
export interface FsChmodRequest {
  path: string;
  mode: string;
  traceId: string;
  site: SiteId;
}

/**
 * 【WriteBatchFileInput - 批量写入的单个文件输入】
 * 
 * 作用：用于批量写入操作中定义单个文件的写入参数。
 * 
 * 【新手示例】
 * const fileInput: WriteBatchFileInput = {
 *   path: "/project/src/index.ts",
 *   mode: "overwrite",
 *   content: "console.log('hello');",
 *   expectedSha256: "abc123..."   // 可选，用于并发控制
 * };
 */
export interface WriteBatchFileInput {
  path: string;
  mode?: WriteMode;
  content: string;
  expectedSha256?: string;
}

/**
 * 【FsWriteBatchPrepareRequest - 批量写入准备请求】
 * 
 * 作用：一次性准备多个文件的写入操作，统一确认。
 * 
 * 参数详解：
 * - files             : 文件输入数组（必填）
 * - disableConfirmation: 是否跳过确认（可选）
 * - traceId           : 追踪 ID（必填）
 * - site              : 站点标识（必填）
 * 
 * 【新手示例 - 创建多个文件】
 * const batchPrepare: FsWriteBatchPrepareRequest = {
 *   files: [
 *     {
 *       path: "/project/index.html",
 *       mode: "overwrite",
 *       content: "<!doctype html><html>..."
 *     },
 *     {
 *       path: "/project/style.css",
 *       mode: "overwrite",
 *       content: "body { margin: 0; }"
 *     }
 *   ],
 *   traceId: "req-011",
 *   site: "qwen"
 * };
 */
export interface FsWriteBatchPrepareRequest {
  files: WriteBatchFileInput[];
  disableConfirmation?: boolean;
  traceId: string;
  site: SiteId;
}

/**
 * 【FsWriteBatchCommitRequest - 批量写入确认提交请求】
 * 
 * 作用：用户确认后执行批量写入。
 * 
 * 【新手示例】
 * const batchCommit: FsWriteBatchCommitRequest = {
 *   opId: prepareResult.data.opId,
 *   confirmedByUser: true,
 *   traceId: "req-011",
 *   site: "qwen"
 * };
 */
export interface FsWriteBatchCommitRequest {
  opId: string;
  confirmedByUser: boolean;
  traceId: string;
  site: SiteId;
}

/**
 * 【FsDiffRequest - 文件差异比较请求】
 * 
 * 作用：比较两个文件或一个文件与一段内容的差异，生成 unified diff。
 * 
 * 参数详解：
 * - leftPath     : 左侧文件路径（必填）
 * - rightPath    : 右侧文件路径（与 rightContent 二选一）
 * - rightContent : 右侧内容字符串（与 rightPath 二选一）
 * - contextLines : 差异上下文行数，默认 3（可选）
 * - traceId      : 追踪 ID（必填）
 * - site         : 站点标识（必填）
 * 
 * 【新手示例 - 比较两个文件】
 * const diffRequest: FsDiffRequest = {
 *   leftPath: "/project/src/old.ts",
 *   rightPath: "/project/src/new.ts",
 *   contextLines: 5,           // 显示更多上下文
 *   traceId: "req-012",
 *   site: "qwen"
 * };
 * 
 * 【新手示例 - 比较文件与内容】
 * const diffWithContent: FsDiffRequest = {
 *   leftPath: "/project/src/index.ts",
 *   rightContent: "export const updated = true;",
 *   traceId: "req-013",
 *   site: "qwen"
 * };
 */
export interface FsDiffRequest {
  leftPath: string;
  rightPath?: string;
  rightContent?: string;
  contextLines?: number;
  traceId: string;
  site: SiteId;
}

// =============================================================================
// 第三部分：进程执行请求类型
// =============================================================================

/**
 * 【ProcessRunRequest - 执行进程请求】
 * 
 * 作用：执行指定的命令（不经过 shell，更安全）。
 * 
 * 参数详解：
 * - command  : 命令名称，如 "npm"（必填）
 * - args     : 命令参数数组，如 ["install", "--save"]（可选）
 * - cwd      : 工作目录（可选，默认当前目录）
 * - timeoutMs: 超时时间毫秒（可选，受策略限制）
 * - env      : 环境变量（可选，受策略限制）
 * - traceId  : 追踪 ID（必填）
 * - site     : 站点标识（必填）
 * 
 * 【新手示例 - 运行 npm install】
 * const runRequest: ProcessRunRequest = {
 *   command: "npm",
 *   args: ["install"],
 *   cwd: "/root/work/flycode",
 *   timeoutMs: 60000,          // 60 秒超时
 *   traceId: "req-014",
 *   site: "qwen"
 * };
 * 
 * 【安全说明】
 * - 命令必须在 policy.process.allowed_commands 白名单中
 * - 默认允许：npm, node, git, rg, pnpm, yarn
 */
export interface ProcessRunRequest {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  traceId: string;
  site: SiteId;
}

/**
 * 【ShellExecRequest - Shell 命令执行请求】
 * 
 * 作用：通过 shell 执行命令（支持管道、重定向等 shell 特性）。
 * 
 * 参数详解：
 * - command  : 完整的 shell 命令字符串（必填）
 * - cwd      : 工作目录（可选）
 * - timeoutMs: 超时时间（可选）
 * - env      : 环境变量（可选）
 * - traceId  : 追踪 ID（必填）
 * - site     : 站点标识（必填）
 * 
 * 【新手示例 - 执行带管道的命令】
 * const shellRequest: ShellExecRequest = {
 *   command: "grep -r 'function' src/ | head -20",
 *   cwd: "/root/work/flycode",
 *   timeoutMs: 30000,
 *   traceId: "req-015",
 *   site: "qwen"
 * };
 * 
 * 【ProcessRun vs ShellExec】
 * - ProcessRun: 更安全，不支持管道，推荐优先使用
 * - ShellExec: 功能更强，但有注入风险，谨慎使用
 */
export interface ShellExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  traceId: string;
  site: SiteId;
}

// =============================================================================
// 第四部分：响应数据类型（Data）
// =============================================================================
// 说明：这些类型定义了"API 成功后返回什么数据"

/**
 * 【LsEntry - 目录条目】
 * 
 * 作用：表示 ls 操作返回的单个文件或目录信息。
 * 
 * 【新手示例】
 * const entry: LsEntry = {
 *   path: "/root/work/flycode/src/index.ts",
 *   type: "file",
 *   bytes: 1024
 * };
 */
export interface LsEntry {
  path: string;
  type: "file" | "directory";
  bytes?: number;  // 仅文件有大小
}

/**
 * 【LsData - 列出目录的返回数据】
 * 
 * 【新手示例】
 * const lsData: LsData = {
 *   entries: [
 *     { path: "/src", type: "directory" },
 *     { path: "/README.md", type: "file", bytes: 3481 }
 *   ]
 * };
 */
export interface LsData {
  entries: LsEntry[];
}

/**
 * 【ReadData - 读取文件的返回数据】
 * 
 * 字段说明：
 * - content : 文件内容（已脱敏和 Token 预算处理）
 * - mime    : MIME 类型，如 "text/typescript"
 * - bytes   : 文件原始大小
 * - sha256  : 文件内容哈希（用于验证完整性）
 * - meta    : 可选的元数据（大小、修改时间、创建时间、权限）
 * 
 * 【新手示例】
 * const readData: ReadData = {
 *   content: "export const hello = 'world';",
 *   mime: "text/typescript",
 *   bytes: 32,
 *   sha256: "abc123...",
 *   meta: {
 *     size: 32,
 *     mtime: "2026-02-23T10:00:00.000Z",
 *     ctime: "2026-02-23T09:00:00.000Z",
 *     mode: "0644"
 *   }
 * };
 */
export interface ReadData {
  content: string;
  mime: string;
  bytes: number;
  sha256: string;
  meta?: {
    size: number;
    mtime: string;
    ctime: string;
    mode: string;
  };
}

/**
 * 【SearchMatch - 搜索匹配项】
 * 
 * 作用：表示搜索操作找到的单个匹配结果。
 * 
 * 字段说明：
 * - path    : 匹配文件的路径
 * - line    : 匹配行号（从 1 开始）
 * - column  : 匹配列号（从 1 开始）
 * - text    : 匹配行的内容（已脱敏）
 * - before  : 匹配行之前的上下文（可选）
 * - after   : 匹配行之后的上下文（可选）
 * 
 * 【新手示例】
 * const match: SearchMatch = {
 *   path: "/src/utils.ts",
 *   line: 42,
 *   column: 10,
 *   text: "export function processData() {",
 *   before: [
 *     { line: 40, text: "// 工具函数" },
 *     { line: 41, text: "import { config } from './config';" }
 *   ],
 *   after: [
 *     { line: 43, text: "  // 处理逻辑" }
 *   ]
 * };
 */
export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  before?: Array<{ line: number; text: string }>;
  after?: Array<{ line: number; text: string }>;
}

/**
 * 【SearchData - 搜索操作的返回数据】
 * 
 * 【新手示例】
 * const searchData: SearchData = {
 *   matches: [match1, match2, ...],
 *   total: 150,              // 总共找到 150 个匹配
 *   truncated: false         // 是否被截断（超过 limit）
 * };
 */
export interface SearchData {
  matches: SearchMatch[];
  total: number;
  truncated: boolean;
}

/**
 * 【MkdirData - 创建目录的返回数据】
 * 
 * 【新手示例】
 * const mkdirData: MkdirData = {
 *   path: "/root/work/flycode/dist",
 *   created: true,           // true=新建，false=已存在
 *   parents: true            // 是否递归创建了父目录
 * };
 */
export interface MkdirData {
  path: string;
  created: boolean;
  parents: boolean;
}

/**
 * 【RmData - 删除操作的返回数据】
 * 
 * 【新手示例】
 * const rmData: RmData = {
 *   path: "/root/work/flycode/temp.txt",
 *   removed: true,
 *   type: "file",            // file | directory | missing
 *   recursive: false
 * };
 */
export interface RmData {
  path: string;
  removed: boolean;
  type: "file" | "directory" | "missing";
  recursive: boolean;
}

/**
 * 【MvData - 移动操作的返回数据】
 * 
 * 【新手示例】
 * const mvData: MvData = {
 *   fromPath: "/old/path.txt",
 *   toPath: "/new/path.txt",
 *   overwritten: false       // 是否覆盖了已存在的目标
 * };
 */
export interface MvData {
  fromPath: string;
  toPath: string;
  overwritten: boolean;
}

/**
 * 【ChmodData - 修改权限的返回数据】
 * 
 * 【新手示例】
 * const chmodData: ChmodData = {
 *   path: "/scripts/deploy.sh",
 *   mode: "0755"             // 返回标准化后的权限（4 位八进制）
 * };
 */
export interface ChmodData {
  path: string;
  mode: string;
}

/**
 * 【WritePrepareData - 写入准备的返回数据】
 * 
 * 作用：告知调用方是否需要用户确认。
 * 
 * 【新手示例】
 * const writePrepareData: WritePrepareData = {
 *   opId: "op-abc123",       // 用于第二步 commit 的 ID
 *   requireConfirmation: true, // 需要用户确认
 *   summary: "覆盖写入 /src/index.ts (1.2KB)" // 确认对话框显示的摘要
 * };
 */
export interface WritePrepareData {
  opId: string;
  requireConfirmation: boolean;
  summary: string;
}

/**
 * 【WriteData - 单次写入的返回数据】
 * 
 * 【新手示例】
 * const writeData: WriteData = {
 *   path: "/src/index.ts",
 *   writtenBytes: 1234,
 *   backupPath: "/src/index.ts.flycode.bak.1708675200000", // 备份路径
 *   newSha256: "def456..."   // 新文件哈希
 * };
 */
export interface WriteData {
  path: string;
  writtenBytes: number;
  backupPath?: string;
  newSha256: string;
}

/**
 * 【WriteBatchPrepareData - 批量写入准备的返回数据】
 * 
 * 【新手示例】
 * const batchPrepareData: WriteBatchPrepareData = {
 *   opId: "op-batch-001",
 *   requireConfirmation: true,
 *   summary: "批量写入 3 个文件 (共 5.6KB)",
 *   totalFiles: 3,
 *   totalBytes: 5632
 * };
 */
export interface WriteBatchPrepareData {
  opId: string;
  requireConfirmation: boolean;
  summary: string;
  totalFiles: number;
  totalBytes: number;
}

/**
 * 【WriteBatchFileData - 批量写入中单个文件的返回数据】
 * 
 * 【新手示例】
 * const fileData: WriteBatchFileData = {
 *   path: "/src/index.ts",
 *   mode: "overwrite",
 *   writtenBytes: 1024,
 *   backupPath: "/src/index.ts.flycode.bak.1708675200000",
 *   newSha256: "abc123..."
 * };
 */
export interface WriteBatchFileData {
  path: string;
  mode: WriteMode;
  writtenBytes: number;
  backupPath?: string;
  newSha256: string;
}

/**
 * 【WriteBatchData - 批量写入的返回数据】
 * 
 * 【新手示例】
 * const batchData: WriteBatchData = {
 *   files: [fileData1, fileData2, ...],
 *   rolledBack: false,       // 是否回滚（某文件失败时）
 *   failedAtIndex: -1,       // 失败的文件索引（-1 表示全部成功）
 *   rollbackErrors: []       // 回滚时的错误信息
 * };
 */
export interface WriteBatchData {
  files: WriteBatchFileData[];
  rolledBack?: boolean;
  failedAtIndex?: number;
  rollbackErrors?: string[];
}

/**
 * 【DiffData - 差异比较的返回数据】
 * 
 * 【新手示例】
 * const diffData: DiffData = {
 *   leftPath: "/src/old.ts",
 *   rightPath: "/src/new.ts",
 *   changed: true,
 *   unifiedDiff: `@@ -1,5 +1,6 @@
 *  import { config } from './config';
 * +import { utils } from './utils';
 *   
 *   export function main() {
 *     // ...
 *   `
 * };
 */
export interface DiffData {
  leftPath: string;
  rightPath?: string;
  changed: boolean;
  unifiedDiff: string;
}

/**
 * 【ProcessRunData - 进程执行的返回数据】
 * 
 * 【新手示例】
 * const runData: ProcessRunData = {
 *   command: "npm",
 *   cwd: "/root/work/flycode",
 *   exitCode: 0,             // 0 表示成功
 *   stdout: "added 123 packages...",
 *   stderr: "",
 *   durationMs: 5432,
 *   timedOut: false,
 *   truncated: false         // 输出是否被截断
 * };
 */
export interface ProcessRunData {
  command: string;
  cwd: string;
  exitCode: number | null;   // null 表示进程未正常退出
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

// =============================================================================
// 第五部分：认证与配对类型
// =============================================================================

/**
 * 【PairVerifyRequest - 配对验证请求】
 * 
 * 作用：浏览器扩展通过配对码获取访问 Token。
 * 
 * 【新手示例】
 * const pairRequest: PairVerifyRequest = {
 *   pairCode: "FLYCODE-123456"  // 用户在桌面应用看到的 6 位配对码
 * };
 */
export interface PairVerifyRequest {
  pairCode: string;
}

/**
 * 【PairVerifyResponse - 配对验证响应】
 * 
 * 【新手示例】
 * const pairResponse: PairVerifyResponse = {
 *   token: "eyJhbGciOiJIUzI1NiIs...",  // JWT Token
 *   expiresAt: "2026-03-23T10:00:00.000Z" // Token 过期时间
 * };
 */
export interface PairVerifyResponse {
  token: string;
  expiresAt: string;
}

// =============================================================================
// 第六部分：MCP 协议类型（Model Context Protocol）
// =============================================================================
// 说明：FlyCode V2 使用 MCP 协议与 AI 对话，这些类型定义了 MCP 消息格式

/**
 * 【McpJsonRpcId - MCP JSON-RPC 消息 ID】
 * 
 * 作用：关联请求和响应的唯一标识。
 * 
 * 【新手示例】
 * const requestId: McpJsonRpcId = "call-001";  // 字符串 ID
 * const requestId2: McpJsonRpcId = 1;           // 数字 ID 也可以
 */
export type McpJsonRpcId = string | number;

/**
 * 【McpRequestEnvelope - MCP 请求信封】
 * 
 * 作用：封装所有 MCP 请求的标准格式（JSON-RPC 2.0）。
 * 
 * 字段说明：
 * - jsonrpc : 固定为 "2.0"
 * - id      : 请求 ID，响应时会原样返回
 * - method  : 方法名（initialize | tools/list | tools/call）
 * - params  : 方法参数（可选）
 * 
 * 【新手示例 - 调用工具】
 * const mcpRequest: McpRequestEnvelope = {
 *   jsonrpc: "2.0",
 *   id: "call-001",
 *   method: "tools/call",
 *   params: {
 *     name: "fs.read",
 *     arguments: {
 *       path: "/root/work/flycode/README.md"
 *     }
 *   }
 * };
 */
export interface McpRequestEnvelope<TParams = unknown> {
  jsonrpc: "2.0";
  id: McpJsonRpcId;
  method: "initialize" | "tools/list" | "tools/call";
  params?: TParams;
}

/**
 * 【McpError - MCP 错误对象】
 * 
 * 【新手示例】
 * const mcpError: McpError = {
 *   code: -32004,
 *   message: "File not found: /path/to/file",
 *   data: {
 *     appCode: "NOT_FOUND",
 *     statusCode: 404
 *   }
 * };
 */
export interface McpError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * 【McpResponseEnvelope - MCP 响应信封】
 * 
 * 作用：封装所有 MCP 响应的标准格式。
 * 
 * 【新手示例 - 成功响应】
 * const successResponse: McpResponseEnvelope = {
 *   jsonrpc: "2.0",
 *   id: "call-001",
 *   result: {
 *     content: [{ type: "text", text: "文件内容..." }]
 *   }
 * };
 * 
 * 【新手示例 - 错误响应】
 * const errorResponse: McpResponseEnvelope = {
 *   jsonrpc: "2.0",
 *   id: "call-001",
 *   error: {
 *     code: -32004,
 *     message: "File not found"
 *   }
 * };
 */
export interface McpResponseEnvelope<TResult = unknown> {
  jsonrpc: "2.0";
  id: McpJsonRpcId | null;
  result?: TResult;
  error?: McpError;
}

/**
 * 【McpToolDescriptor - MCP 工具描述符】
 * 
 * 作用：描述一个工具的名称、说明和输入参数格式。
 * 
 * 【新手示例】
 * const toolDesc: McpToolDescriptor = {
 *   name: "fs.read",
 *   description: "读取文件内容",
 *   inputSchema: {
 *     type: "object",
 *     properties: {
 *       path: { type: "string", description: "文件路径" }
 *     },
 *     required: ["path"]
 *   }
 * };
 */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/**
 * 【McpInitializeParams - MCP 初始化参数】
 * 
 * 【新手示例】
 * const initParams: McpInitializeParams = {
 *   protocolVersion: "2024-11-05",
 *   clientInfo: {
 *     name: "flycode-extension",
 *     version: "0.1.0"
 *   }
 * };
 */
export interface McpInitializeParams {
  protocolVersion?: string;
  clientInfo?: {
    name: string;
    version: string;
  };
}

/**
 * 【McpInitializeResult - MCP 初始化结果】
 * 
 * 【新手示例】
 * const initResult: McpInitializeResult = {
 *   protocolVersion: "2024-11-05",
 *   serverInfo: {
 *     name: "flycode-local-service",
 *     version: "0.1.0"
 *   },
 *   capabilities: {
 *     tools: {
 *       listChanged: true    // 支持工具列表变更通知
 *     }
 *   }
 * };
 */
export interface McpInitializeResult {
  protocolVersion: "2024-11-05";
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: {
    tools: {
      listChanged: boolean;
    };
  };
}

/**
 * 【McpToolCallParams - MCP 工具调用参数】
 * 
 * 【新手示例】
 * const toolParams: McpToolCallParams = {
 *   name: "fs.read",
 *   arguments: {
 *     path: "/root/work/flycode/README.md"
 *   }
 * };
 */
export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
  confirmationId?: string;   // 确认中心的确认 ID
}

/**
 * 【McpToolCallContentItem - MCP 工具调用的内容项】
 * 
 * 【新手示例】
 * const contentItem: McpToolCallContentItem = {
 *   type: "text",
 *   text: "这是工具返回的内容"
 * };
 */
export interface McpToolCallContentItem {
  type: "text";
  text: string;
}

/**
 * 【McpToolCallResult - MCP 工具调用结果】
 * 
 * 作用：工具执行后的标准返回格式。
 * 
 * 【新手示例】
 * const toolResult: McpToolCallResult = {
 *   content: [
 *     { type: "text", text: "文件内容..." }
 *   ],
 *   isError: false,
 *   meta: {
 *     auditId: "audit-001",
 *     truncated: false,
 *     pendingConfirmationId: "confirm-001"  // 如果需要确认
 *   }
 * };
 */
export interface McpToolCallResult {
  content: McpToolCallContentItem[];
  isError?: boolean;
  meta?: {
    auditId?: string;
    truncated?: boolean;
    pendingConfirmationId?: string;
  };
}

// =============================================================================
// 第七部分：站点密钥与确认中心类型
// =============================================================================

/**
 * 【SiteKeyRecord - 站点密钥记录】
 * 
 * 作用：存储每个 AI 站点的访问密钥信息。
 * 
 * 【新手示例】
 * const keyRecord: SiteKeyRecord = {
 *   site: "qwen",
 *   key: "sk-abc123...",
 *   createdAt: "2026-02-01T00:00:00.000Z",
 *   rotatedAt: "2026-02-01T00:00:00.000Z"
 * };
 */
export interface SiteKeyRecord {
  site: Exclude<SiteId, "unknown">;
  key: string;
  createdAt: string;
  rotatedAt: string;
}

/**
 * 【SiteKeysResponse - 站点密钥响应】
 * 
 * 【新手示例】
 * const keysResponse: SiteKeysResponse = {
 *   createdAt: "2026-02-01T00:00:00.000Z",
 *   rotatedAt: "2026-02-01T00:00:00.000Z",
 *   sites: {
 *     qwen: { site: "qwen", key: "sk-...", ... },
 *     deepseek: { site: "deepseek", key: "sk-...", ... }
 *   }
 * };
 */
export interface SiteKeysResponse {
  createdAt: string;
  rotatedAt: string;
  sites: Partial<Record<Exclude<SiteId, "unknown">, SiteKeyRecord>>;
}

/**
 * 【ConfirmationStatus - 确认状态枚举】
 * 
 * - "pending"   : 等待用户确认
 * - "approved"  : 用户已批准
 * - "rejected"  : 用户已拒绝
 * - "timeout"   : 确认超时（默认 10 分钟）
 */
export type ConfirmationStatus = "pending" | "approved" | "rejected" | "timeout";

/**
 * 【ConfirmationEntry - 确认条目】
 * 
 * 作用：确认中心中待处理或已处理的确认请求记录。
 * 
 * 【新手示例】
 * const confirmEntry: ConfirmationEntry = {
 *   id: "confirm-001",
 *   site: "qwen",
 *   tool: "fs.write",
 *   summary: "覆盖写入 /src/index.ts (1.2KB)",
 *   status: "pending",
 *   createdAt: "2026-02-23T10:00:00.000Z",
 *   expiresAt: "2026-02-23T10:10:00.000Z",
 *   resolvedAt: undefined    // 尚未解决
 * };
 */
export interface ConfirmationEntry {
  id: string;
  site: Exclude<SiteId, "unknown">;
  tool: string;
  summary: string;
  status: ConfirmationStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

/**
 * 【ConfirmationDecisionRequest - 确认决策请求】
 * 
 * 作用：用户批准或拒绝确认请求时发送的数据。
 * 
 * 【新手示例】
 * const decisionRequest: ConfirmationDecisionRequest = {
 *   approved: true,          // 批准
 *   alwaysAllow: false       // 不记住选择（下次还要确认）
 * };
 */
export interface ConfirmationDecisionRequest {
  approved: boolean;
  alwaysAllow?: boolean;
}

// =============================================================================
// 第八部分：控制台日志类型
// =============================================================================

/**
 * 【ConsoleQueryRequest - 控制台日志查询请求】
 * 
 * 作用：查询历史操作日志，用于调试和审计。
 * 
 * 【新手示例 - 查询所有失败的操作】
 * const queryRequest: ConsoleQueryRequest = {
 *   status: "failed",
 *   limit: 50
 * };
 * 
 * 【新手示例 - 查询特定站点的操作】
 * const queryBySite: ConsoleQueryRequest = {
 *   site: "qwen",
 *   from: "2026-02-23T00:00:00.000Z",
 *   to: "2026-02-23T23:59:59.999Z",
 *   limit: 100
 * };
 */
export interface ConsoleQueryRequest {
  site?: SiteId | "all";
  status?: "success" | "failed" | "pending" | "all";
  tool?: string;
  keyword?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * 【ConsoleEventEntry - 控制台事件条目】
 * 
 * 作用：单条操作日志记录。
 * 
 * 【新手示例】
 * const eventEntry: ConsoleEventEntry = {
 *   id: "event-001",
 *   timestamp: "2026-02-23T10:00:00.000Z",
 *   site: "qwen",
 *   method: "tools/call",
 *   tool: "fs.read",
 *   status: "success",
 *   durationMs: 123,
 *   truncated: false,
 *   request: { path: "/README.md" },
 *   response: { content: "..." }
 * };
 */
export interface ConsoleEventEntry {
  id: string;
  timestamp: string;
  site: SiteId;
  method: string;
  tool?: string;
  status: "success" | "failed" | "pending";
  durationMs?: number;
  truncated?: boolean;
  request?: unknown;
  response?: unknown;
}

// =============================================================================
// 文件结束
// =============================================================================
// 
// 【新手学习建议】
// 1. 先理解 Request 和 Data 的对应关系（如 FsReadRequest → ReadData）
// 2. 注意每个请求都包含 traceId 和 site，用于审计追踪
// 3. 写入操作是"两步走"：prepare → commit，确保安全
// 4. MCP 协议类型用于与 AI 对话，其他类型用于内部通信
// 
// 【下一步学习】
// 建议继续阅读：
// - packages/local-service/src/config/policy.ts（策略配置）
// - packages/local-service/src/services/file-service.ts（文件服务实现）
// - packages/local-service/src/security/auth.ts（认证机制）
// =============================================================================
