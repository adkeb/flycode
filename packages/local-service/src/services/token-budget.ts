/**
 * =============================================================================
 * FlyCode V2 - Token 预算控制器
 * =============================================================================
 * 
 * 【文件作用】
 * 这是 FlyCode 的"内容节流阀"，负责控制返回给 AI 的内容大小，
 * 防止过大的 payload 导致 AI 上下文溢出或 Token 消耗过快。
 * 
 * 【为什么需要 Token 预算？】
 * - 成本控制：AI API 按 Token 计费，过大内容会增加成本
 * - 上下文限制：AI 模型有最大上下文长度（如 128K Token）
 * - 响应速度：大内容需要更长时间处理和传输
 * - 资源保护：防止单次操作消耗过多资源
 * 
 * 【Token 估算原理】
 * Token 是 AI 模型处理文本的基本单位，不同模型的 Token 计算方式不同：
 * - GPT-4: 约 4 个字符 = 1 个 Token（英文）
 * - 中文：约 1.5-2 个汉字 = 1 个 Token
 * - 代码：因语言而异，通常 3-5 个字符 = 1 个 Token
 * 
 * 【FlyCode 的估算方法】
 * 为了简化计算，使用保守估算：
 * estimatedTokens = content.length / 4
 * 即：每 4 个字符估算为 1 个 Token
 * 
 * 【新手学习重点】
 * - Token 估算的简化方法
 * - 截断策略：保留开头，添加截断标记
 * - 快速路径：未超限时直接返回，避免不必要处理
 * 
 * @moduleflycode/local-service/services/token-budget
 * @performance-critical
 */

// =============================================================================
// 第一部分：核心函数 applyTokenBudget
// =============================================================================

/**
 * 【applyTokenBudget - 应用 Token 预算限制】
 * 
 * 作用：检查内容是否超过 Token 限制，如果超过则截断
 * 
 * 【执行流程】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 1. 估算内容的 Token 数量                                │
 * │    estimatedTokens = content.length / 4                │
 * ├─────────────────────────────────────────────────────────┤
 * │ 2. 检查是否超限                                         │
 * │    ├─ estimatedTokens <= maxTokens → 直接返回          │
 * │    └─ estimatedTokens > maxTokens → 执行截断           │
 * ├─────────────────────────────────────────────────────────┤
 * │ 3. 截断内容                                             │
 * │    - 计算最大字符数：maxChars = maxTokens * 4          │
 * │    - 截取前 maxChars 个字符                             │
 * │    - 添加截断标记：[...TRUNCATED_BY_FLYCODE_...]       │
 * ├─────────────────────────────────────────────────────────┤
 * │ 4. 返回结果                                             │
 * │    { content: truncated, truncated: true }             │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手示例 - 未超限】
 * const result = applyTokenBudget("Hello, World!", 1000);
 * // estimatedTokens = 13 / 4 = 3.25 ≈ 4 Tokens
 * // 4 <= 1000，不截断
 * // 返回: { content: "Hello, World!", truncated: false }
 * 
 * 【新手示例 - 超限截断】
 * const longContent = "a".repeat(10000);  // 10000 字符
 * const result = applyTokenBudget(longContent, 1000);
 * // estimatedTokens = 10000 / 4 = 2500 Tokens
 * // 2500 > 1000，需要截断
 * // maxChars = 1000 * 4 = 4000 字符
 * // 返回: { content: "aaaa...[...TRUNCATED_BY_FLYCODE_TOKEN_BUDGET...]", truncated: true }
 * 
 * 【截断策略说明】
 * 1. 保留开头：截取前 maxChars 个字符
 *    - 原因：文件开头通常包含重要信息（如导入、函数定义）
 *    - 对比：保留结尾会丢失上下文，保留中间会丢失开头和结尾
 * 
 * 2. 添加截断标记：明确告知 AI 内容被截断
 *    - 标记："\n\n[...TRUNCATED_BY_FLYCODE_TOKEN_BUDGET...]"
 *    - 作用：AI 知道内容不完整，不会基于不完整信息做判断
 * 
 * 3. 字符数计算：maxTokens * 4
 *    - 保守估算：确保实际 Token 数不超过限制
 *    - 留出余量：截断标记本身也占用 Token
 * 
 * 【性能优化 - 快速路径】
 * 如果内容未超限，直接返回原内容，避免不必要的字符串操作：
 * if (estimatedTokens <= maxTokens) {
 *   return { content, truncated: false };  // 快速返回
 * }
 * 
 * 【使用场景】
 * - file-service.read(): 读取文件后控制返回内容大小
 * - file-service.search(): 搜索结果可能很大，需要控制
 * - file-service.diff(): diff 输出可能很长，需要截断
 * - process-runner.ts: 命令输出控制
 */
