/**
 * =============================================================================
 * FlyCode V2 - 路径策略检查器
 * =============================================================================
 * 
 * 【文件作用】
 * 这是 FlyCode 的"路径安全卫士"，负责：
 * 1. 路径标准化：将各种格式的路径统一为绝对路径
 * 2. 白名单检查：验证路径是否在 allowed_roots 内
 * 3. 黑名单检查：验证路径是否匹配 deny_globs
 * 4. 站点白名单：验证 AI 站点是否被允许
 * 
 * 【为什么需要路径策略？】
 * - 防止路径遍历攻击（如 ../../../etc/passwd）
 * - 限制 AI 只能访问授权目录
 * - 禁止访问敏感文件（如 .env, .git/）
 * - 跨平台兼容（Linux/Windows 路径处理）
 * 
 * 【安全检查流程】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 1. 接收输入路径（如 "./src/../README.md"）              │
 * │ 2. normalizeInputPath(): 标准化为绝对路径               │
 * │    - 去除引号                                           │
 * │    - 展开 ~/ 为主目录                                   │
 * │    - 解析 ../ 和 ./                                     │
 * │    - 跨平台路径转换（Windows ↔ Linux）                  │
 * │ 3. assertAllowed(): 检查是否允许访问                    │
 * │    - 检查是否在 allowed_roots 内                         │
 * │    - 检查是否匹配 deny_globs                            │
 * │ 4. 通过则允许操作，否则抛 403 POLICY_BLOCKED            │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手学习重点】
 * - 路径标准化的重要性：防止 ../ 逃逸
 * - 白名单 + 黑名单双重保护
 * - 跨平台路径处理技巧
 * - isInside() 算法：判断路径包含关系
 * 
 * @moduleflycode/local-service/services/path-policy
 * @security-critical
 */

// =============================================================================
// 第一部分：导入依赖
// =============================================================================

/**
 * 【Node.js 原生模块】
 * - os: 获取用户主目录（~ 展开）
 * - path: 路径处理（posix/win32 双模式）
 */
import os from "node:os";
import path from "node:path";

/**
 * 【minimatch - glob 模式匹配库】
 * 
 * 作用：检查路径是否匹配 deny_globs 中的模式
 * 
 * 【新手示例】
 * minimatch("src/index.ts", "**.ts", { dot: true });  // true
 * minimatch(".git/config", "*.git/**", { dot: true }); // true
 * minimatch("README.md", "*.env*", { dot: true });     // false
 */
import { minimatch } from "minimatch";

/**
 * 【内部类型】
 * - PathPolicy: 本类实现的接口
 * - PolicyConfig: 策略配置（包含 allowed_roots, deny_globs 等）
 */
import type { PathPolicy, PolicyConfig } from "../types.js";

/**
 * 【AppError - 统一错误类】
 * 
 * 用于抛出策略阻止错误（403 POLICY_BLOCKED）
 */
import { AppError } from "../utils/errors.js";

/**
 * 【SiteId - 站点标识类型】
 * 
 * 用于站点白名单检查
 */
import type { SiteId } from "@flycode/shared-types";

// =============================================================================
// 第二部分：DefaultPathPolicy 类
// =============================================================================

/**
 * 【DefaultPathPolicy - 默认路径策略实现】
 * 
 * 作用：实现 PathPolicy 接口，提供路径标准化和访问检查功能
 * 
 * 【设计特点】
 * 1. 构造函数预计算：normalizedRoots 在构造时计算，避免每次重复计算
 * 2. 平台可注入：runtimePlatform 可注入，便于测试
 * 3. 双重检查：白名单 + 黑名单，确保路径安全
 * 
 * 【新手示例 - 实例化】
 * const pathPolicy = new DefaultPathPolicy({
 *   allowed_roots: ["/root/work/flycode"],
 *   deny_globs: ["*.git/**", "*node_modules/**"],
 *   site_allowlist: ["qwen", "deepseek"]
 *   // ... 其他配置
 * } as PolicyConfig);
 * 
 * // 使用
 * const normalized = pathPolicy.normalizeInputPath("./src/../README.md");
 * // 返回："/root/work/flycode/README.md"
 * 
 * pathPolicy.assertAllowed(normalized);
 * // 如果路径允许，不抛异常
 * 
 * pathPolicy.assertAllowed("/etc/passwd");
 * // 抛出：403 POLICY_BLOCKED - Path is outside allowed roots
 */
