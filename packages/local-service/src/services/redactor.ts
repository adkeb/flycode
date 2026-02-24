/**
 * =============================================================================
 * FlyCode V2 - 敏感信息脱敏器
 * =============================================================================
 * 
 * 【文件作用】
 * 这是 FlyCode 的"隐私保护盾"，负责在内容返回给 AI 之前，
 * 自动识别并替换敏感信息（如 API Key、密码、私钥等）。
 * 
 * 【为什么需要脱敏？】
 * - 防止密钥泄露：AI 对话日志可能被存储，敏感信息不应外泄
 * - 合规要求：某些场景下密码/密钥不能出现在第三方服务
 * - 最小权限：AI 只需要代码逻辑，不需要真实的密钥值
 * 
 * 【脱敏流程】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 1. 服务启动时编译规则                                    │
 * │    - 读取 policy.redaction.rules                         │
 * │    - 将 pattern 字符串编译为 RegExp 对象                  │
 * │    - 确保全局匹配标志 (g)                                 │
 * ├─────────────────────────────────────────────────────────┤
 * │ 2. 内容返回前脱敏                                        │
 * │    - file-service.read() 读取文件内容                    │
 * │    - redactor.redact(content) 应用所有规则               │
 * │    - 返回脱敏后的内容给 AI                               │
 * ├─────────────────────────────────────────────────────────┤
 * │ 3. 审计日志记录                                          │
 * │    - 记录原始内容的哈希（用于完整性验证）                │
 * │    - 不记录原始内容本身（保护隐私）                      │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手学习重点】
 * - 正则表达式的编译和缓存（性能优化）
 * - 全局匹配标志 (g) 的重要性
 * - 容错设计：无效规则不阻止服务启动
 * - 返回值设计：同时返回内容和 changed 标志
 * 
 * @moduleflycode/local-service/services/redactor
 * @security-critical
 */

// =============================================================================
// 第一部分：导入依赖
// =============================================================================

/**
 * 【内部类型】
 * - PolicyConfig: 策略配置（包含 redaction.rules）
 * - Redactor: 本类实现的接口
 * - RedactionRule: 脱敏规则定义
 */
import type { PolicyConfig, Redactor, RedactionRule } from "../types.js";

// =============================================================================
// 第二部分：内部类型定义
// =============================================================================

/**
 * 【CompiledRule - 编译后的脱敏规则】
 * 
 * 作用：将用户配置的红字符串规则预编译为可执行的 RegExp
 * 
 * 【字段说明】
 * ┌───────────────┬────────────────────────────────────────┬─────────────┐
 * │ 字段           │ 说明                                    │ 示例         │
 * ├───────────────┼────────────────────────────────────────┼─────────────┤
 * │ name          │ 规则名称（用于日志和调试）              │ "api_key"    │
 * │ regex         │ 编译后的正则表达式对象                  │ /sk-[a-z]+/g │
 * │ replacement   │ 替换文本                                │ "***KEY***"  │
 * └───────────────┴────────────────────────────────────────┴─────────────┘
 * 
 * 【为什么需要预编译？】
 * 1. 性能：RegExp 编译有开销，启动时编译一次，使用时直接执行
 * 2. 验证：启动时发现无效正则，记录日志但不崩溃
 * 3. 统一：确保所有规则都有全局标志 (g)
 * 
 * private
 */
interface CompiledRule {
  name: string;
  regex: RegExp;
  replacement: string;
}

// =============================================================================
// 第三部分：DefaultRedactor 类
// =============================================================================

/**
 * 【DefaultRedactor - 默认脱敏器实现】
 * 
 * 作用：实现 Redactor 接口，根据配置规则脱敏内容
 * 
 * 【设计特点】
 * 1. 构造函数预编译：rules 在构造时编译，避免每次 redact() 重复编译
 * 2. 快速路径：如果 disabled 或无规则，直接返回原内容
 * 3. 增量检测：跟踪 changed 标志，便于日志记录
 * 
 * 【新手示例 - 实例化】
 * const redactor = new DefaultRedactor({
 *   redaction: {
 *     enabled: true,
 *     rules: [
 *       {
 *         name: "api_key",
 *         pattern: "sk-[a-zA-Z0-9]{20,}",
 *         replacement: "***API_KEY***"
 *       }
 *     ]
 *   }
 *   // ... 其他策略配置
 * } as PolicyConfig);
 * 
 * // 使用
 * const result = redactor.redact(`
 *   const apiKey = "sk-abc123def456ghi789";
 *   console.log(apiKey);
 * `);
 * 
 * console.log(result.content);
 * // 输出:
 * //   const apiKey = "***API_KEY***";
 * //   console.log(apiKey);
 * 
 * console.log(result.changed);  // true（有内容被脱敏）
 */
