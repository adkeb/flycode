/**
 * =============================================================================
 * FlyCode V2 - Local Service 入口文件
 * =============================================================================
 * 
 * 【文件作用】
 * 这是本地服务的启动入口，相当于程序的"主函数"。
 * 负责：
 * 1. 构建应用实例（加载配置、初始化服务）
 * 2. 启动 HTTP 服务器（仅监听 localhost）
 * 3. 打印启动信息（配对码、策略路径等）
 * 4. 全局错误捕获
 * 
 * 【执行流程】
 * ┌─────────────────────────────────┐
 * │ 1. 导入依赖 (buildApp, policy)   │
 * │ 2. 配置端口和主机 (39393/127.0.0.1)│
 * │ 3. 调用 buildApp() 构建应用      │
 * │ 4. app.listen() 启动服务器       │
 * │ 5. 获取并打印配对码              │
 * │ 6. 错误处理 (catch)              │
 * └─────────────────────────────────┘
 * 
 * 【新手学习重点】
 * - 为什么只监听 127.0.0.1？→ 安全考虑，防止外部访问
 * - 配对码是什么？→ 浏览器扩展与服务首次连接的"一次性密码"
 * - policy 文件在哪？→ ~/.flycode/policy.yaml
 * 
 * @moduleflycode/local-service/index
 * entrypoint
 */

// =============================================================================
// 第一部分：导入依赖
// =============================================================================

/**
 * 【buildApp - 应用构建函数】
 * 
 * 来源：./app.ts
 * 
 * 作用：
 * - 加载策略配置 (~/.flycode/policy.yaml)
 * - 初始化所有服务（文件服务、认证、审计等）
 * - 配置 Fastify 路由和中间件
 * - 返回 app 实例和 context 上下文
 * 
 * 【新手示例】
 * const { app, context } = await buildApp();
 * // app: Fastify 实例，用于监听请求
 * // context: 包含所有服务的上下文对象
 */
import { buildApp } from "./app.js";

/**
 * 【getPolicyFilePath - 获取策略文件路径】
 * 
 * 来源：./config/policy.ts
 * 
 * 作用：返回策略配置文件的绝对路径
 * 默认路径：~/.flycode/policy.yaml
 * 
 * 【新手示例】
 * const policyPath = getPolicyFilePath();
 * console.log(`策略文件: ${policyPath}`);
 * // 输出: /home/user/.flycode/policy.yaml
 */
import { getPolicyFilePath } from "./config/policy.js";

// =============================================================================
// 第二部分：服务器配置常量
// =============================================================================

/**
 * 【PORT - 服务监听端口】
 * 
 * 作用：指定 HTTP 服务器监听的端口号
 * 
 * 配置优先级：
 * 1. 环境变量 FLYCODE_PORT（如果设置）
 * 2. 默认值 39393
 * 
 * 【为什么选 39393？】
 * - 这是一个不常用的高端口，避免与常见服务冲突
 * - 便于记忆：39 = "Fly" 的谐音（F=6, L=12, Y=25 → 6+12+25=43≈39）
 * 
 * 【新手示例 - 自定义端口】
 * // 在终端执行：
 * export FLYCODE_PORT=40000
 * npm run dev:service
 * // 服务将监听 http://127.0.0.1:40000
 */
const PORT = Number(process.env.FLYCODE_PORT ?? 39393);

/**
 * 【HOST - 服务监听主机】
 * 
 * 作用：指定 HTTP 服务器监听的网络接口
 * 
 * 【安全设计】
 * - 固定为 "127.0.0.1"（localhost），只允许本机访问
 * - 防止外部网络攻击，即使服务有漏洞也不会暴露到公网
 * - 浏览器扩展通过 localhost 与之通信，符合浏览器安全策略
 * 
 * 【新手注意】
 * ❌ 不要改为 "0.0.0.0" 或 "::"，那会监听所有网络接口
 * ✅ 保持 "127.0.0.1"，确保只有本机可访问
 */
const HOST = "127.0.0.1";

// =============================================================================
// 第三部分：主函数
// =============================================================================

