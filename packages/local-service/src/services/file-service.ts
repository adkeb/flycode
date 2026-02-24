/**
 * =============================================================================
 * FlyCode V2 - 核心文件服务
 * =============================================================================
 * 
 * 【文件作用】
 * 这是 FlyCode 的"文件操作引擎"，实现了所有文件相关的核心功能：
 * - ls: 列出目录内容
 * - mkdir: 创建目录
 * - read: 读取文件内容
 * - search: 搜索文件内容
 * - write (commitWrite): 写入文件（两步写入的第二步）
 * - rm: 删除文件/目录
 * - mv: 移动/重命名文件
 * - chmod: 修改文件权限
 * - diff: 比较文件差异
 * 
 * 【安全机制】
 * 每个操作都经过三层安全检查：
 * 1. 策略检查：policy.mutation.allow_* 是否允许该操作
 * 2. 路径检查：pathPolicy.assertAllowed() 验证路径在白名单内
 * 3. 根目录保护：assertNotRootTarget() 防止删除/移动根目录
 * 
 * 【数据处理流程】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 1. 接收请求参数                                          │
 * │ 2. 路径标准化 (normalizeInputPath)                       │
 * │ 3. 路径白名单检查 (assertAllowed)                        │
 * │ 4. 执行文件操作 (fs.* API)                               │
 * │ 5. 敏感信息脱敏 (redactor.redact)                        │
 * │ 6. Token 预算控制 (applyTokenBudget)                      │
 * │ 7. 返回结果                                              │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手学习重点】
 * - 依赖注入模式：构造函数接收 policy/pathPolicy/redactor
 * - 统一错误处理：所有错误都抛出 AppError
 * - 安全优先：每个操作都有多层检查
 * - 工具函数分离：私有方法 + 独立函数保持代码清晰
 * 
 * @moduleflycode/local-service/services/file-service
 * @core-service
 */

// =============================================================================
// 第一部分：导入依赖
// =============================================================================

/**
 * 【Node.js 原生模块】
 * - fs/promises: 异步文件操作 API
 * - path: 路径处理（跨平台兼容）
 */
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 【第三方库】
 * - mime-types: 根据文件扩展名判断 MIME 类型
 * - minimatch: glob 模式匹配（如 "*.ts" 匹配所有 TypeScript 文件）
 * - pdf-parse: PDF 文件解析（读取 PDF 中的文本内容）
 */
import mime from "mime-types";
import { minimatch } from "minimatch";
import pdfParse from "pdf-parse";

/**
 * 【共享类型】
 * - ReadEncoding: 读取编码方式 ("utf-8" | "base64" | "hex")
 * - WriteMode: 写入模式 ("overwrite" | "append")
 */
import type { ReadEncoding, WriteMode } from "@flycode/shared-types";

/**
 * 【内部类型和接口】
 * - FileService: 本类实现的接口
 * - PathPolicy: 路径策略检查器
 * - PendingWriteOp: 待确认的写入操作
 * - PolicyConfig: 策略配置
 * - Redactor: 敏感信息脱敏器
 */
import type { FileService, PathPolicy, PendingWriteOp, PolicyConfig, Redactor } from "../types.js";

/**
 * 【工具模块】
 * - AppError: 统一错误类
 * - sha256: 哈希计算函数
 * - applyTokenBudget: Token 预算控制
 */
import { AppError } from "../utils/errors.js";
import { sha256 } from "../utils/hash.js";
import { applyTokenBudget } from "./token-budget.js";

// =============================================================================
// 第二部分：内部类型定义
// =============================================================================

/**
 * 【LsInternalResult - 列出目录的内部结果】
 * 
 * 作用：ls() 方法的返回类型
 * 
 * 【新手示例】
 * {
 *   entries: [
 *     { path: "/src", type: "directory" },
 *     { path: "/README.md", type: "file", bytes: 3481 }
 *   ],
 *   truncated: false
 * }
 */
interface LsInternalResult {
  entries: Array<{ path: string; type: "file" | "directory"; bytes?: number }>;
  truncated: boolean;
}

/**
 * 【ReadInternalResult - 读取文件的内部结果】
 * 
 * 作用：read() 方法的返回类型
 * 
 * 【新手示例】
 * {
 *   content: "export const hello = 'world';",
 *   mime: "text/typescript",
 *   bytes: 32,
 *   sha256: "abc123...",
 *   truncated: false,
 *   meta: {
 *     size: 32,
 *     mtime: "2026-02-23T10:00:00.000Z",
 *     ctime: "2026-02-23T09:00:00.000Z",
 *     mode: "0644"
 *   }
 * }
 */
interface ReadInternalResult {
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
}

/**
 * 【DiffOp - 差异比较操作】
 * 
 * 作用：表示 diff 算法中的单个操作（相等/添加/删除）
 * 
 * 【新手示例】
 * { kind: "equal", line: "import { config } from './config';", aLine: 1, bLine: 1 }
 * { kind: "add", line: "import { utils } from './utils';", aLine: 1, bLine: 2 }
 * { kind: "remove", line: "const x = 1;", aLine: 5, bLine: 5 }
 */
interface DiffOp {
  kind: "equal" | "add" | "remove";
  line: string;
  aLine: number;  // 左侧文件行号
  bLine: number;  // 右侧文件行号
}

// =============================================================================
// 第三部分：DefaultFileService 类
// =============================================================================

/**
 * 【DefaultFileService - 默认文件服务实现】
 * 
 * 作用：实现 FileService 接口，提供所有文件操作功能
 * 
 * 【设计模式】
 * - 依赖注入：通过构造函数接收外部依赖
 * - 单一职责：只负责文件操作，不处理认证、路由等
 * - 防御式编程：所有输入都验证，所有操作都检查权限
 * 
 * 【依赖说明】
 * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
 * │ 依赖              │ 作用                                    │ 来源         │
 * ├──────────────────┼────────────────────────────────────────┼─────────────┤
 * │ policy           │ 策略配置（限制、开关等）                │ config/policy │
 * │ pathPolicy       │ 路径白名单检查器                        │ services/path-policy │
 * │ redactor         │ 敏感信息脱敏器                          │ services/redactor │
 * └──────────────────┴────────────────────────────────────────┴─────────────┘
 * 
 * 【新手示例 - 实例化】
 * const fileService = new DefaultFileService(
 *   policyConfig,      // 从 loadPolicyConfig() 获取
 *   pathPolicy,        // 从 PathPolicy 类实例化
 *   redactor           // 从 Redactor 类实例化
 * );
 * 
 * // 使用
 * const result = await fileService.ls("/root/work/flycode", 2, undefined);
 */
export class DefaultFileService implements FileService {
  /**
   * 【构造函数】
   * 
   * 作用：初始化文件服务，注入必要依赖
   * 
   * 【private readonly 修饰符】
   * - private: 外部不能直接访问，只能通过本类方法使用
   * - readonly: 初始化后不能修改，确保依赖不可变
   * 
   * 【为什么用依赖注入？】
   * 1. 可测试性：测试时可以传入 mock 对象
   * 2. 灵活性：可以替换不同的实现（如不同的 Redactor）
   * 3. 清晰性：依赖关系一目了然
   */
  constructor(
    private readonly policy: PolicyConfig,
    private readonly pathPolicy: PathPolicy,
    private readonly redactor: Redactor
  ) {}

  // ===========================================================================
  // 方法 1: ls - 列出目录内容
  // ===========================================================================