export class DefaultRedactor implements Redactor {
  /**
   * 【enabled - 脱敏是否启用】
   * 
   * 作用：快速判断是否需要执行脱敏逻辑
   * 
   * 【为什么单独存储？】
   * - 避免每次 redact() 都访问 policy.redaction.enabled
   * - 快速路径优化：如果 disabled，直接返回原内容
   * 
   * @private
   * @readonly
   */
  private readonly enabled: boolean;

  /**
   * 【rules - 编译后的规则列表】
   * 
   * 作用：存储预编译的正则规则，供 redact() 使用
   * 
   * 【为什么是数组？】
   * - 规则按配置顺序执行，便于控制优先级
   * - 数组遍历简单，性能可接受（规则数通常 < 20）
   * 
   * @private
   * @readonly
   */
  private readonly rules: CompiledRule[];

  /**
   * 【构造函数】
   * 
   * 作用：初始化脱敏器，预编译所有规则
   * 
   * 【执行流程】
   * 1. 读取 policy.redaction.enabled 存储到 this.enabled
   * 2. 调用 compileRules() 编译所有规则
   * 3. 存储编译结果到 this.rules
   * 
   * 【容错设计】
   * - compileRules() 会捕获正则编译错误
   * - 无效规则被静默忽略，服务仍可启动
   * - 日志中可记录警告（当前实现未记录）
   * 
   * @param policy - 策略配置，包含脱敏规则
   */
  constructor(policy: PolicyConfig) {
    // 存储 enabled 标志，用于快速路径判断
    this.enabled = policy.redaction.enabled;
    
    // 预编译所有规则
    // 即使有无效规则，compileRules 会过滤掉，不影响服务启动
    this.rules = compileRules(policy.redaction.rules);
  }

  // ===========================================================================
  // 方法: redact - 执行脱敏
  // ===========================================================================

  /**
   * 【redact - 脱敏内容】
   * 
   * 作用：根据配置规则，替换内容中的敏感信息
   * 
   * 【执行流程】
   * ┌─────────────────────────────────────────────────────────┐
   * │ 1. 快速路径检查                                          │
   * │    ├─ enabled === false → 直接返回                      │
   * │    ├─ rules.length === 0 → 直接返回                     │
   * │    └─ content.length === 0 → 直接返回                   │
   * ├─────────────────────────────────────────────────────────┤
   * │ 2. 逐规则应用替换                                        │
   * │    for (rule of rules) {                                │
   * │      out = out.replace(rule.regex, rule.replacement)    │
   * │      if (changed) mark changed = true                   │
   * │    }                                                    │
   * ├─────────────────────────────────────────────────────────┤
   * │ 3. 返回结果                                              │
   * │    { content: out, changed: changed }                   │
   * └─────────────────────────────────────────────────────────┘
   * 
   * 【新手示例 - 脱敏 API Key】
   * const result = redactor.redact(`
   *   // 配置文件
   *   export const OPENAI_KEY = "sk-proj-abc123def456";
   *   export const DB_PASSWORD = "secret123";
   * `);
   * 
   * console.log(result.content);
   * // 输出:
   * //   // 配置文件
   * //   export const OPENAI_KEY = "***REDACTED***";
   * //   export const DB_PASSWORD = "***REDACTED***";
   * 
   * console.log(result.changed);  // true
   * 
   * 【新手示例 - 无敏感内容】
   * const result = redactor.redact("console.log('hello');");
   * console.log(result.content);  // "console.log('hello');" (不变)
   * console.log(result.changed);  // false
   * 
   * 【性能优化】
   * 1. 快速路径：disabled/无规则/空内容时直接返回，避免遍历
   * 2. 预编译：RegExp 在构造时编译，redact() 只执行替换
   * 3. 原地修改：使用 out 变量累积结果，避免多次字符串拼接
   * 
   * 【changed 标志的用途】
   * - 审计日志：记录哪些内容被脱敏过
   * - 调试：帮助开发者确认规则是否生效
   * - 优化：如果 unchanged，可跳过某些后续处理
   */
  redact(content: string): { content: string; changed: boolean } {
    // ── 步骤 1: 快速路径检查 ──
    // 如果脱敏禁用、无规则、或内容为空，直接返回原内容
    // 避免不必要的遍历和正则匹配
    if (!this.enabled || this.rules.length === 0 || content.length === 0) {
      return { content, changed: false };
    }

    // ── 步骤 2: 初始化输出和变更标志 ──
    let out = content;  // 累积替换结果
    let changed = false;  // 跟踪是否有内容被替换

    // ── 步骤 3: 逐规则应用替换 ──
    // 按配置顺序遍历所有编译后的规则
    for (const rule of this.rules) {
      // 使用 RegExp.replace() 执行全局替换
      // rule.regex 已确保有 "g" 标志，会替换所有匹配项
      const next = out.replace(rule.regex, rule.replacement);
      
      // 如果替换后内容变化，标记 changed
      // 注意：即使替换为相同字符串，replace 也会返回新字符串
      // 所以比较 next !== out 是可靠的
      if (next !== out) {
        changed = true;
      }
      
      // 更新输出，供下一条规则使用
      // 这样规则可以有优先级：前面的规则先执行
      out = next;
    }

    // ── 步骤 4: 返回结果 ──
    return { content: out, changed };
  }
}