/**
 * 【main - 服务启动主函数】
 * 
 * 作用：按顺序执行服务启动的所有步骤
 * 
 * 执行流程详解：
 * ┌─────────────────────────────────────────────┐
 * │ 步骤 1: 构建应用                              │
 * │   const { app, context } = await buildApp()  │
 * │   - 加载 ~/.flycode/policy.yaml              │
 * │   - 初始化文件服务、认证、审计等组件          │
 * │   - 配置 Fastify 路由和中间件                 │
 * ├─────────────────────────────────────────────┤
 * │ 步骤 2: 启动 HTTP 服务器                      │
 * │   await app.listen({ port: PORT, host: HOST })│
 * │   - 绑定到 127.0.0.1:39393                   │
 * │   - 开始接收 MCP 协议请求                    │
 * ├─────────────────────────────────────────────┤
 * │ 步骤 3: 获取配对码                            │
 * │   context.pairCodeManager.getCurrentCode()   │
 * │   - 生成 6 位一次性配对码（如 FLYCODE-123456）│
 * │   - 有效期默认 5 分钟（policy.auth.pair_code_ttl_minutes）│
 * ├─────────────────────────────────────────────┤
 * │ 步骤 4: 打印启动信息                          │
 * │   process.stdout.write(...)                  │
 * │   - 服务地址、策略路径、配对码、过期时间      │
 * │   - 提醒：仅监听 localhost                   │
 * └─────────────────────────────────────────────┘
 * 
 * 【新手示例 - 启动输出】
 * FlyCode local service started
 * - address: http://127.0.0.1:39393
 * - policy: /home/user/.flycode/policy.yaml
 * - pair code (valid until 2026-02-23T10:05:00.000Z): FLYCODE-123456
 * - note: service only listens on 127.0.0.1
 * 
 * 【配对流程说明】
 * 1. 服务启动后显示配对码（如 FLYCODE-123456）
 * 2. 用户在浏览器扩展的 Options 页面输入该配对码
 * 3. 扩展调用 /pair/verify 接口验证配对码
 * 4. 验证成功后，服务返回 JWT Token
 * 5. 扩展后续请求使用该 Token 进行认证
 */
async function main(): Promise<void> {
  // 步骤 1: 构建应用实例
  // buildApp() 会加载所有配置和服务，返回 app 和 context
  const { app, context } = await buildApp();

  // 步骤 2: 启动 HTTP 服务器
  // 监听 127.0.0.1:PORT，只接受本机连接
  await app.listen({ port: PORT, host: HOST });

  // 步骤 3: 获取当前配对码和过期时间
  // 配对码用于浏览器扩展首次连接时的身份验证
  const code = context.pairCodeManager.getCurrentCode();
  const expiry = context.pairCodeManager.getExpiry().toISOString();

  // 步骤 4: 打印启动信息到控制台
  // 使用 process.stdout.write 确保输出格式可控
  process.stdout.write(
    [
      "FlyCode local service started",
      `- address: http://${HOST}:${PORT}`,
      `- policy: ${getPolicyFilePath()}`,
      `- pair code (valid until ${expiry}): ${code}`,
      "- note: service only listens on 127.0.0.1"
    ].join("\n") + "\n"
  );
}

// =============================================================================
// 第四部分：启动执行与错误处理
// =============================================================================

/**
 * 【启动执行】
 * 
 * 作用：调用 main() 并捕获全局错误
 * 
 * 错误处理逻辑：
 * 1. main() 正常执行 → 服务持续运行
 * 2. main() 抛出错误 → catch 捕获
 * 3. 打印错误堆栈到 stderr
 * 4. 以退出码 1 终止进程（表示异常退出）
 * 
 * 【新手示例 - 常见启动错误】
 * ❌ 端口被占用:
 *    Error: listen EADDRINUSE: address already in use 127.0.0.1:39393
 *    解决: 杀死占用进程或修改 FLYCODE_PORT
 * 
 * ❌ 策略文件权限错误:
 *    Error: EACCES: permission denied, open '~/.flycode/policy.yaml'
 *    解决: 检查文件权限或重新生成策略文件
 * 
 * ❌ 依赖加载失败:
 *    Error: Cannot find module './app.js'
 *    解决: 先执行 npm run build 编译 TypeScript
 */
main().catch((error) => {
  // 打印错误堆栈（如果有）或错误消息
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  
  // 以非零退出码终止进程，表示启动失败
  // 进程管理器（如 systemd）可根据退出码判断是否需要重启
  process.exit(1);
});

// =============================================================================
// 文件结束 - 新手学习指引
// =============================================================================
// 
// 【理解这个文件后，建议继续阅读】
// 
// 1. ./app.ts
//    - 了解 buildApp() 如何组装所有服务
//    - 学习 Fastify 路由和中间件配置
// 
// 2. ./config/policy.ts
//    - 理解安全策略的加载和默认值
//    - 学习如何自定义 allowed_roots、deny_globs 等
// 
// 3. ./security/auth.ts
//    - 了解 Bearer Token 验证流程
//    - 学习如何保护 API 路由
// 
// 4. ./services/file-service.ts
//    - 核心文件操作实现（ls/read/write/search）
//    - 学习路径白名单、脱敏、Token 预算等安全机制
// 
// 【调试技巧】
// - 添加 console.log 调试（开发模式有效）
// - 查看 ~/.flycode/console/*.jsonl 获取详细日志
// - 使用 curl 测试 API: curl http://127.0.0.1:39393/mcp/qwen
// 
// 【安全提醒】
// - 不要修改 HOST 为 0.0.0.0
// - 配对码有效期短，泄露后等待自动过期即可
// - 策略文件 ~/.flycode/policy.yaml 权限应为 600
// =============================================================================