export class DefaultPathPolicy implements PathPolicy {
  /**
   * 【normalizedRoots - 标准化后的根目录列表】
   * 
   * 作用：预计算并存储标准化后的 allowed_roots
   * 
   * 【为什么预计算？】
   * - allowed_roots 在策略加载后不会变化
   * - 每次 assertAllowed() 都要检查路径是否在根目录内
   * - 预计算避免重复的 normalize 和 resolve 操作
   * 
   * 【示例】
   * allowed_roots: ["/root/work/flycode"]
   * → normalizedRoots: ["/root/work/flycode"] (已 resolve)
   * 
   * allowed_roots: ["./projects"]
   * → normalizedRoots: ["/root/work/projects"] (已 resolve)
   * 
   * private
   * readonly
   */
  private readonly normalizedRoots: string[];

  /**
   * 【构造函数】
   * 
   * 作用：初始化路径策略，预计算标准化根目录
   * 
   * 参数详解：
   * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
   * │ 参数名            │ 说明                                    │ 默认值       │
   * ├──────────────────┼────────────────────────────────────────┼─────────────┤
   * │ policy           │ 策略配置（包含 allowed_roots 等）        │ 必填         │
   * │ runtimePlatform  │ 运行平台（"win32" 或 "linux" 等）       │ process.platform │
   * └──────────────────┴────────────────────────────────────────┴─────────────┘
   * 
   * 【为什么注入 runtimePlatform？】
   * - 测试时可以模拟不同平台的行为
   * - 确保代码在 Linux 上也能正确处理 Windows 路径
   * - 符合依赖注入原则，便于单元测试
   * 
   * 【新手示例 - 测试时注入】
   * // 在 Linux 上测试 Windows 路径处理
   * const pathPolicy = new DefaultPathPolicy(policy, "win32");
   * const normalized = pathPolicy.normalizeInputPath("C:\\Users\\test");
   * // 返回："C:\\Users\\test" (Windows 格式)
   */
  constructor(
    private readonly policy: PolicyConfig,
    private readonly runtimePlatform: NodeJS.Platform = process.platform
  ) {
    // 预计算：将 allowed_roots 中的每个路径标准化并 resolve
    // 这样后续检查时可以直接使用，无需重复计算
    this.normalizedRoots = policy.allowed_roots.map((root) => this.resolvePath(this.normalizeInputPath(root)));
  }

  // ===========================================================================
  // 方法 1: normalizeInputPath - 路径标准化
  // ===========================================================================