// =============================================================================
// 第四部分：独立工具函数
// =============================================================================

/**
 * 【compileRules - 编译脱敏规则】
 * 
 * 作用：将用户配置的 RedactionRule[] 编译为 CompiledRule[]
 * 
 * 【编译流程】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 1. 遍历每条规则                                          │
 * │ 2. 尝试编译正则：new RegExp(pattern, flags)             │
 * │ 3. 确保全局标志：如果 flags 不含 "g"，自动添加           │
 * │ 4. 设置默认替换文本：如果 replacement 为空，用默认值     │
 * │ 5. 捕获异常：无效正则被忽略，服务继续启动                │
 * │ 6. 收集有效规则                                          │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手示例 - 编译规则】
 * const rules: RedactionRule[] = [
 *   {
 *     name: "api_key",
 *     pattern: "sk-[a-zA-Z0-9]{20,}",
 *     replacement: "***API_KEY***"
 *   },
 *   {
 *     name: "password",
 *     pattern: "password\\s*=\\s*['\"]?[^'\"]+",
 *     flags: "i"  // 忽略大小写
 *   }
 * ];
 * 
 * const compiled = compileRules(rules);
 * // [
 * //   {
 * //     name: "api_key",
 * //     regex: /sk-[a-zA-Z0-9]{20,}/g,
 * //     replacement: "***API_KEY***"
 * //   },
 * //   {
 * //     name: "password",
 * //     regex: /password\\s*=\\s*['\"]?[^'\"]+/gi,  // 自动添加 g
 * //     replacement: "***REDACTED***"  // 使用默认值
 * //   }
 * // ]
 * 
 * 【容错设计】
 * - try-catch 捕获 RegExp 编译错误
 * - 无效规则被静默忽略（当前实现）
 * - 服务仍可启动，避免单条规则错误导致整个系统不可用
 * 
 * 【改进建议】
 * - 记录警告日志：console.warn(`Invalid rule: ${rule.name}`)
 * - 提供规则验证 API：让用户在配置时就能发现错误
 * 
 * @param rules - 用户配置的脱敏规则列表
 * @returns 编译后的规则列表（仅包含有效规则）
 */
function compileRules(rules: RedactionRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  
  for (const rule of rules) {
    try {
      // ── 步骤 1: 标准化 flags ──
      // 确保只包含合法的 RegExp 标志，并去重
      const flags = normalizeFlags(rule.flags);
      
      // ── 步骤 2: 确保全局匹配 ──
      // 如果 flags 不含 "g"，自动添加
      // 因为脱敏需要替换所有匹配项，而不是第一个
      const globalFlags = flags.includes("g") ? flags : `${flags}g`;
      
      // ── 步骤 3: 编译正则 ──
      // 可能抛出 SyntaxError（如无效的正则语法）
      const regex = new RegExp(rule.pattern, globalFlags);
      
      // ── 步骤 4: 设置默认替换文本 ──
      // 如果用户未指定 replacement，使用通用默认值
      const replacement = rule.replacement ?? "***REDACTED***";
      
      // ── 步骤 5: 收集编译结果 ──
      compiled.push({
        name: rule.name,
        regex,
        replacement
      });
    } catch {
      // ── 步骤 6: 容错处理 ──
      // 捕获编译错误，静默忽略无效规则
      // 这样单条规则错误不会阻止服务启动
      // 
      // 【改进建议】添加日志:
      // console.warn(`[Redactor] Invalid rule "${rule.name}": ${error.message}`);
    }
  }
  
  return compiled;
}

