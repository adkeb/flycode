/**
 * =============================================================================
 * FlyCode V2 - 审计日志记录器
 * =============================================================================
 * 
 * 【文件作用】
 * 这是 FlyCode 的"安全审计员"，负责记录所有敏感操作的审计日志。
 * 日志以 JSONL 格式（每行一个 JSON 对象）存储在 ~/.flycode/audit/ 目录下。
 * 
 * 【为什么需要审计日志？】
 * - 安全追溯：发生问题时，可以追溯谁在什么时候做了什么操作
 * - 合规要求：某些场景下需要记录所有敏感操作
 * - 调试分析：开发时分析系统行为
 * - 异常检测：通过分析日志发现异常操作模式
 * 
 * 【日志格式 - JSONL】
 * JSONL (JSON Lines) 是一种每行一个 JSON 对象的格式：
 * {"timestamp":"2026-02-23T10:00:00.000Z","site":"qwen","command":"fs.read",...}
 * {"timestamp":"2026-02-23T10:01:00.000Z","site":"deepseek","command":"fs.write",...}
 * 
 * 【优点】
 * 1. 流式处理：可以逐行读取，不需要加载整个文件
 * 2. 日志轮转：按天分文件，便于管理和清理
 * 3. 追加写入：无需读取整个文件，性能好
 * 4. 易于解析：每行独立，损坏一行不影响其他行
 * 
 * 【新手学习重点】
 * - JSONL 格式的优势
 * - 按天分文件的日志轮转策略
 * - 追加写入 (appendFile) 的性能优势
 * - 审计日志 vs 控制台日志的区别
 * 
 * @moduleflycode/local-service/services/audit
 * @security-critical
 */

// =============================================================================
// 第一部分：导入依赖
// =============================================================================

/**
 * 【Node.js 原生模块】
 * - fs/promises: 异步文件操作（mkdir, appendFile）
 * - path: 路径拼接（跨平台兼容）
 */
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 【内部工具】
 * - getFlycodeHomeDir: 获取 ~/.flycode 目录路径
 * 
 * 来源：config/policy.ts
 */
import { getFlycodeHomeDir } from "../config/policy.js";

/**
 * 【内部类型】
 * - AuditEntry: 审计日志条目的数据结构
 * - AuditLogger: 本类实现的接口
 */
import type { AuditEntry, AuditLogger } from "../types.js";

// =============================================================================
// 第二部分：FileAuditLogger 类
// =============================================================================

/**
 * 【FileAuditLogger - 文件审计日志记录器】
 * 
 * 作用：实现 AuditLogger 接口，将审计日志写入文件
 * 
 * 【设计特点】
 * 1. 按天分文件：每天一个日志文件，便于管理和轮转
 * 2. 追加写入：使用 appendFile，无需读取整个文件
 * 3. 自动创建目录：首次使用时自动创建 ~/.flycode/audit/
 * 4. JSONL 格式：每行一个 JSON 对象，便于流式处理
 * 
 * 【日志文件结构】
 * ~/.flycode/
 * └── audit/
 *     ├── 2026-02-23.jsonl    # 今天的日志
 *     ├── 2026-02-22.jsonl    # 昨天的日志
 *     └── 2026-02-21.jsonl    # 前天的日志
 * 
 * 【新手示例 - 实例化】
 * const logger = new FileAuditLogger();
 * 
 * // 记录审计日志
 * await logger.log({
 *   timestamp: new Date().toISOString(),
 *   site: "qwen",
 *   command: "fs.read",
 *   path: "/root/work/flycode/README.md",
 *   outcome: "ok",
 *   bytes: 3481,
 *   truncated: false,
 *   userConfirm: false,
 *   traceId: "trace-001",
 *   auditId: "audit-001"
 * });
 * 
 * // 日志文件内容 (~/.flycode/audit/2026-02-23.jsonl):
 * // {"timestamp":"2026-02-23T10:00:00.000Z","site":"qwen",...}
 */
export class FileAuditLogger implements AuditLogger {
  /**
   * 【auditDir - 审计日志目录】
   * 
   * 作用：存储审计日志文件的目录路径
   * 默认：~/.flycode/audit/
   * 
   * @private
   * @readonly
   */
  private readonly auditDir: string;