  /**
   * 【normalizeInputPath - 标准化输入路径】
   * 
   * 作用：将各种格式的输入路径统一为绝对路径
   * 
   * 【处理流程】
   * ┌─────────────────────────────────────────────────────────┐
   * │ 1. 去除首尾空格                                          │
   * │ 2. 去除引号（" 或 '）                                    │
   * │ 3. 检查是否为空                                         │
   * │ 4. 处理 ~/ 开头（展开为主目录）                          │
   * │ 5. 根据平台处理路径：                                   │
   * │    ├─ Windows 平台：                                    │
   * │    │  ├─ 处理 WSL 路径 (/mnt/c/...) → C:\...            │
   * │    │  └─ 标准 Windows 路径 (C:\...)                     │
   * │    └─ Linux 平台：                                      │
   * │       ├─ 处理 Windows 路径 (C:\...) → /mnt/c/...        │
   * │       └─ 标准 Linux 路径 (/home/...)                    │
   * │ 6. 返回绝对路径                                         │
   * └─────────────────────────────────────────────────────────┘
   * 
   * 【新手示例 - 各种路径格式】
   * normalizeInputPath("./src/../README.md")
   * // → "/root/work/flycode/README.md"
   * 
   * normalizeInputPath("~/projects/app")
   * // → "/home/user/projects/app"
   * 
   * normalizeInputPath("\"/path/with spaces/file.txt\"")
   * // → "/path/with spaces/file.txt" (去除引号)
   * 
   * normalizeInputPath("C:\\Users\\test")  // 在 Linux 上
   * // → "/mnt/c/Users/test"
   * 
   * normalizeInputPath("/mnt/c/Users/test")  // 在 Windows 上
   * // → "C:\\Users\\test"
   * 
   * 【安全意义】
   * - 解析 ../ 防止路径遍历攻击
   * - 统一格式便于后续比较
   * - 跨平台兼容确保一致性
   */
  normalizeInputPath(inputPath: string): string {
    // ── 步骤 1: 去除首尾空格 ──
    const raw = inputPath.trim();

    // ── 步骤 2: 去除引号 ──
    // 处理 shell 中常见的带引号路径
    const unquoted = stripQuotes(raw);

    // ── 步骤 3: 检查是否为空 ──
    if (!unquoted) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: "Path cannot be empty"
      });
    }

    // ── 步骤 4: 处理 ~/ 开头（展开为主目录） ──
    if (unquoted.startsWith("~/")) {
      // os.homedir(): 获取当前用户的主目录
      // path.join(): 拼接路径
      const joined = this.pathApi.join(os.homedir(), unquoted.slice(2));
      return this.resolvePath(joined);
    }

    // ── 步骤 5: 根据平台处理路径 ──
    if (this.runtimePlatform === "win32") {
      // ── Windows 平台处理 ──

      // 处理 WSL 路径：/mnt/c/Users/test → C:\Users\test
      const mntMatch = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(unquoted);
      if (mntMatch) {
        const drive = mntMatch[1].toUpperCase();  // 驱动器号转大写
        const rest = (mntMatch[2] ?? "").replaceAll("/", "\\");  // / 转 \
        const winPath = rest ? `${drive}:\\${rest}` : `${drive}:\\`;
        return path.win32.normalize(winPath);
      }

      // 标准 Windows 路径：直接 resolve
      return path.win32.resolve(unquoted);
    }

    // ── Linux/Unix 平台处理 ──

    // 处理 Windows 路径：C:\Users\test → /mnt/c/Users/test
    const winMatch = /^([a-zA-Z]):[\\/](.*)$/.exec(unquoted);
    if (winMatch) {
      const drive = winMatch[1].toLowerCase();  // 驱动器号转小写
      const rest = winMatch[2].replaceAll("\\", "/");  // \ 转 /
      return path.posix.normalize(`/mnt/${drive}/${rest}`);
    }

    // 标准 Linux 路径：直接 resolve
    return path.posix.resolve(unquoted);
  }

  // ===========================================================================
  // 方法 2: assertAllowed - 检查路径是否允许
  // ===========================================================================

  /**
   * 【assertAllowed - 断言路径允许访问】
   * 
   * 作用：检查路径是否在 allowed_roots 内且不匹配 deny_globs
   * 
   * 【检查流程】
   * ┌─────────────────────────────────────────────────────────┐
   * │ 1. 标准化路径                                           │
   * │ 2. 找到所有包含该路径的根目录 (matchingRoots)           │
   * │ 3. 如果没有匹配的根目录 → 403 POLICY_BLOCKED           │
   * │ 4. 对每个匹配的根目录：                                 │
   * │    ├─ 计算相对路径 (relative)                           │
   * │    ├─ 检查是否匹配 deny_globs                          │
   * │    └─ 如果匹配 → 403 POLICY_BLOCKED                    │
   * │ 5. 所有检查通过 → 不抛异常（允许访问）                  │
   * └─────────────────────────────────────────────────────────┘
   * 
   * 【新手示例 - 允许的路径】
   * // 假设 allowed_roots = ["/root/work/flycode"]
   * // deny_globs = ["*.git/**", "*node_modules/**"]
   * 
   * pathPolicy.assertAllowed("/root/work/flycode/src/index.ts");
   * // ✓ 通过（在根目录内，不匹配 deny_globs）
   * 
   * pathPolicy.assertAllowed("/root/work/flycode/README.md");
   * // ✓ 通过
   * 
   * 【新手示例 - 阻止的路径】
   * pathPolicy.assertAllowed("/etc/passwd");
   * // ✗ 403 POLICY_BLOCKED - Path is outside allowed roots
   * 
   * pathPolicy.assertAllowed("/root/work/flycode/.git/config");
   * // ✗ 403 POLICY_BLOCKED - Path matches deny pattern: .git/config
   * 
   * pathPolicy.assertAllowed("/root/work/flycode/node_modules/pkg/index.js");
   * // ✗ 403 POLICY_BLOCKED - Path matches deny pattern: node_modules/pkg/index.js
   * 
   * 【安全原理】
   * 1. 白名单原则：只允许明确配置的根目录
   * 2. 黑名单补充：即使在内，敏感目录也禁止访问
   * 3. 双重保护：即使绕过一层，还有另一层
   */
  assertAllowed(inputPath: string): void {
    // ── 步骤 1: 标准化路径 ──
    const target = this.resolvePath(this.normalizeInputPath(inputPath));

    // ── 步骤 2: 找到所有包含该路径的根目录 ──
    // isInside() 检查 target 是否在 root 内部
    const matchingRoots = this.normalizedRoots.filter((root) => this.isInside(target, root));

    // ── 步骤 3: 检查是否有匹配的根目录 ──
    if (matchingRoots.length === 0) {
      // 没有任何 allowed_root 包含此路径 → 拒绝访问
      throw new AppError({
        statusCode: 403,
        code: "POLICY_BLOCKED",
        message: `Path is outside allowed roots: ${target}`
      });
    }

    // ── 步骤 4: 检查 deny_globs ──
    // 对每个匹配的根目录，检查相对路径是否被禁止
    for (const root of matchingRoots) {
      // 计算相对于根目录的路径
      const relative = this.relativePath(root, target).split(this.pathApi.sep).join("/");
      
      // 检查是否匹配任何 deny 模式
      const blocked = this.policy.deny_globs.some((pattern) => 
        minimatch(relative, pattern, { dot: true })
      );
      
      if (blocked) {
        throw new AppError({
          statusCode: 403,
          code: "POLICY_BLOCKED",
          message: `Path matches deny pattern: ${relative}`
        });
      }
    }

    // ── 步骤 5: 所有检查通过 ──
    // 不抛异常，允许继续操作
  }

  // ===========================================================================
  // 方法 3: assertSiteAllowed - 检查站点是否允许
  // ===========================================================================

  /**
   * 【assertSiteAllowed - 断言站点允许访问】
   * 
   * 作用：检查 AI 站点是否在 site_allowlist 内
   * 
   * 【为什么需要站点检查？】
   * - 防止未授权的 AI 站点调用本地服务
   * - 配合站点密钥认证，实现双重验证
   * - 便于审计：知道每个请求来自哪个站点
   * 
   * 【新手示例】
   * // 假设 site_allowlist = ["qwen", "deepseek"]
   * 
   * pathPolicy.assertSiteAllowed("qwen");
   * // ✓ 通过
   * 
   * pathPolicy.assertSiteAllowed("DEEPSEEK");
   * // ✓ 通过（不区分大小写）
   * 
   * pathPolicy.assertSiteAllowed("gemini");
   * // ✗ 403 FORBIDDEN - Site is not allowed: gemini
   * 
   * pathPolicy.assertSiteAllowed("unknown");
   * // ✗ 403 FORBIDDEN - Site is not allowed: unknown
   */
  assertSiteAllowed(site: SiteId): void {
    // 站点名转小写，实现不区分大小写匹配
    const normalized = site.toLowerCase();
    
    // 检查是否在 site_allowlist 内（也不区分大小写）
    const ok = this.policy.site_allowlist.some((candidate) => 
      candidate.toLowerCase() === normalized
    );

    if (!ok) {
      throw new AppError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: `Site is not allowed: ${site}`
      });
    }
  }

  // ===========================================================================
  // 私有辅助方法
  // ===========================================================================

  /**
   * 【pathApi - 获取平台对应的 path API】
   * 
   * 作用：根据 runtimePlatform 返回 path.win32 或 path.posix
   * 
   * 【为什么需要？】
   * - Windows 和 Linux 的路径分隔符不同（\ vs /）
   * - path.resolve() 等行为在不同平台有差异
   * - 测试时可以强制使用特定平台的 API
   * 
   * @private
   */
  private get pathApi(): typeof path.win32 | typeof path.posix {
    return this.runtimePlatform === "win32" ? path.win32 : path.posix;
  }

  /**
   * 【resolvePath - 解析路径】
   * 
   * 作用：使用当前平台的 path API 解析路径
   * 
   * 【resolve 的作用】
   * - 将相对路径转为绝对路径
   * - 解析 ../ 和 ./
   * - 规范化路径格式
   * 
   * private
   */
  private resolvePath(value: string): string {
    return this.pathApi.resolve(value);
  }

  /**
   * 【relativePath - 计算相对路径】
   * 
   * 作用：计算从 from 到 to 的相对路径
   * 
   * 【新手示例】
   * relativePath("/root/work", "/root/work/flycode/src")
   * // → "flycode/src"
   * 
   * relativePath("/root/work/flycode", "/root/work/flycode/.git/config")
   * // → ".git/config"
   * 
   * private
   */
  private relativePath(from: string, to: string): string {
    return this.pathApi.relative(from, to);
  }

  /**
   * 【isInside - 检查路径包含关系】
   * 
   * 作用：检查 target 是否在 root 目录内部
   * 
   * 【算法原理】
   * 1. 计算 root 到 target 的相对路径
   * 2. 如果相对路径为 "" → target === root，算作 inside
   * 3. 如果相对路径以 ".." 开头 → target 在 root 外部
   * 4. 如果相对路径是绝对路径 → target 在 root 外部
   * 5. 其他情况 → target 在 root 内部
   * 
   * 【新手示例】
   * isInside("/root/work/flycode/src", "/root/work/flycode")
   * // → true (src 在 flycode 内部)
   * 
   * isInside("/etc/passwd", "/root/work/flycode")
   * // → false (passwd 在 flycode 外部)
   * 
   * isInside("/root/work/flycode", "/root/work/flycode")
   * // → true (相同路径算作 inside)
   * 
   * 【安全意义】
   * 这是白名单检查的核心算法
   * 确保目标路径不会逃逸到 allowed_roots 外部
   * 
   * private
   */
  private isInside(target: string, root: string): boolean {
    const relative = this.relativePath(root, target);
    
    // relative === "" → target 和 root 相同
    // !relative.startsWith("..") → 不是父目录
    // !this.pathApi.isAbsolute(relative) → 不是绝对路径
    return relative === "" || (!relative.startsWith("..") && !this.pathApi.isAbsolute(relative));
  }
}