  /**
   * 【ls - 列出目录内容】
   * 
   * 作用：递归列出指定目录下的文件和子目录
   * 
   * 参数详解：
   * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
   * │ 参数名            │ 说明                                    │ 示例         │
   * ├──────────────────┼────────────────────────────────────────┼─────────────┤
   * │ inputPath        │ 要列出的目录路径                        │ "/root/work" │
   * │ depth            │ 递归深度（默认 2）                      │ 2            │
   * │ glob             │ 文件名匹配模式                          │ "*.ts"       │
   * └──────────────────┴────────────────────────────────────────┴─────────────┘
   * 
   * 【新手示例 - 列出目录】
   * const result = await fileService.ls("/root/work/flycode", 2, undefined);
   * console.log(result.entries);
   * // [
   * //   { path: "/root/work/flycode/src", type: "directory" },
   * //   { path: "/root/work/flycode/README.md", type: "file", bytes: 3481 }
   * // ]
   * 
   * 【新手示例 - 带 glob 过滤】
   * const tsFiles = await fileService.ls("/root/work/flycode", 3, "*.ts");
   * // 只返回 .ts 文件
   * 
   * 【安全检查流程】
   * 1. normalizeInputPath(): 将输入路径标准化为绝对路径
   * 2. assertAllowed(): 检查路径是否在 allowed_roots 内
   * 3. walkDir(): 递归遍历时再次检查每个文件的路径
   * 
   * 【性能优化】
   * - depth 限制递归深度，防止 node_modules 等深目录爆炸
   * - glob 过滤减少不必要的文件统计
   * - 结果按路径排序，便于阅读
   */
  async ls(inputPath: string, depth: number | undefined, glob: string | undefined): Promise<LsInternalResult> {
    // ── 步骤 1: 路径标准化和白名单检查 ──
    // 将相对路径转为绝对路径，并检查是否在 allowed_roots 内
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    // ── 步骤 2: 检查路径是否存在 ──
    // safeStat 是封装的 stat 函数，文件不存在时返回 null 而不是抛异常
    const stat = await safeStat(target);
    if (!stat) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Path not found: ${target}`
      });
    }

    // ── 步骤 3: 处理单个文件的情况 ──
    // 如果输入是文件而不是目录，直接返回该文件信息
    if (stat.isFile()) {
      return {
        entries: [{ path: target, type: "file", bytes: stat.size }],
        truncated: false
      };
    }

    // ── 步骤 4: 递归遍历目录 ──
    // depth ?? 2 表示如果 depth 为 undefined 则使用默认值 2
    const maxDepth = Math.max(0, depth ?? 2);
    const entries: Array<{ path: string; type: "file" | "directory"; bytes?: number }> = [];
    
    // walkDir 是递归函数，遍历目录树并收集条目
    await walkDir({
      root: target,
      current: target,
      depth: 0,
      maxDepth,
      includePattern: glob,
      onEntry: (entry) => entries.push(entry)
    });

    // ── 步骤 5: 过滤和排序 ──
    // 再次检查每个条目是否在允许的路径内（防御性编程）
    const filtered = entries.filter((entry) => isAllowedPath(this.pathPolicy, entry.path));
    
    // 按路径字母顺序排序，便于阅读和比较
    filtered.sort((a, b) => a.path.localeCompare(b.path));
    
    return { entries: filtered, truncated: false };
  }

  // ===========================================================================
  // 方法 2: mkdir - 创建目录
  // ===========================================================================

  /**
   * 【mkdir - 创建目录】
   * 
   * 作用：创建新目录，支持递归创建父目录
   * 
   * 【新手示例 - 创建单层目录】
   * const result = await fileService.mkdir("/root/work/flycode/dist", false);
   * // { path: "/root/work/flycode/dist", created: true, parents: false }
   * 
   * 【新手示例 - 递归创建目录】
   * const result = await fileService.mkdir("/root/work/flycode/dist/assets/images", true);
   * // 如果 dist 或 assets 不存在，会一并创建
   * // { path: "...", created: true, parents: true }
   * 
   * 【安全检查】
   * 1. 路径必须在 allowed_roots 内
   * 2. 父目录也必须检查（防止通过父目录逃逸）
   * 3. 不能覆盖已存在的文件
   */
  async mkdir(inputPath: string, parents: boolean | undefined): Promise<{ path: string; created: boolean; parents: boolean }> {
    // ── 步骤 1: 路径标准化和检查 ──
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    // ── 步骤 2: 检查是否已存在 ──
    const existing = await safeStat(target);
    if (existing) {
      // 如果已存在且是目录，直接返回（不报错）
      if (!existing.isDirectory()) {
        // 如果已存在但不是目录（是文件），报错
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `Path already exists and is not a directory: ${target}`
        });
      }

      return {
        path: target,
        created: false,  // 未创建（已存在）
        parents: parents === true
      };
    }

    // ── 步骤 3: 检查父目录 ──
    const recursive = parents === true;
    const parentDir = path.dirname(target);
    this.pathPolicy.assertAllowed(parentDir);  // 父目录也必须在白名单内

    if (!recursive) {
      // 非递归模式下，父目录必须存在
      const parentStat = await safeStat(parentDir);
      if (!parentStat?.isDirectory()) {
        throw new AppError({
          statusCode: 404,
          code: "NOT_FOUND",
          message: `Parent directory does not exist: ${parentDir}`
        });
      }
    }

    // ── 步骤 4: 创建目录 ──
    // recursive: true 时类似 mkdir -p，会自动创建不存在的父目录
    await fs.mkdir(target, { recursive });

    // ── 步骤 5: 验证创建成功 ──
    const created = await safeStat(target);
    if (!created?.isDirectory()) {
      throw new AppError({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: `Failed to create directory: ${target}`
      });
    }

    return {
      path: target,
      created: true,
      parents: recursive
    };
  }

  // ===========================================================================
  // 方法 3: rm - 删除文件/目录
  // ===========================================================================

  /**
   * 【rm - 删除文件/目录】
   * 
   * 作用：删除指定路径的文件或目录
   * 
   * 【新手示例 - 删除文件】
   * const result = await fileService.rm("/root/work/flycode/temp.txt", {
   *   recursive: false,
   *   force: false
   * });
   * // { path: "...", removed: true, type: "file", recursive: false }
   * 
   * 【新手示例 - 删除目录】
   * const result = await fileService.rm("/root/work/flycode/dist", {
   *   recursive: true,   // 目录删除必须 recursive=true
   *   force: false
   * });
   * 
   * 【新手示例 - 强制删除（不报错如果不存在）】
   * const result = await fileService.rm("/root/work/flycode/not-exists.txt", {
   *   recursive: false,
   *   force: true
   * });
   * // { path: "...", removed: false, type: "missing", recursive: false }
   * 
   * 【安全检查】
   * 1. policy.mutation.allow_rm 必须为 true
   * 2. 路径必须在 allowed_roots 内
   * 3. 不能删除 allowed_roots 中的根目录（防止误删整个项目）
   * 4. 删除目录必须 explicit 设置 recursive=true（防止误操作）
   */
  async rm(
    inputPath: string,
    options: { recursive?: boolean; force?: boolean }
  ): Promise<{ path: string; removed: boolean; type: "file" | "directory" | "missing"; recursive: boolean }> {
    // ── 步骤 1: 检查策略是否允许删除 ──
    this.assertMutationAllowed("allow_rm", "fs.rm is disabled by policy");

    // ── 步骤 2: 路径标准化和检查 ──
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);
    
    // ── 步骤 3: 根目录保护 ──
    // 防止删除 allowed_roots 中配置的根目录
    this.assertNotRootTarget(target, "Cannot delete a root path in allowed_roots");

    // ── 步骤 4: 解析选项 ──
    const recursive = options.recursive === true;
    const force = options.force === true;
    const stat = await safeStat(target);

    // ── 步骤 5: 处理文件不存在的情况 ──
    if (!stat) {
      if (force) {
        // force=true 时，文件不存在也不报错
        return {
          path: target,
          removed: false,
          type: "missing",
          recursive
        };
      }

      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Path not found: ${target}`
      });
    }

    // ── 步骤 6: 检查目录删除是否设置 recursive ──
    if (stat.isDirectory() && !recursive) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Directory deletion requires recursive=true"
      });
    }

    // ── 步骤 7: 执行删除 ──
    // recursive: stat.isDirectory() 表示只有目录才递归删除
    await fs.rm(target, { recursive: stat.isDirectory(), force });
    
    return {
      path: target,
      removed: true,
      type: stat.isDirectory() ? "directory" : "file",
      recursive
    };
  }

  // ===========================================================================
  // 方法 4: mv - 移动/重命名文件
  // ===========================================================================

  /**
   * 【mv - 移动/重命名文件】
   * 
   * 作用：将文件从一个位置移动到另一个位置
   * 
   * 【新手示例 - 重命名文件】
   * const result = await fileService.mv(
   *   "/root/work/flycode/old.txt",
   *   "/root/work/flycode/new.txt",
   *   false  // 如果 new.txt 已存在则报错
   * );
   * 
   * 【新手示例 - 移动并覆盖】
   * const result = await fileService.mv(
   *   "/root/work/flycode/src/old.ts",
   *   "/root/work/flycode/src/new.ts",
   *   true  // 如果 new.ts 已存在则覆盖
   * );
   * 
   * 【跨文件系统移动】
   * 如果源和目标在不同文件系统上，fs.rename 会失败 (EXDEV 错误)
   * 此时代码会自动降级为 copy + delete 模式
   * 
   * 【安全检查】
   * 1. policy.mutation.allow_mv 必须为 true
   * 2. 源路径和目标路径都必须在 allowed_roots 内
   * 3. 不能移动 allowed_roots 中的根目录
   * 4. 默认不允许覆盖已存在的目标文件
   */
  async mv(
    fromPath: string,
    toPath: string,
    overwrite: boolean | undefined
  ): Promise<{ fromPath: string; toPath: string; overwritten: boolean }> {
    // ── 步骤 1: 检查策略是否允许移动 ──
    this.assertMutationAllowed("allow_mv", "fs.mv is disabled by policy");

    // ── 步骤 2: 路径标准化和检查 ──
    const from = this.pathPolicy.normalizeInputPath(fromPath);
    const to = this.pathPolicy.normalizeInputPath(toPath);
    this.pathPolicy.assertAllowed(from);
    this.pathPolicy.assertAllowed(to);
    this.assertNotRootTarget(from, "Cannot move a root path in allowed_roots");

    // ── 步骤 3: 检查源文件是否存在 ──
    const sourceStat = await safeStat(from);
    if (!sourceStat) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Source path not found: ${from}`
      });
    }

    // ── 步骤 4: 处理目标已存在的情况 ──
    const destinationStat = await safeStat(to);
    let overwritten = false;

    if (destinationStat) {
      if (overwrite !== true) {
        // 默认不允许覆盖
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `Destination already exists: ${to}`
        });
      }

      if (destinationStat.isDirectory()) {
        // 不支持覆盖目录
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `Overwrite for directory destination is not supported: ${to}`
        });
      }

      // 删除已存在的目标文件
      await fs.rm(to, { force: true });
      overwritten = true;
    }

    // ── 步骤 5: 确保目标父目录存在 ──
    await fs.mkdir(path.dirname(to), { recursive: true });

    // ── 步骤 6: 执行移动 ──
    try {
      // 首选：使用 rename（原子操作，同文件系统内）
      await fs.rename(from, to);
    } catch (error: unknown) {
      // 如果失败且错误是 EXDEV（跨文件系统）
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
        throw error;  // 其他错误直接抛出
      }

      // 降级方案：copy + delete
      if (sourceStat.isDirectory()) {
        // 目录：递归复制后删除源目录
        await fs.cp(from, to, { recursive: true });
        await fs.rm(from, { recursive: true, force: true });
      } else {
        // 文件：复制后删除源文件
        await fs.copyFile(from, to);
        await fs.rm(from, { force: true });
      }
    }

    return {
      fromPath: from,
      toPath: to,
      overwritten
    };
  }

  // ===========================================================================
  // 方法 5: chmod - 修改文件权限
  // ===========================================================================

  /**
   * 【chmod - 修改文件权限】
   * 
   * 作用：修改文件的读写执行权限（仅 Linux/Mac 支持）
   * 
   * 【新手示例 - 设置可执行权限】
   * const result = await fileService.chmod("/root/work/flycode/scripts/deploy.sh", "755");
   * // { path: "...", mode: "0755" }
   * 
   * 【权限说明】
   * 755 = rwxr-xr-x (所有者读写执行 + 组用户读执行 + 其他用户读执行)
   * 644 = rw-r--r-- (所有者读写 + 组用户读 + 其他用户读)
   * 600 = rw------- (仅所有者读写)
   * 
   * 【注意】
   * Windows 上调用会返回 501 NOT_SUPPORTED 错误
   */
  async chmod(inputPath: string, mode: string): Promise<{ path: string; mode: string }> {
    // ── 步骤 1: 检查策略是否允许 chmod ──
    this.assertMutationAllowed("allow_chmod", "fs.chmod is disabled by policy");

    // ── 步骤 2: Windows 不支持 ──
    if (process.platform === "win32") {
      throw new AppError({
        statusCode: 501,
        code: "NOT_SUPPORTED",
        message: "fs.chmod is not supported on Windows runtime"
      });
    }

    // ── 步骤 3: 验证 mode 格式 ──
    // 必须是 3-4 位八进制数字（如 "755" 或 "0755"）
    if (!/^[0-7]{3,4}$/.test(mode)) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: `Invalid chmod mode: ${mode}`
      });
    }

    // ── 步骤 4: 路径标准化和检查 ──
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    const stat = await safeStat(target);
    if (!stat) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Path not found: ${target}`
      });
    }

    // ── 步骤 5: 执行 chmod ──
    // parseInt(mode, 8) 将八进制字符串转为数字
    const modeValue = parseInt(mode, 8);
    await fs.chmod(target, modeValue);

    return {
      path: target,
      // 返回标准化后的权限格式（4 位八进制，如 "0755"）
      mode: mode.length === 3 ? `0${mode}` : mode
    };
  }

  // ===========================================================================
  // 方法 6: read - 读取文件内容
  // ===========================================================================

  /**
   * 【read - 读取文件内容】
   * 
   * 作用：读取文件内容，支持多种读取方式和编码
   * 
   * 参数详解：
   * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
   * │ 参数名            │ 说明                                    │ 示例         │
   * ├──────────────────┼────────────────────────────────────────┼─────────────┤
   * │ inputPath        │ 文件路径                                │ "/src/a.ts"  │
   * │ range            │ 字节范围 ("head:1000", "tail:500", "0:100") │ "head:500" │
   * │ line             │ 读取指定行号                            │ 42           │
   * │ lines            │ 读取行范围 ("10-20")                    │ "10-20"      │
   * │ encoding         │ 编码方式 ("utf-8" | "base64" | "hex")   │ "utf-8"      │
   * │ includeMeta      │ 是否返回文件元数据                      │ true         │
   * └──────────────────┴────────────────────────────────────────┴─────────────┘
   * 
   * 【新手示例 - 读取整个文件】
   * const result = await fileService.read("/root/work/flycode/README.md", {});
   * console.log(result.content);  // 文件内容
   * console.log(result.meta?.size);  // 文件大小
   * 
   * 【新手示例 - 读取前 500 字符】
   * const result = await fileService.read("/root/work/flycode/README.md", {
   *   range: "head:500"
   * });
   * 
   * 【新手示例 - 读取指定行】
   * const result = await fileService.read("/root/work/flycode/src/index.ts", {
   *   line: 42
   * });
   * 
   * 【新手示例 - 读取 PDF 文件】
   * const result = await fileService.read("/docs/manual.pdf", {});
   * // 自动使用 pdf-parse 提取文本内容
   * 
   * 【数据处理流程】
   * 1. 读取原始文件 → 2. 计算 SHA256 → 3. 内容选择 (range/line/lines)
   * 4. 敏感信息脱敏 → 5. Token 预算控制 → 6. 返回结果
   */
  async read(
    inputPath: string,
    options: {
      range?: string;
      line?: number;
      lines?: string;
      encoding?: ReadEncoding;
      includeMeta?: boolean;
    }
  ): Promise<ReadInternalResult> {
    // ── 步骤 1: 路径标准化和检查 ──
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    // ── 步骤 2: 检查文件是否存在 ──
    const stat = await safeStat(target);
    if (!stat) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `File not found: ${target}`
      });
    }

    // ── 步骤 3: 检查是否为文件 ──
    if (!stat.isFile()) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: `Path is not a file: ${target}`
      });
    }

    // ── 步骤 4: 检查文件大小限制 ──
    if (stat.size > this.policy.limits.max_file_bytes) {
      throw new AppError({
        statusCode: 413,
        code: "LIMIT_EXCEEDED",
        message: `File exceeds max_file_bytes (${this.policy.limits.max_file_bytes})`
      });
    }

    // ── 步骤 5: 验证选择参数互斥 ──
    // range, line, lines 三者只能选其一
    const selectionCount = [options.range, options.line, options.lines].filter((item) => item !== undefined).length;
    if (selectionCount > 1) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Only one of range, line, lines can be used"
      });
    }

    // ── 步骤 6: 验证编码方式 ──
    const encoding = options.encoding ?? "utf-8";
    if (!["utf-8", "base64", "hex"].includes(encoding)) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: `Unsupported encoding: ${encoding}`
      });
    }

    // ── 步骤 7: 读取文件内容 ──
    const buffer = await fs.readFile(target);
    const fileHash = sha256(buffer);  // 计算文件哈希（用于审计和完整性验证）
    const mimeType = mime.lookup(target) || "text/plain";  // 根据扩展名判断 MIME 类型

    let content: string;
    if (encoding === "base64" || encoding === "hex") {
      // 二进制编码：不支持行选择
      if (options.line !== undefined || options.lines !== undefined) {
        throw new AppError({
          statusCode: 422,
          code: "INVALID_INPUT",
          message: "line/lines selection requires utf-8 encoding"
        });
      }
      content = buffer.toString(encoding);
    } else if (target.toLowerCase().endsWith(".pdf")) {
      // PDF 文件：使用 pdf-parse 提取文本
      try {
        const parsed = await pdfParse(buffer);
        content = parsed.text || "";
      } catch {
        throw new AppError({
          statusCode: 422,
          code: "INVALID_INPUT",
          message: `Failed to parse PDF file: ${target}`
        });
      }
    } else {
      // 普通文本文件
      content = buffer.toString("utf8");
    }

    // ── 步骤 8: 内容选择（range/line/lines） ──
    const selected = selectReadContent(content, {
      range: options.range,
      line: options.line,
      lines: options.lines
    });

    // ── 步骤 9: 敏感信息脱敏 ──
    const redacted = this.redactor.redact(selected);
    
    // ── 步骤 10: Token 预算控制 ──
    const budgeted = applyTokenBudget(redacted.content, this.policy.limits.max_inject_tokens);

    return {
      content: budgeted.content,
      mime: String(mimeType),
      bytes: stat.size,
      sha256: fileHash,
      truncated: budgeted.truncated,
      meta:
        options.includeMeta === false
          ? undefined
          : {
              size: stat.size,
              mtime: stat.mtime.toISOString(),
              ctime: stat.ctime.toISOString(),
              mode: formatFileMode(stat.mode)
            }
    };
  }

  // ===========================================================================
  // 方法 7: search - 搜索文件内容
  // ===========================================================================

  /**
   * 【search - 搜索文件内容】
   * 
   * 作用：在指定目录中搜索包含特定内容的文件
   * 
   * 【新手示例 - 简单搜索】
   * const result = await fileService.search("/root/work/flycode/src", {
   *   query: "function main"
   * });
   * console.log(result.matches);  // 匹配结果列表
   * console.log(result.total);    // 总匹配数
   * 
   * 【新手示例 - 正则搜索】
   * const result = await fileService.search("/root/work/flycode/src", {
   *   query: "function \\w+\\(",
   *   regex: true,
   *   extensions: [".ts", ".js"]
   * });
   * 
   * 【新手示例 - 带上下文的搜索】
   * const result = await fileService.search("/root/work/flycode/src", {
   *   query: "console.log",
   *   contextLines: 2,  // 显示匹配行前后各 2 行
   *   limit: 50
   * });
   * 
   * 【性能优化】
   * - 文件过滤：extensions, minBytes, maxBytes, mtimeFrom/To
   * - 结果限制：limit 参数防止返回过多结果
   * - 上下文限制：contextLines 最多 5 行
   */
  async search(
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
  }> {
    // ── 步骤 1: 路径标准化和检查 ──
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    const stat = await safeStat(target);
    if (!stat) {
      throw new AppError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Path not found: ${target}`
      });
    }

    // ── 步骤 2: 解析和验证选项 ──
    const maxMatches = Math.min(options.limit ?? this.policy.limits.max_search_matches, this.policy.limits.max_search_matches);
    const contextLines = clamp(options.contextLines ?? 0, 0, 5);
    const files: string[] = [];
    
    // 解析各种过滤条件
    const extensionSet = normalizeExtensions(options.extensions);
    const mtimeFrom = parseIsoDate(options.mtimeFrom, "mtimeFrom");
    const mtimeTo = parseIsoDate(options.mtimeTo, "mtimeTo");
    const minBytes = normalizeNonNegative(options.minBytes, "minBytes");
    const maxBytes = normalizeNonNegative(options.maxBytes, "maxBytes");

    // 验证 minBytes <= maxBytes
    if (minBytes !== undefined && maxBytes !== undefined && minBytes > maxBytes) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "minBytes cannot be greater than maxBytes"
      });
    }

    // ── 步骤 3: 收集待搜索的文件列表 ──
    if (stat.isFile()) {
      files.push(target);
    } else {
      await collectFiles(target, target, options.glob, files);
    }

    // ── 步骤 4: 编译正则表达式（如果需要） ──
    const matcher = options.regex ? compileRegex(options.query) : null;

    // ── 步骤 5: 执行搜索 ──
    const matches: Array<{
      path: string;
      line: number;
      column: number;
      text: string;
      before?: Array<{ line: number; text: string }>;
      after?: Array<{ line: number; text: string }>;
    }> = [];
    let total = 0;
    let truncated = false;

    for (const filePath of files) {
      // 跳过不允许的路径
      if (!isAllowedPath(this.pathPolicy, filePath)) {
        continue;
      }

      const fileStat = await safeStat(filePath);
      if (!fileStat || !fileStat.isFile()) {
        continue;
      }

      // 应用各种过滤条件
      if (fileStat.size > this.policy.limits.max_file_bytes) continue;
      if (minBytes !== undefined && fileStat.size < minBytes) continue;
      if (maxBytes !== undefined && fileStat.size > maxBytes) continue;
      if (mtimeFrom && fileStat.mtime.getTime() < mtimeFrom.getTime()) continue;
      if (mtimeTo && fileStat.mtime.getTime() > mtimeTo.getTime()) continue;
      if (extensionSet && !extensionSet.has(path.extname(filePath).toLowerCase())) continue;

      // 读取文件内容
      const raw = await fs.readFile(filePath, "utf8");
      const lines = raw.split(/\r?\n/);

      // 逐行搜索
      for (let i = 0; i < lines.length; i += 1) {
        const lineText = lines[i];
        const match = findMatch(lineText, options.query, matcher);
        if (match === null) {
          continue;
        }

        total += 1;
        if (matches.length < maxMatches) {
          const entry: {
            path: string;
            line: number;
            column: number;
            text: string;
            before?: Array<{ line: number; text: string }>;
            after?: Array<{ line: number; text: string }>;
          } = {
            path: filePath,
            line: i + 1,       // 行号从 1 开始
            column: match + 1, // 列号从 1 开始
            text: this.redactor.redact(lineText).content  // 脱敏处理
          };

          // 收集上下文
          if (contextLines > 0) {
            const before = collectContext(lines, Math.max(0, i - contextLines), i - 1, this.redactor);
            const after = collectContext(lines, i + 1, Math.min(lines.length - 1, i + contextLines), this.redactor);
            if (before.length > 0) {
              entry.before = before;
            }
            if (after.length > 0) {
              entry.after = after;
            }
          }

          matches.push(entry);
        } else {
          truncated = true;
        }
      }

      if (truncated) {
        break;
      }
    }

    return {
      matches,
      total,
      truncated
    };
  }

  // ===========================================================================
  // 方法 8: diff - 文件差异比较
  // ===========================================================================

  /**
   * 【diff - 文件差异比较】
   * 
   * 作用：比较两个文件或一个文件与一段内容的差异，生成 unified diff
   * 
   * 【新手示例 - 比较两个文件】
   * const result = await fileService.diff({
   *   leftPath: "/root/work/flycode/src/old.ts",
   *   rightPath: "/root/work/flycode/src/new.ts",
   *   contextLines: 3
   * });
   * console.log(result.unifiedDiff);
   * // --- /root/work/flycode/src/old.ts
   * // +++ /root/work/flycode/src/new.ts
   * // @@ -1,5 +1,6 @@
   * //  import { config } from './config';
   * // +import { utils } from './utils';
   * //  
   * //  export function main() {
   * 
   * 【新手示例 - 比较文件与内容】
   * const result = await fileService.diff({
   *   leftPath: "/root/work/flycode/src/index.ts",
   *   rightContent: "export const updated = true;",
   *   contextLines: 5
   * });
   * 
   * 【diff 算法】
   * 使用动态规划实现 LCS (最长公共子序列) 算法
   * 时间复杂度：O(n*m)，n 和 m 分别是两个文件的行数
   * 
   * 【限制】
   * - 单个文件最多 4000 行（防止内存溢出）
   * - 结果经过 Token 预算控制
   */
  async diff(input: {
    leftPath: string;
    rightPath?: string;
    rightContent?: string;
    contextLines?: number;
  }): Promise<{ leftPath: string; rightPath?: string; changed: boolean; unifiedDiff: string; truncated: boolean }> {
    // ── 步骤 1: 路径标准化和检查 ──
    const leftPath = this.pathPolicy.normalizeInputPath(input.leftPath);
    this.pathPolicy.assertAllowed(leftPath);

    const rightPath = input.rightPath ? this.pathPolicy.normalizeInputPath(input.rightPath) : undefined;
    const rightContent = input.rightContent;

    // ── 步骤 2: 验证 rightPath 和 rightContent 二选一 ──
    if ((rightPath && rightContent !== undefined) || (!rightPath && rightContent === undefined)) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Provide either rightPath or rightContent"
      });
    }

    if (rightPath) {
      this.pathPolicy.assertAllowed(rightPath);
    }

    // ── 步骤 3: 读取文件内容 ──
    const leftText = await readTextForDiff(leftPath, this.policy.limits.max_file_bytes);
    const rightText = rightPath
      ? await readTextForDiff(rightPath, this.policy.limits.max_file_bytes)
      : String(rightContent ?? "");

    // ── 步骤 4: 生成 unified diff ──
    const contextLines = clamp(input.contextLines ?? 3, 0, 20);
    const unified = createUnifiedDiff({
      leftLabel: leftPath,
      rightLabel: rightPath ?? "(inline)",
      leftText,
      rightText,
      contextLines
    });

    // ── 步骤 5: 脱敏和 Token 预算控制 ──
    const redacted = this.redactor.redact(unified).content;
    const budgeted = applyTokenBudget(redacted, this.policy.limits.max_inject_tokens);

    return {
      leftPath,
      rightPath,
      changed: leftText !== rightText,
      unifiedDiff: budgeted.content,
      truncated: budgeted.truncated
    };
  }

  // ===========================================================================
  // 方法 9: commitWrite - 提交写入操作
  // ===========================================================================

  /**
   * 【commitWrite - 提交写入操作】
   * 
   * 作用：执行实际的写入操作（两步写入的第二步）
   * 
   * 【两步写入流程】
   * 1. prepare: WriteManager 创建 PendingWriteOp，等待用户确认
   * 2. commit: 用户确认后调用此方法执行实际写入
   * 
   * 【新手示例】
   * const result = await fileService.commitWrite({
   *   opId: "op-abc123",
   *   path: "/root/work/flycode/src/new.ts",
   *   mode: "overwrite",
   *   content: "export const hello = 'world';"
   * });
   * // {
   * //   path: "/root/work/flycode/src/new.ts",
   * //   writtenBytes: 32,
   * //   backupPath: "/root/work/flycode/src/new.ts.flycode.bak.1771876542152",
   * //   newSha256: "abc123..."
   * // }
   * 
   * 【备份机制】
   * - 覆盖写入时，如果 policy.write.backup_on_overwrite=true
   * - 自动创建备份文件：{path}.flycode.bak.{timestamp}
   * - 备份文件也在 allowed_roots 保护范围内
   */
  async commitWrite(op: PendingWriteOp): Promise<{ path: string; writtenBytes: number; backupPath?: string; newSha256: string }> {
    // ── 步骤 1: 路径标准化和检查 ──
    const target = this.pathPolicy.normalizeInputPath(op.path);
    this.pathPolicy.assertAllowed(target);

    // ── 步骤 2: 确保父目录存在 ──
    await fs.mkdir(path.dirname(target), { recursive: true });

    // ── 步骤 3: 备份现有文件（如果是覆盖写入） ──
    let backupPath: string | undefined;
    const existing = await safeStat(target);
    if (op.mode === "overwrite" && existing?.isFile() && this.policy.write.backup_on_overwrite) {
      backupPath = `${target}.flycode.bak.${Date.now()}`;
      await fs.copyFile(target, backupPath);
    }

    // ── 步骤 4: 执行写入 ──
    if (op.mode === "append") {
      // 追加模式：在文件末尾添加内容
      await fs.appendFile(target, op.content, "utf8");
    } else {
      // 覆盖模式：写入新内容
      await fs.writeFile(target, op.content, "utf8");
    }

    // ── 步骤 5: 计算新文件哈希 ──
    const finalBuffer = await fs.readFile(target);

    return {
      path: target,
      writtenBytes: Buffer.byteLength(op.content),
      backupPath,
      newSha256: sha256(finalBuffer)
    };
  }

  // ===========================================================================
  // 方法 10: existingSha256 - 获取现有文件哈希
  // ===========================================================================

  /**
   * 【existingSha256 - 获取现有文件哈希】
   * 
   * 作用：计算并返回现有文件的 SHA256 哈希
   * 
   * 【使用场景】
   * - 写入前检查：expectedSha256 与实际哈希对比，防止并发冲突
   * - 审计日志：记录文件变更前的哈希
   * - 完整性验证：确认文件未被篡改
   * 
   * 【新手示例】
   * const hash = await fileService.existingSha256("/root/work/flycode/src/index.ts");
   * console.log(hash);  // "abc123..."
   * 
   * 【返回值】
   * - 文件存在：返回 SHA256 哈希字符串
   * - 文件不存在或不是文件：返回 null
   */
  async existingSha256(inputPath: string): Promise<string | null> {
    const target = this.pathPolicy.normalizeInputPath(inputPath);
    this.pathPolicy.assertAllowed(target);

    const stat = await safeStat(target);
    if (!stat?.isFile()) {
      return null;
    }

    const content = await fs.readFile(target);
    return sha256(content);
  }

  // ===========================================================================
  // 私有辅助方法
  // ===========================================================================

  /**
   * 【assertMutationAllowed - 检查变更操作是否允许】
   * 
   * 作用：检查 policy.mutation 中对应的开关是否启用
   * 
   * 【新手示例】
   * this.assertMutationAllowed("allow_rm", "fs.rm is disabled by policy");
   * // 如果 policy.mutation.allow_rm === false，抛出 403 FORBIDDEN
   */
  private assertMutationAllowed(flag: keyof PolicyConfig["mutation"], message: string): void {
    if (!this.policy.mutation[flag]) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message
      });
    }
  }

  /**
   * 【assertNotRootTarget - 检查是否为目标根目录】
   * 
   * 作用：防止删除或移动 allowed_roots 中配置的根目录
   * 
   * 【安全原理】
   * - allowed_roots 中的目录是项目的"安全沙箱"
   * - 删除根目录会导致整个项目无法访问
   * - 此检查是最后一道防线
   * 
   * 【新手示例】
   * // 假设 allowed_roots = ["/root/work/flycode"]
   * this.assertNotRootTarget("/root/work/flycode", "Cannot delete root");
   * // 抛出 403 POLICY_BLOCKED
   */
  private assertNotRootTarget(target: string, message: string): void {
    const targetKey = normalizeForPathCompare(target);
    const roots = this.policy.allowed_roots.map((root) => normalizeForPathCompare(this.pathPolicy.normalizeInputPath(root)));
    if (roots.includes(targetKey)) {
      throw new AppError({
        statusCode: 403,
        code: "POLICY_BLOCKED",
        message
      });
    }
  }
}

// =============================================================================
// 第四部分：独立工具函数
// =============================================================================

/**
 * 【isAllowedPath - 检查路径是否允许】
 * 
 * 作用：尝试调用 pathPolicy.assertAllowed()，如果抛异常则返回 false
 * 
 * 【使用场景】
 * - ls/search 等操作中过滤结果
 * - 作为防御性检查，确保不会返回不允许的路径
 * 
 * 【新手示例】
 * if (isAllowedPath(pathPolicy, "/some/path")) {
 *   // 路径允许，可以处理
 * }
 */
function isAllowedPath(pathPolicy: PathPolicy, candidatePath: string): boolean {
  try {
    pathPolicy.assertAllowed(candidatePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 【safeStat - 安全的 stat 函数】
 * 
 * 作用：封装 fs.stat()，文件不存在时返回 null 而不是抛异常
 * 
 * 【为什么需要？】
 * - 文件不存在是常见情况（不是错误）
 * - 避免大量的 try-catch 代码
 * - 调用方可以根据返回值决定如何处理
 * 
 * 【新手示例】
 * const stat = await safeStat("/path/to/file");
 * if (stat) {
 *   // 文件存在，可以使用 stat
 * } else {
 *   // 文件不存在
 * }
 */
async function safeStat(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (error: unknown) {
    // ENOENT = "Error NO ENTry"，即文件不存在
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    // 其他错误（如权限不足）直接抛出
    throw error;
  }
}

/**
 * 【selectReadContent - 选择读取内容】
 * 
 * 作用：根据 range/line/lines 参数从完整内容中提取指定部分
 * 
 * 【新手示例】
 * selectReadContent("line1\nline2\nline3", { line: 2 });
 * // 返回: "line2"
 * 
 * selectReadContent("line1\nline2\nline3", { lines: "1-2" });
 * // 返回: "line1\nline2"
 * 
 * selectReadContent("hello world", { range: "head:5" });
 * // 返回: "hello"
 */
function selectReadContent(
  content: string,
  options: { range?: string; line?: number; lines?: string }
): string {
  // ── 按行号读取 ──
  if (options.line !== undefined) {
    const line = Math.floor(Number(options.line));
    if (!Number.isFinite(line) || line <= 0) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "line must be a positive integer"
      });
    }

    const lines = content.split(/\r?\n/);
    return lines[line - 1] ?? "";  // 行号从 1 开始，数组从 0 开始
  }

  // ── 按行范围读取 ──
  if (options.lines !== undefined) {
    const match = /^(\d+)-(\d+)$/.exec(String(options.lines).trim());
    if (!match) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "lines must use format start-end"
      });
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start <= 0 || end <= 0 || start > end) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Invalid lines range"
      });
    }

    const lines = content.split(/\r?\n/);
    return lines.slice(start - 1, end).join("\n");
  }

  // ── 按字节范围读取 ──
  return applyRange(content, options.range);
}

/**
 * 【applyRange - 应用字节范围】
 * 
 * 作用：根据 range 参数从内容中提取指定字节范围
 * 
 * 【range 格式】
 * - "head:N"  : 前 N 个字符
 * - "tail:N"  : 后 N 个字符
 * - "start:end": 从 start 到 end 的字符（不包含 end）
 * 
 * 【新手示例】
 * applyRange("hello world", "head:5");   // "hello"
 * applyRange("hello world", "tail:5");   // "world"
 * applyRange("hello world", "0:5");      // "hello"
 * applyRange("hello world", "6:11");     // "world"
 */
function applyRange(content: string, range: string | undefined): string {
  if (!range) {
    return content;
  }

  const head = /^head:(\d+)$/i.exec(range);
  if (head) {
    const chars = Number(head[1]);
    return content.slice(0, chars);
  }

  const tail = /^tail:(\d+)$/i.exec(range);
  if (tail) {
    const chars = Number(tail[1]);
    return content.slice(Math.max(0, content.length - chars));
  }

  const pair = /^(\d+):(\d+)$/i.exec(range);
  if (pair) {
    const start = Number(pair[1]);
    const end = Number(pair[2]);
    return content.slice(start, end);
  }

  throw new AppError({
    statusCode: 422,
    code: "INVALID_INPUT",
    message: `Invalid range value: ${range}`
  });
}

/**
 * 【walkDir - 递归遍历目录】
 * 
 * 作用：深度优先遍历目录树，收集所有条目
 * 
 * 【新手示例】
 * const entries: Array<{ path: string; type: "file" | "directory"; bytes?: number }> = [];
 * await walkDir({
 *   root: "/root/work",
 *   current: "/root/work",
 *   depth: 0,
 *   maxDepth: 2,
 *   includePattern: "*.ts",
 *   onEntry: (entry) => entries.push(entry)
 * });
 * 
 * 【参数说明】
 * - root: 遍历的根目录（用于计算相对路径）
 * - current: 当前遍历的目录
 * - depth: 当前深度
 * - maxDepth: 最大深度
 * - includePattern: glob 匹配模式（可选）
 * - onEntry: 每发现一个条目时的回调函数
 */
async function walkDir(input: {
  root: string;
  current: string;
  depth: number;
  maxDepth: number;
  includePattern?: string;
  onEntry: (entry: { path: string; type: "file" | "directory"; bytes?: number }) => void;
}): Promise<void> {
  const { root, current, depth, maxDepth, includePattern, onEntry } = input;
  
  // 超过最大深度，停止递归
  if (depth > maxDepth) {
    return;
  }

  // 读取当前目录内容
  const dirents = await fs.readdir(current, { withFileTypes: true });
  
  for (const dirent of dirents) {
    const fullPath = path.join(current, dirent.name);
    const relative = path.relative(root, fullPath).split(path.sep).join("/");

    // 如果有 glob 模式，检查是否匹配
    if (includePattern && !minimatch(relative, includePattern, { dot: true })) {
      if (!dirent.isDirectory()) {
        continue;  // 不匹配的文件跳过
      }
      // 目录继续遍历（可能子目录中有匹配的文件）
    }

    if (dirent.isDirectory()) {
      // 目录：先记录，再递归
      onEntry({ path: fullPath, type: "directory" });
      await walkDir({
        root,
        current: fullPath,
        depth: depth + 1,
        maxDepth,
        includePattern,
        onEntry
      });
      continue;
    }

    // 文件：获取大小后记录
    const stat = await fs.stat(fullPath);
    onEntry({ path: fullPath, type: "file", bytes: stat.size });
  }
}

/**
 * 【collectFiles - 收集文件列表】
 * 
 * 作用：递归收集目录中的所有文件（用于 search）
 * 
 * 【与 walkDir 的区别】
 * - walkDir: 收集文件和目录，用于 ls
 * - collectFiles: 只收集文件，用于 search
 */
async function collectFiles(root: string, currentDir: string, glob: string | undefined, out: string[]): Promise<void> {
  const dirents = await fs.readdir(currentDir, { withFileTypes: true });
  
  for (const dirent of dirents) {
    const fullPath = path.join(currentDir, dirent.name);
    
    if (dirent.isDirectory()) {
      // 递归遍历子目录
      await collectFiles(root, fullPath, glob, out);
      continue;
    }

    // 如果有 glob 模式，检查是否匹配
    if (glob) {
      const relative = path.relative(root, fullPath).split(path.sep).join("/");
      if (!minimatch(relative, glob, { dot: true })) {
        continue;
      }
    }

    out.push(fullPath);
  }
}

/**
 * 【compileRegex - 编译正则表达式】
 * 
 * 作用：将用户提供的字符串编译为 RegExp 对象
 * 
 * 【新手示例】
 * const matcher = compileRegex("function \\w+");
 * // 返回: /function \w+/
 * 
 * compileRegex("[invalid");
 * // 抛出: 422 INVALID_INPUT - Invalid regex query: [invalid
 */
function compileRegex(query: string): RegExp {
  try {
    return new RegExp(query);
  } catch {
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: `Invalid regex query: ${query}`
    });
  }
}

/**
 * 【findMatch - 查找匹配位置】
 * 
 * 作用：在行文本中查找查询字符串/正则的匹配位置
 * 
 * 【新手示例】
 * findMatch("const x = 1;", "const", null);
 * // 返回: 0（匹配位置索引）
 * 
 * findMatch("const x = 1;", /\\d+/, /\\d+/);
 * // 返回: 8（数字 1 的位置）
 * 
 * findMatch("const x = 1;", "notfound", null);
 * // 返回: null（未找到）
 */
function findMatch(lineText: string, query: string, matcher: RegExp | null): number | null {
  if (matcher) {
    // 正则匹配
    const match = lineText.match(matcher);
    if (!match || match.index === undefined) {
      return null;
    }
    return match.index;
  }

  // 字符串匹配
  const idx = lineText.indexOf(query);
  return idx >= 0 ? idx : null;
}

/**
 * 【collectContext - 收集上下文行】
 * 
 * 作用：收集匹配行前后的上下文行（用于 search 结果）
 * 
 * 【新手示例】
 * const lines = ["line1", "line2", "line3", "line4", "line5"];
 * collectContext(lines, 1, 2, redactor);
 * // 返回: [{ line: 2, text: "line2" }, { line: 3, text: "line3" }]
 */
function collectContext(
  lines: string[],
  start: number,
  end: number,
  redactor: Redactor
): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  
  for (let i = start; i <= end; i += 1) {
    if (i < 0 || i >= lines.length) {
      continue;  // 跳过越界的行
    }
    out.push({
      line: i + 1,  // 行号从 1 开始
      text: redactor.redact(lines[i]).content  // 脱敏处理
    });
  }
  
  return out;
}

/**
 * 【normalizeExtensions - 标准化扩展名列表】
 * 
 * 作用：将用户提供的扩展名列表标准化为 Set
 * 
 * 【新手示例】
 * normalizeExtensions([".ts", "js", ".tsx"]);
 * // 返回: Set(3) {".ts", ".js", ".tsx"}
 * 
 * normalizeExtensions([]);
 * // 返回: undefined（不过滤）
 */
function normalizeExtensions(input: string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined;
  }

  const normalized = input
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));  // 确保有 . 前缀

  return normalized.length > 0 ? new Set(normalized) : undefined;
}

/**
 * 【parseIsoDate - 解析 ISO 日期字符串】
 * 
 * 作用：将 ISO 格式日期字符串解析为 Date 对象
 * 
 * 【新手示例】
 * parseIsoDate("2026-02-23T10:00:00.000Z", "mtimeFrom");
 * // 返回: Date 对象
 * 
 * parseIsoDate("invalid-date", "mtimeFrom");
 * // 抛出: 422 INVALID_INPUT - mtimeFrom must be an ISO date
 */
function parseIsoDate(value: string | undefined, fieldName: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: `${fieldName} must be an ISO date`
    });
  }

  return parsed;
}

/**
 * 【normalizeNonNegative - 标准化非负数】
 * 
 * 作用：验证并标准化非负数值
 * 
 * 【新手示例】
 * normalizeNonNegative(100, "minBytes");
 * // 返回: 100
 * 
 * normalizeNonNegative(-10, "minBytes");
 * // 抛出: 422 INVALID_INPUT - minBytes must be a non-negative number
 */
function normalizeNonNegative(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError({
      statusCode: 422,
      code: "INVALID_INPUT",
      message: `${fieldName} must be a non-negative number`
    });
  }

  return Math.floor(parsed);
}

/**
 * 【clamp - 数值范围限制】
 * 
 * 作用：确保数值在 [min, max] 范围内
 * 
 * 【新手示例】
 * clamp(50, 10, 100);    // 50
 * clamp(5, 10, 100);     // 10
 * clamp(150, 10, 100);   // 100
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const floor = Math.floor(value);
  return Math.min(Math.max(floor, min), max);
}

/**
 * 【formatFileMode - 格式化文件权限】
 * 
 * 作用：将文件 mode 数字格式化为八进制字符串
 * 
 * 【新手示例】
 * formatFileMode(0o644);
 * // 返回: "0644"
 * 
 * formatFileMode(33188);  // 0o644 的十进制表示
 * // 返回: "0644"
 */
function formatFileMode(mode: number): string {
  // mode & 0o777: 只保留权限位（去掉文件类型位）
  // .toString(8): 转为八进制字符串
  // .padStart(3, "0"): 确保至少 3 位
  // `0${...}`: 添加前导 0，变成 4 位格式
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

/**
 * 【normalizeForPathCompare - 标准化路径用于比较】
 * 
 * 作用：将路径标准化为可比较的格式（跨平台兼容）
 * 
 * 【处理内容】
 * 1. 将 \\ 替换为 /（Windows 路径统一）
 * 2. Windows 上转为小写（不区分大小写）
 * 
 * 【新手示例】
 * normalizeForPathCompare("C:\\Users\\test");
 * // Windows: "c:/users/test"
 * // Linux: "C:/Users/test"
 */
function normalizeForPathCompare(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 【readTextForDiff - 读取用于 diff 的文本】
 * 
 * 作用：读取文件内容用于差异比较
 * 
 * 【检查项】
 * 1. 文件必须存在且是文件
 * 2. 文件大小不能超过 maxBytes
 */
async function readTextForDiff(target: string, maxBytes: number): Promise<string> {
  const stat = await safeStat(target);
  if (!stat || !stat.isFile()) {
    throw new AppError({
      statusCode: 404,
      code: "NOT_FOUND",
      message: `Diff source is not a file: ${target}`
    });
  }

  if (stat.size > maxBytes) {
    throw new AppError({
      statusCode: 413,
      code: "LIMIT_EXCEEDED",
      message: `Diff source exceeds max_file_bytes (${maxBytes})`
    });
  }

  return fs.readFile(target, "utf8");
}

/**
 * 【createUnifiedDiff - 创建 unified diff 格式】
 * 
 * 作用：生成标准的 unified diff 输出
 * 
 * 【新手示例 - 输出格式】
 * --- /path/to/old.ts
 * +++ /path/to/new.ts
 * @@ -1,5 +1,6 @@
 *  import { config } from './config';
 * +import { utils } from './utils';
 *  
 *  export function main() {
 *     // ...
 * 
 * 【diff 算法】
 * 1. 使用动态规划计算 LCS（最长公共子序列）
 * 2. 根据 LCS 生成操作序列（equal/add/remove）
 * 3. 将连续的操作分组为 hunks（块）
 * 4. 每块包含上下文行和变更行
 * 
 * 【限制】
 * - 单个文件最多 4000 行（防止内存溢出）
 */
function createUnifiedDiff(input: {
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
  contextLines: number;
}): string {
  const leftLines = splitLines(input.leftText);
  const rightLines = splitLines(input.rightText);

  // 检查行数限制
  if (leftLines.length > 4000 || rightLines.length > 4000) {
    throw new AppError({
      statusCode: 413,
      code: "LIMIT_EXCEEDED",
      message: "Diff line count exceeds safe limit (4000 lines)"
    });
  }

  // 计算差异操作序列
  const ops = diffLines(leftLines, rightLines);
  const changed = ops.some((op) => op.kind !== "equal");
  const header = [`--- ${input.leftLabel}`, `+++ ${input.rightLabel}`];

  // 如果没有变化，只返回头部
  if (!changed) {
    return header.join("\n");
  }

  // 找出所有变化的位置
  const changedIndexes = ops
    .map((op, index) => ({ op, index }))
    .filter((item) => item.op.kind !== "equal")
    .map((item) => item.index);

  // 将连续的变化分组为 hunks（考虑上下文行）
  const segments: Array<{ start: number; end: number }> = [];
  let currentStart = Math.max(0, changedIndexes[0] - input.contextLines);
  let currentEnd = Math.min(ops.length - 1, changedIndexes[0] + input.contextLines);

  for (let i = 1; i < changedIndexes.length; i += 1) {
    const idx = changedIndexes[i];
    const nextStart = Math.max(0, idx - input.contextLines);
    const nextEnd = Math.min(ops.length - 1, idx + input.contextLines);

    if (nextStart <= currentEnd + 1) {
      // 两个变化块重叠或相邻，合并
      currentEnd = Math.max(currentEnd, nextEnd);
    } else {
      // 不重叠，保存当前块，开始新块
      segments.push({ start: currentStart, end: currentEnd });
      currentStart = nextStart;
      currentEnd = nextEnd;
    }
  }
  segments.push({ start: currentStart, end: currentEnd });

  // 生成 hunks
  const hunks: string[] = [];
  for (const segment of segments) {
    const segmentOps = ops.slice(segment.start, segment.end + 1);
    const startA = segmentOps[0]?.aLine ?? 1;
    const startB = segmentOps[0]?.bLine ?? 1;
    const countA = segmentOps.filter((op) => op.kind !== "add").length;
    const countB = segmentOps.filter((op) => op.kind !== "remove").length;
    hunks.push(`@@ -${startA},${countA} +${startB},${countB} @@`);

    for (const op of segmentOps) {
      if (op.kind === "equal") hunks.push(` ${op.line}`);
      if (op.kind === "remove") hunks.push(`-${op.line}`);
      if (op.kind === "add") hunks.push(`+${op.line}`);
    }
  }

  return [...header, ...hunks].join("\n");
}

/**
 * 【splitLines - 分割文本为行数组】
 * 
 * 作用：将文本按行分割，支持 \n 和 \r\n
 */
function splitLines(input: string): string[] {
  if (input.length === 0) {
    return [];
  }
  return input.split(/\r?\n/);
}

/**
 * 【diffLines - 计算行级差异】
 * 
 * 作用：使用动态规划实现 LCS 算法，计算两个行数组的差异
 * 
 * 【算法原理】
 * 1. 构建 DP 表：dp[i][j] 表示 leftLines[i:] 和 rightLines[j:] 的 LCS 长度
 * 2. 从后向前填充 DP 表
 * 3. 从 dp[0][0] 开始回溯，生成操作序列
 * 
 * 【时间复杂度】O(n*m)，n 和 m 分别是两个数组的长度
 * 【空间复杂度】O(n*m)，DP 表大小
 * 
 * 【新手示例】
 * diffLines(["a", "b", "c"], ["a", "x", "c"]);
 * // [
 * //   { kind: "equal", line: "a", aLine: 1, bLine: 1 },
 * //   { kind: "remove", line: "b", aLine: 2, bLine: 1 },
 * //   { kind: "add", line: "x", aLine: 2, bLine: 2 },
 * //   { kind: "equal", line: "c", aLine: 3, bLine: 3 }
 * // ]
 */
function diffLines(leftLines: string[], rightLines: string[]): DiffOp[] {
  const n = leftLines.length;
  const m = rightLines.length;
  
  // 初始化 DP 表（全部填充为 0）
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));

  // 从后向前填充 DP 表
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        leftLines[i] === rightLines[j]
          ? dp[i + 1][j + 1] + 1  // 相同，LCS 长度 +1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);  // 不同，取较大值
    }
  }

  // 回溯生成操作序列
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  let aLine = 1;
  let bLine = 1;

  while (i < n && j < m) {
    if (leftLines[i] === rightLines[j]) {
      // 相同：equal 操作
      ops.push({ kind: "equal", line: leftLines[i], aLine, bLine });
      i += 1;
      j += 1;
      aLine += 1;
      bLine += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      // 删除 leftLines[i]
      ops.push({ kind: "remove", line: leftLines[i], aLine, bLine });
      i += 1;
      aLine += 1;
    } else {
      // 添加 rightLines[j]
      ops.push({ kind: "add", line: rightLines[j], aLine, bLine });
      j += 1;
      bLine += 1;
    }
  }

  // 处理剩余的行
  while (i < n) {
    ops.push({ kind: "remove", line: leftLines[i], aLine, bLine });
    i += 1;
    aLine += 1;
  }

  while (j < m) {
    ops.push({ kind: "add", line: rightLines[j], aLine, bLine });
    j += 1;
    bLine += 1;
  }

  return ops;
}

// =============================================================================
// 文件结束 - 新手学习指引
// =============================================================================
// 
// 【理解这个文件后，你应该掌握】
// ✅ 所有文件操作方法的用途和参数
// ✅ 安全检查的三层机制（策略/路径/根目录保护）
// ✅ 数据处理流程（脱敏 + Token 预算）
// ✅ 独立工具函数的作用和使用方式
// ✅ diff 算法的基本原理（LCS 动态规划）
// 
// 【实践任务】
// 1. 测试 ls 方法：列出不同深度的目录
// 2. 测试 read 方法：使用 range/line/lines 参数
// 3. 测试 search 方法：搜索项目中的特定代码
// 4. 测试 diff 方法：比较两个文件的差异
// 
// 【调试技巧】
// - 在方法开始添加 console.log 查看输入参数
// - 检查 ~/.flycode/audit/*.jsonl 获取操作日志
// - 使用 safeStat 避免文件不存在时的异常处理
// 
// 【安全提醒】
// ⚠️ 所有路径都必须经过 normalizeInputPath 和 assertAllowed
// ⚠️ 删除/移动操作必须检查 assertNotRootTarget
// ⚠️ 返回内容必须经过 redactor 脱敏
// ⚠️ 大文件操作必须检查 max_file_bytes 限制
// 
// 【下一步学习】
// 建议继续阅读:
// - ./path-policy.ts: 路径白名单检查实现
// - ./redactor.ts: 敏感信息脱敏实现
// - ./token-budget.ts: Token 预算控制
// - ./write-manager.ts: 写入操作的两步确认流程
// =============================================================================