  /**
   * 【构造函数】
   * 
   * 作用：初始化审计日志记录器，确定日志目录路径
   * 
   * 【执行流程】
   * 1. 调用 getFlycodeHomeDir() 获取 ~/.flycode 路径
   * 2. 使用 path.join() 拼接 audit 子目录
   * 3. 存储到 this.auditDir 供后续使用
   * 
   * 【新手示例】
   * const logger = new FileAuditLogger();
   * // logger.auditDir = "/home/user/.flycode/audit"
   * 
   * 【注意】
   * 构造函数不创建目录，目录在第一次 log() 时创建
   * 这样可以避免服务启动时不必要的文件系统操作
   */
  constructor() {
    // 拼接审计日志目录路径
    // getFlycodeHomeDir() 返回 ~/.flycode
    // path.join() 跨平台兼容（Windows 用 \，Linux 用 /）
    this.auditDir = path.join(getFlycodeHomeDir(), "audit");
  }

  // ===========================================================================
  // 方法: log - 记录审计日志
  // ===========================================================================

  /**
   * 【log - 记录单条审计日志】
   * 
   * 作用：将审计条目追加到当天的日志文件中
   * 
   * 【执行流程】
   * ┌─────────────────────────────────────────────────────────┐
   * │ 1. 确保日志目录存在 (mkdir -p)                          │
   * │ 2. 从 timestamp 提取日期 (2026-02-23)                   │
   * │ 3. 构建文件名 (2026-02-23.jsonl)                        │
   * │ 4. 构建完整路径 (~/.flycode/audit/2026-02-23.jsonl)     │
   * │ 5. 将 entry 序列化为 JSON 并追加到文件                   │
   * └─────────────────────────────────────────────────────────┘
   * 
   * 【新手示例 - 记录文件读取操作】
   * await logger.log({
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
   * });
   * 
   * 【新手示例 - 记录失败的操作】
   * await logger.log({
   *   timestamp: "2026-02-23T10:01:00.000Z",
   *   site: "deepseek",
   *   command: "fs.write",
   *   path: "/root/work/flycode/src/index.ts",
   *   outcome: "error",
   *   errorCode: "FORBIDDEN",
   *   message: "Path is outside allowed roots",
   *   traceId: "trace-002",
   *   auditId: "audit-002",
   *   truncated: false
   * });
   * 
   * 【日志文件内容示例】
   * # ~/.flycode/audit/2026-02-23.jsonl
   * {"timestamp":"2026-02-23T10:00:00.000Z","site":"qwen","command":"fs.read","path":"/root/work/flycode/README.md","outcome":"ok","bytes":3481,"truncated":false,"traceId":"trace-001","auditId":"audit-001"}
   * {"timestamp":"2026-02-23T10:01:00.000Z","site":"deepseek","command":"fs.write","path":"/root/work/flycode/src/index.ts","outcome":"error","errorCode":"FORBIDDEN","message":"Path is outside allowed roots","traceId":"trace-002","auditId":"audit-002","truncated":false}
   * 
   * 【为什么用追加写入 (appendFile)？】
   * 1. 性能：无需读取整个文件，直接追加到末尾
   * 2. 并发安全：操作系统保证追加操作的原子性
   * 3. 简单：不需要管理文件指针或锁
   * 
   * 【为什么按天分文件？】
   * 1. 日志轮转：旧日志可以定期清理或归档
   * 2. 查询效率：查询某天的日志只需读取一个文件
   * 3. 故障隔离：某天日志文件损坏不影响其他天
   * 4. 大小控制：单个文件不会无限增长
   * 
   * 【审计日志 vs 控制台日志】
   * ┌─────────────────────────────────────────────────────────┐
   * │ 特性              │ 审计日志 (audit) │ 控制台日志 (console)│
   * ├───────────────────┼──────────────────┼───────────────────┤
   * │ 记录内容          │ 敏感操作          │ 所有 API 调用       │
   * │ 用途              │ 安全审计          │ 调试分析          │
   * │ 存储位置          │ ~/.flycode/audit/ │ ~/.flycode/console/│
   * │ 保留时间          │ 较长（合规要求）  │ 较短（默认 30 天）  │
   * │ 包含内容哈希      │ 是               │ 可选             │
   * │ 包含请求/响应全文 │ 否（只记录摘要）  │ 是               │
   * └─────────────────────────────────────────────────────────┘
   */
  async log(entry: AuditEntry): Promise<void> {
    // ── 步骤 1: 确保日志目录存在 ──
    // recursive: true 表示如果父目录不存在也一并创建
    // 类似 shell 的 mkdir -p
    await fs.mkdir(this.auditDir, { recursive: true });

    // ── 步骤 2: 从 timestamp 提取日期 ──
    // entry.timestamp 格式："2026-02-23T10:00:00.000Z"
    // slice(0, 10) 提取前 10 个字符："2026-02-23"
    const fileName = `${entry.timestamp.slice(0, 10)}.jsonl`;

    // ── 步骤 3: 构建完整路径 ──
    // path.join() 跨平台兼容
    // Windows: C:\Users\user\.flycode\audit\2026-02-23.jsonl
    // Linux: /home/user/.flycode/audit/2026-02-23.jsonl
    const fullPath = path.join(this.auditDir, fileName);

    // ── 步骤 4: 追加写入日志 ──
    // JSON.stringify(entry): 将对象序列化为 JSON 字符串
    // + "\n": 每行一个 JSON 对象（JSONL 格式）
    // "utf8": 指定编码为 UTF-8
    //
    // 【为什么每行加换行符？】
    // 1. 便于逐行读取（fs.createReadStream + readline）
    // 2. 便于使用 shell 工具处理（grep, awk, jq）
    // 3. 避免多行 JSON 导致的解析复杂性
    await fs.appendFile(fullPath, `${JSON.stringify(entry)}\n`, "utf8");

    // ── 完成 ──
    // 日志已追加到文件，无需返回值
    // 如果写入失败，会抛出异常，由调用方处理
  }
}