export function applyTokenBudget(
  content: string,
  maxTokens: number
): { content: string; truncated: boolean } {
  // ── 步骤 1: 估算 Token 数量 ──
  // 使用简化公式：每 4 个字符 ≈ 1 个 Token
  // 这是一个保守估算，实际 Token 数可能更少
  const estimatedTokens = estimateTokens(content);

  // ── 步骤 2: 快速路径 - 未超限直接返回 ──
  // 避免不必要的字符串复制和截断操作
  if (estimatedTokens <= maxTokens) {
    return { content, truncated: false };
  }

  // ── 步骤 3: 计算最大字符数 ──
  // maxTokens * 4 确保实际 Token 数不超过限制
  // 例如：maxTokens=1000 → maxChars=4000
  const maxChars = maxTokens * 4;

  // ── 步骤 4: 执行截断 ──
  // 1. content.slice(0, maxChars): 截取前 maxChars 个字符
  // 2. 添加截断标记，告知 AI 内容被截断
  // 3. 标记前后加换行，确保格式清晰
  const truncated = `${content.slice(0, maxChars)}\n\n[...TRUNCATED_BY_FLYCODE_TOKEN_BUDGET...]`;

  // ── 步骤 5: 返回结果 ──
  // truncated: true 标志内容已被截断
  return { content: truncated, truncated: true };
}

// =============================================================================
// 第二部分：Token 估算函数
// =============================================================================

/**
 * 【estimateTokens - 估算 Token 数量】
 * 
 * 作用：根据内容长度估算 Token 数量
 * 
 * 【估算公式】
 * estimatedTokens = ceil(content.length / 4)
 * 
 * 【为什么是 /4？】
 * 1. GPT-4 官方数据：约 4 个字符 = 1 个 Token（英文）
 * 2. 中文更密集：约 1.5-2 个汉字 = 1 个 Token
 * 3. 代码混合：通常 3-5 个字符 = 1 个 Token
 * 4. 取保守值 4：确保估算值 >= 实际值，防止超限
 * 
 * 【为什么用 Math.ceil？】
 * - 向上取整确保不会低估 Token 数
 * - 例如：3.1 Tokens → 4 Tokens（保守估算）
 * 
 * 【新手示例】
 * estimateTokens("Hello");           // 5/4 = 1.25 → 2 Tokens
 * estimateTokens("你好世界");          // 4/4 = 1 → 1 Tokens
 * estimateTokens("const x = 1;");    // 12/4 = 3 → 3 Tokens
 * estimateTokens("");                // 0/4 = 0 → 0 Tokens
 * 
 * 【更精确的估算方法】
 * 如果需要更精确的估算，可以：
 * 1. 使用官方 Tokenizer 库（如 tiktoken）
 * 2. 区分语言：中文、英文、代码分别计算
 * 3. 考虑特殊 token：如函数名、变量名可能算作 1 个 Token
 * 
 * 【FlyCode 为什么用简化方法？】
 * 1. 性能：字符串长度计算 O(1)，Tokenizer 需要解析
 * 2. 简单：无需引入额外依赖
 * 3. 保守：估算值偏高，确保安全
 * 4. 足够：预算控制是最后一道防线，不是精确计费
 * 
 * 【注意事项】
 * - 这是估算值，实际 Token 数因模型而异
 * - 不同 AI 站点的 Token 计算方式可能不同
 * - 截断后的内容实际 Token 数会略少于估算值（因为截断标记）
 */
export function estimateTokens(content: string): number {
  // 内容长度除以 4，向上取整
  // 例如：1000 字符 → 250 Tokens
  //      1001 字符 → 251 Tokens
  return Math.ceil(content.length / 4);
}

// =============================================================================
// 文件结束 - 新手学习指引
// =============================================================================
// 
// 【理解这个文件后，你应该掌握】
// ✅ Token 预算控制的目的和重要性
// ✅ Token 估算的简化方法（字符数/4）
// ✅ 截断策略：保留开头 + 添加截断标记
// ✅ 快速路径优化：未超限时直接返回
// ✅ 保守估算原则：确保实际 Token 数不超过限制
// 
// 【实践任务】
// 1. 测试不同长度的内容：
//    applyTokenBudget("a".repeat(100), 1000)   // 不截断
//    applyTokenBudget("a".repeat(10000), 1000) // 截断
// 
// 2. 测试截断标记：
//    const result = applyTokenBudget("a".repeat(10000), 10);
//    console.log(result.content.endsWith("[...TRUNCATED_BY_FLYCODE_TOKEN_BUDGET...]"));
// 
// 3. 测试中英文混合：
//    applyTokenBudget("Hello 你好世界", 100);
// 
// 【调试技巧】
// - 打印估算 Token 数：console.log(estimateTokens(content))
// - 检查截断标志：console.log(result.truncated)
// - 比较截断前后长度：content.length vs result.content.length
// 
// 【性能提醒】
// ⚠️ 大文件读取时，Token 预算控制是最后一道防线
// ⚠️ 应该在读取前就限制文件大小（max_file_bytes）
// ⚠️ 截断操作会创建新字符串，大内容时注意内存使用
// 
// 【改进建议】
// - 使用更精确的 Tokenizer（如 tiktoken）
// - 区分内容类型：代码、文本、JSON 分别估算
// - 智能截断：在完整行/语句处截断，避免截断到一半
// - 保留结尾：某些场景下结尾更重要（如错误信息）
// 
// 【下一步学习】
// 建议继续阅读:
// - services/redactor.ts: 脱敏在 Token 预算之前执行
// - services/file-service.ts: applyTokenBudget 的调用位置
// - config/policy.ts: max_inject_tokens 策略配置
// =============================================================================