/**
 * 【normalizeFlags - 标准化正则标志】
 * 
 * 作用：过滤并去重用户提供的 RegExp 标志
 * 
 * 【合法标志】
 * g - global: 全局匹配（替换所有匹配项）
 * i - ignoreCase: 忽略大小写
 * m - multiline: 多行模式（^ 和 $ 匹配行首行尾）
 * s - dotAll: 点号匹配换行符
 * u - unicode: Unicode 模式
 * y - sticky: 粘性匹配（从 lastIndex 开始）
 * 
 * 【处理流程】
 * 1. 如果 flags 为空，返回空字符串
 * 2. 将 flags 拆分为单个字符
 * 3. 过滤：只保留合法标志（gimsuy）
 * 4. 去重：使用 Set 去除重复字符
 * 5. 拼接：转回字符串
 * 
 * 【新手示例】
 * normalizeFlags("gi");      // → "gi"
 * normalizeFlags("igg");     // → "ig" (去重)
 * normalizeFlags("gix");     // → "gi" (过滤非法 x)
 * normalizeFlags(undefined); // → ""
 * normalizeFlags("");        // → ""
 * 
 * 【为什么需要标准化？】
 * 1. 安全：防止用户传入非法标志导致 RegExp 错误
 * 2. 健壮：去重避免重复标志（如 "gg" → "g"）
 * 3. 兼容：不同来源的配置可能有不同格式
 * 
 * @param flags - 用户提供的标志字符串（可选）
 * @returns 标准化后的标志字符串
 */
function normalizeFlags(flags: string | undefined): string {
  // 空值处理：返回空字符串
  if (!flags) {
    return "";
  }

  // 标准化流程：
  // 1. flags.split(""): 拆分为字符数组 ["g", "i", "g"]
  // 2. .filter(...): 只保留合法标志
  // 3. new Set(...): 去重
  // 4. [...]: 转回数组
  // 5. .join(""): 拼接为字符串
  return [...new Set(
    flags.split("").filter((flag) => "gimsuy".includes(flag))
  )].join("");
}

// =============================================================================
// 文件结束 - 新手学习指引
// =============================================================================
// 
// 【理解这个文件后，你应该掌握】
// ✅ 脱敏的基本原理：正则匹配 + 替换
// ✅ 预编译优化：启动时编译，使用时执行
// ✅ 全局标志 (g) 的重要性：替换所有匹配项
// ✅ 容错设计：无效规则不阻止服务启动
// ✅ changed 标志的用途：跟踪内容是否被修改
// 
// 【实践任务】
// 1. 测试默认规则：
//    - 创建包含 API Key 的文件
//    - 读取文件，观察输出是否被脱敏
// 
// 2. 添加自定义规则：
//    // ~/.flycode/policy.yaml
//    redaction:
//      rules:
//        - name: "github_token"
//          pattern: "ghp_[a-zA-Z0-9]{36}"
//          replacement: "***GITHUB_TOKEN***"
// 
// 3. 测试边界情况：
//    - 空内容：redact("")
//    - 无匹配：redact("no secrets here")
//    - 多匹配：redact("key1=sk-aaa key2=sk-bbb")
// 
// 【调试技巧】
// - 在 redact() 中添加 console.log 查看替换过程
// - 检查 compiled rules：console.log(redactor['rules'])
// - 测试 changed 标志：确认规则是否生效
// 
// 【安全提醒】
// ⚠️ 脱敏是最后一道防线，不能替代路径白名单
// ⚠️ 正则规则要谨慎编写，避免 ReDoS 攻击
// ⚠️ 审计日志记录哈希而非原始内容
// ⚠️ 定期审查脱敏规则，确保覆盖新出现的密钥格式
// 
// 【正则编写建议】
// ✅ 使用具体模式：sk-[a-zA-Z0-9]{20,} 比 .* 更安全
// ✅ 测试边界：确保不会误匹配正常代码
// ✅ 避免回溯：(?:...) 非捕获组比 (...) 性能更好
// ❌ 避免 .* 贪婪匹配：可能导致性能问题
// ❌ 避免嵌套量词：(a+)+ 可能导致 ReDoS
// 
// 【下一步学习】
// 建议继续阅读:
// - config/policy.ts: 脱敏规则的配置方式
// - services/file-service.ts: redact() 的调用位置
// - services/audit.ts: 审计日志如何记录脱敏事件
// =============================================================================