// =============================================================================
// 第三部分：独立工具函数
// =============================================================================

/**
 * 【stripQuotes - 去除引号】
 * 
 * 作用：去除字符串首尾的引号（" 或 '）
 * 
 * 【为什么需要？】
 * - shell 中路径常带引号（尤其是有空格时）
 * - 用户可能从命令行复制带引号的路径
 * - 统一处理，避免引号导致路径错误
 * 
 * 【新手示例】
 * stripQuotes('"/path/with spaces/file.txt"')
 * // → "/path/with spaces/file.txt"
 * 
 * stripQuotes("'/home/user/file.txt'")
 * // → "/home/user/file.txt"
 * 
 * stripQuotes("/no/quotes/file.txt")
 * // → "/no/quotes/file.txt" (无引号不变)
 * 
 * stripQuotes('"mismatched\'')
 * // → '"mismatched\'' (不匹配，不变)
 */
function stripQuotes(value: string): string {
  // 检查是否是成对的双引号或单引号
  if ((value.startsWith('"') && value.endsWith('"')) || 
      (value.startsWith("'") && value.endsWith("'"))) {
    // 去除首尾字符
    return value.slice(1, -1);
  }

  // 不是成对引号，原样返回
  return value;
}

// =============================================================================
// 文件结束 - 新手学习指引
// =============================================================================
// 
// 【理解这个文件后，你应该掌握】
// ✅ 路径标准化的重要性（防止 ../ 逃逸）
// ✅ 白名单 + 黑名单双重保护机制
// ✅ 跨平台路径处理技巧（Windows ↔ Linux）
// ✅ isInside() 算法：判断路径包含关系
// ✅ 依赖注入模式（runtimePlatform 可注入）
// 
// 【实践任务】
// 1. 测试各种路径格式：
//    - 相对路径：./src/../README.md
//    - 主目录：~/projects/app
//    - Windows 路径：C:\Users\test
//    - WSL 路径：/mnt/c/Users/test
// 
// 2. 测试白名单检查：
//    - 允许的路径：在 allowed_roots 内
//    - 阻止的路径：在 allowed_roots 外
// 
// 3. 测试黑名单检查：
//    - 尝试访问 .git/config
//    - 尝试访问 node_modules/pkg
// 
// 【调试技巧】
// - 在 normalizeInputPath() 添加 console.log 查看路径转换过程
// - 检查 isInside() 的 relative 值，理解包含关系判断
// - 使用不同 platform 参数测试跨平台行为
// 
// 【安全提醒】
// ⚠️ 永远不要跳过 assertAllowed() 检查
// ⚠️ allowed_roots 不要配置系统目录（如 / 或 C:\）
// ⚠️ deny_globs 要覆盖所有敏感文件模式
// ⚠️ 测试时验证 ../ 路径遍历攻击被阻止
// 
// 【下一步学习】
// 建议继续阅读:
// - services/redactor.ts: 敏感信息脱敏
// - services/file-service.ts: 文件操作（使用 pathPolicy）
// - config/policy.ts: 策略配置详解
// =============================================================================