// =============================================================================
// 文件结束 - 新手学习指引
// =============================================================================
// 
// 【理解这个文件后，你应该掌握】
// ✅ 审计日志的作用和重要性
// ✅ JSONL 格式的优势（流式处理、日志轮转）
// ✅ 按天分文件的日志管理策略
// ✅ 追加写入 (appendFile) 的性能优势
// ✅ 审计日志 vs 控制台日志的区别
// 
// 【实践任务】
// 1. 查看审计日志：
//    cat ~/.flycode/audit/$(date +%Y-%m-%d).jsonl
// 
// 2. 使用 jq 解析日志：
//    jq '.' ~/.flycode/audit/2026-02-23.jsonl
// 
// 3. 搜索特定操作：
//    grep 'fs.write' ~/.flycode/audit/*.jsonl
// 
// 4. 统计操作次数：
//    jq -r '.command' ~/.flycode/audit/*.jsonl | sort | uniq -c
// 
// 【调试技巧】
// - 检查日志目录权限：ls -la ~/.flycode/audit/
// - 使用 tail -f 实时查看新日志：tail -f ~/.flycode/audit/$(date +%Y-%m-%d).jsonl
// - 检查日志文件大小：du -sh ~/.flycode/audit/
// 
// 【安全提醒】
// ⚠️ 审计日志包含敏感操作记录，应设置适当权限（600）
// ⚠️ 定期清理旧日志，避免磁盘空间耗尽
// ⚠️ 生产环境考虑将日志发送到远程日志服务器
// ⚠️ 审计日志不应包含原始内容（只记录哈希）
// 
// 【日志管理建议】
// ✅ 设置日志保留策略（如保留 90 天）
// ✅ 定期归档旧日志（压缩后存储）
// ✅ 监控日志文件大小，设置告警
// ✅ 考虑使用日志轮转工具（如 logrotate）
// 
// 【下一步学习】
// 建议继续阅读:
// - services/console-log.ts: 控制台事件日志（更详细的调试日志）
// - config/policy.ts: 审计相关策略配置
// - types.ts: AuditEntry 类型定义详解
// =============================================================================
