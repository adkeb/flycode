/**
 * =============================================================================
 * FlyCode V2 - Bearer 认证守卫
 * =============================================================================
 * 
 * 【文件作用】
 * 这是 FlyCode 的"门禁系统"，负责验证每个 API 请求的身份。
 * 包含两个认证守卫函数：
 * 1. requireBearerAuth()    - 验证普通用户的 JWT Token
 * 2. requireSiteKeyAuth()   - 验证特定 AI 站点的站点密钥
 * 
 * 【为什么需要两层认证？】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 第一层：Bearer Token（用户级认证）                       │
 * │ - 用户通过配对码获取 JWT Token                           │
 * │ - 证明"我是合法用户"                                    │
 * │ - 有效期 30 天（policy.auth.token_ttl_days）              │
 * ├─────────────────────────────────────────────────────────┤
 * │ 第二层：Site Key（站点级认证）                           │
 * │ - 每个 AI 站点（qwen/deepseek）有独立密钥                 │
 * │ - 证明"这个请求来自授权的 AI 站点"                        │
 * │ - 防止恶意网站冒充合法 AI 站点                           │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【执行流程】
 * ┌─────────────────────────────────────────────┐
 * │ 1. 请求到达受保护的路由                      │
 * │ 2. Fastify 调用认证守卫 (preHandler)         │
 * │ 3. 守卫检查 Authorization 头                 │
 * │ 4. 提取 Bearer Token                         │
 * │ 5. 调用 TokenManager/SiteKeyManager 验证     │
 * │ 6. 验证通过 → 继续处理请求                   │
 * │    验证失败 → 抛出 AppError (401/403)        │
 * └─────────────────────────────────────────────┘
 * 
 * 【新手学习重点】
 * - Bearer Token 格式："Bearer <jwt_token>"
 * - 401 UNAUTHORIZED: Token 缺失或无效（身份问题）
 * - 403 FORBIDDEN: Token 有效但无权限（授权问题）
 * - Fastify preHandler 钩子的使用方式
 * 
 * @moduleflycode/local-service/security/auth
 * @security-critical
 */

// =============================================================================
// 第一部分：导入依赖
// =============================================================================

/**
 * 【Fastify 类型定义】
 * 
 * FastifyRequest: HTTP 请求对象，包含 headers、body、params 等
 * FastifyReply: HTTP 响应对象，用于发送响应
 * 
 * 【新手示例 - 请求对象结构】
 * {
 *   headers: {
 *     authorization: "Bearer eyJhbGciOiJIUzI1NiIs...",
 *     content-type: "application/json"
 *   },
 *   body: { ... },
 *   params: { ... }
 * }
 */
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * 【SiteId - 站点标识类型】
 * 
 * 来源：@flycode/shared-types
 * 
 * 可选值："qwen" | "deepseek" | "gemini" | "unknown"
 * 用于标识请求来自哪个 AI 平台
 */
import type { SiteId } from "@flycode/shared-types";

/**
 * 【TokenManager & SiteKeyManager - 认证管理器接口】
 * 
 * 来源：../types.ts
 * 
 * TokenManager 职责:
 * - verifyToken(token): 验证 JWT Token 是否有效且未过期
 * 
 * SiteKeyManager 职责:
 * - verifySiteKey(site, key): 验证站点密钥是否匹配
 * 
 * 【新手注意】
 * 这两个接口在 services/ 目录下有具体实现
 * 本文件只依赖接口，不关心具体实现（依赖倒置原则）
 */
import type { SiteKeyManager, TokenManager } from "../types.js";

/**
 * 【AppError - 统一错误类】
 * 
 * 来源：../utils/errors.ts
 * 
 * 作用：FlyCode 自定义错误类，包含 statusCode 和 errorCode
 * 便于统一错误处理和响应格式化
 * 
 * 【新手示例】
 * throw new AppError({
 *   statusCode: 401,
 *   code: "UNAUTHORIZED",
 *   message: "Token 无效"
 * });
 */
import { AppError } from "../utils/errors.js";

// =============================================================================
// 第二部分：Bearer Token 认证守卫
// =============================================================================

/**
 * 【requireBearerAuth - Bearer Token 认证守卫】
 * 
 * 作用：验证请求是否携带有效的 JWT Token
 * 
 * 使用场景：
 * - 所有受保护的 API 路由（如 /mcp/*, /console/*）
 * - 作为 Fastify 的 preHandler 钩子使用
 * 
 * 参数详解：
 * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
 * │ 参数名            │ 说明                                    │ 类型         │
 * ├──────────────────┼────────────────────────────────────────┼─────────────┤
 * │ request          │ Fastify 请求对象，包含 headers          │ FastifyRequest │
 * │ _reply           │ Fastify 响应对象（未使用，加_前缀）     │ FastifyReply  │
 * │ tokenManager     │ Token 验证管理器（依赖注入）            │ TokenManager  │
 * └──────────────────┴────────────────────────────────────────┴─────────────┘
 * 
 * 【新手注意 _reply 参数】
 * - 加下划线前缀表示"有意未使用"
 * - TypeScript 的 @typescript-eslint/no-unused-vars 规则要求
 * - 函数签名必须匹配 Fastify preHandler 钩子的类型
 * 
 * 【执行流程详解】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 步骤 1: 获取 Authorization 头                            │
 * │   const authHeader = request.headers.authorization      │
 * │                                                         │
 * │ 步骤 2: 检查是否存在且格式正确                          │
 * │   if (!authHeader?.startsWith("Bearer ")) {            │
 * │     throw 401 UNAUTHORIZED                              │
 * │   }                                                     │
 * │                                                         │
 * │ 步骤 3: 提取 Token 字符串                                │
 * │   const token = authHeader.slice("Bearer ".length)      │
 * │                                                         │
 * │ 步骤 4: 调用 TokenManager 验证                          │
 * │   const ok = await tokenManager.verifyToken(token)      │
 * │                                                         │
 * │ 步骤 5: 根据验证结果决定                                │
 * │   ├─ ok === true  → 继续处理请求（守卫通过）            │
 * │   └─ ok === false → 抛出 401 错误（守卫拒绝）            │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手示例 - 在路由中使用】
 * // 定义路由时添加 preHandler
 * fastify.get('/protected', {
 *   preHandler: [async (req, reply) => {
 *     await requireBearerAuth(req, reply, tokenManager);
 *   }]
 * }, async (req, reply) => {
 *   // 只有认证通过的请求才能到达这里
 *   return { data: '受保护的数据' };
 * });
 * 
 * 【新手示例 - 使用 Fastify 插件方式】
 * // 注册全局认证钩子
 * fastify.addHook('preHandler', async (request, reply) => {
 *   if (request.url.startsWith('/mcp/')) {
 *     await requireBearerAuth(request, reply, tokenManager);
 *   }
 * });
 * 
 * 【常见错误场景】
 * ┌──────────────────────────┬────────────────────────────────────┐
 * │ 场景                      │ 返回错误                            │
 * ├──────────────────────────┼────────────────────────────────────┤
 * │ 请求没有 Authorization 头  │ 401 UNAUTHORIZED - Missing bearer  │
 * │ Authorization 格式错误     │ 401 UNAUTHORIZED - Missing bearer  │
 * │ Token 已过期              │ 401 UNAUTHORIZED - Invalid or exp. │
 * │ Token 签名无效            │ 401 UNAUTHORIZED - Invalid or exp. │
 * │ Token 被撤销              │ 401 UNAUTHORIZED - Invalid or exp. │
 * └──────────────────────────┴────────────────────────────────────┘
 * 
 * 【安全原理】
 * 1. Bearer Token 是 JWT 格式，包含用户身份和过期时间
 * 2. 每次请求都验证，防止 Token 被盗用
 * 3. Token 存储在 ~/.flycode/site-keys.json，不暴露在代码中
 * 4. 验证失败立即拒绝，不泄露任何敏感信息
 */
export async function requireBearerAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
  tokenManager: TokenManager
): Promise<void> {
  // ── 步骤 1: 获取 Authorization 请求头 ──
  // HTTP 标准认证头格式：Authorization: Bearer <token>
  const authHeader = request.headers.authorization;

  // ── 步骤 2: 检查是否存在且格式正确 ──
  // 可选链操作符 ?. 防止 authHeader 为 undefined 时报错
  // startsWith("Bearer ") 确保使用标准的 Bearer 认证方案
  if (!authHeader?.startsWith("Bearer ")) {
    // 抛出 401 未授权错误
    // AppError 会被 Fastify 的错误处理器捕获并格式化为 JSON 响应
    throw new AppError({
      statusCode: 401,           // HTTP 状态码：401 Unauthorized
      code: "UNAUTHORIZED",      // 应用错误码（便于前端处理）
      message: "Missing bearer token"  // 人类可读的错误信息
    });
  }

  // ── 步骤 3: 提取 Token 字符串 ──
  // 去掉 "Bearer " 前缀（7 个字符）
  // trim() 去除首尾空格，防止客户端发送 "Bearer token  " 这种格式
  const token = authHeader.slice("Bearer ".length).trim();

  // ── 步骤 4: 调用 TokenManager 验证 Token ──
  // verifyToken 内部会检查:
  // 1. JWT 签名是否有效
  // 2. Token 是否过期 (exp claim)
  // 3. Token 是否在被撤销列表中
  const ok = await tokenManager.verifyToken(token);

  // ── 步骤 5: 根据验证结果决定 ──
  if (!ok) {
    // Token 无效或已过期
    throw new AppError({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Invalid or expired token"
    });
  }

  // 如果执行到这里，说明认证通过
  // Fastify 会继续执行路由处理器
}

// =============================================================================
// 第三部分：站点密钥认证守卫
// =============================================================================

/**
 * 【requireSiteKeyAuth - 站点密钥认证守卫】
 * 
 * 作用：验证请求是否来自授权的 AI 站点
 * 
 * 使用场景：
 * - MCP 路由 (/mcp/qwen, /mcp/deepseek)
 * - 需要区分不同 AI 站点的请求
 * - 防止跨站点攻击（如 qwen 的 Token 用于 deepseek 路由）
 * 
 * 参数详解：
 * ┌──────────────────┬────────────────────────────────────────┬─────────────┐
 * │ 参数名            │ 说明                                    │ 类型         │
 * ├──────────────────┼────────────────────────────────────────┼─────────────┤
 * │ request          │ Fastify 请求对象                        │ FastifyRequest │
 * │ _reply           │ Fastify 响应对象（未使用）              │ FastifyReply  │
 * │ site             │ 期望的站点 ID（如 "qwen"）              │ SiteId       │
 * │ siteKeyManager   │ 站点密钥验证管理器                      │ SiteKeyManager │
 * └──────────────────┴────────────────────────────────────────┴─────────────┘
 * 
 * 【site 参数类型详解】
 * Exclude<SiteId, "unknown"> = "qwen" | "deepseek" | "gemini"
 * 
 * 为什么排除 "unknown"？
 * - "unknown" 表示未识别的站点，不应该有独立的密钥
 * - 类型系统强制要求传入具体的站点 ID
 * - 防止程序员误传 "unknown" 导致安全漏洞
 * 
 * 【执行流程详解】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 步骤 1-3: 同 requireBearerAuth（获取并提取 Token）       │
 * │                                                         │
 * │ 步骤 4: 调用 SiteKeyManager 验证站点密钥                │
 * │   const ok = await siteKeyManager.verifySiteKey(        │
 * │     site,    // 期望的站点（如 "qwen"）                  │
 * │     token    // 请求中的 Token                           │
 * │   )                                                     │
 * │                                                         │
 * │ 步骤 5: 根据验证结果决定                                │
 * │   ├─ ok === true  → 继续处理请求                        │
 * │   └─ ok === false → 抛出 403 FORBIDDEN                  │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【新手示例 - 在 MCP 路由中使用】
 * // qwen 专用路由
 * fastify.post('/mcp/qwen', {
 *   preHandler: [async (req, reply) => {
 *     await requireSiteKeyAuth(req, reply, "qwen", siteKeyManager);
 *   }]
 * }, async (req, reply) => {
 *   // 只有携带 qwen 站点密钥的请求才能到达这里
 *   return handleMcpRequest(req, reply);
 * });
 * 
 * // deepseek 专用路由
 * fastify.post('/mcp/deepseek', {
 *   preHandler: [async (req, reply) => {
 *     await requireSiteKeyAuth(req, reply, "deepseek", siteKeyManager);
 *   }]
 * }, async (req, reply) => {
 *   // 只有携带 deepseek 站点密钥的请求才能到达这里
 *   return handleMcpRequest(req, reply);
 * });
 * 
 * 【401 vs 403 的区别】
 * ┌─────────────────────────────────────────────────────────┐
 * │ 401 UNAUTHORIZED (requireBearerAuth)                    │
 * │ - "你是谁？" - 身份认证失败                              │
 * │ - Token 缺失、格式错误、过期、签名无效                   │
 * │ - 解决方案：重新配对获取新 Token                         │
 * ├─────────────────────────────────────────────────────────┤
 * │ 403 FORBIDDEN (requireSiteKeyAuth)                      │
 * │ - "你能做什么？" - 权限授权失败                          │
 * │ - Token 有效但不是当前站点授权的                         │
 * │ - 解决方案：检查站点密钥配置                             │
 * └─────────────────────────────────────────────────────────┘
 * 
 * 【安全原理】
 * 1. 每个 AI 站点有独立的密钥，存储在 ~/.flycode/site-keys.json
 * 2. 站点密钥在扩展 Options 页面同步，用户可见
 * 3. 即使某个站点的密钥泄露，不影响其他站点
 * 4. 密钥可单独轮换（rotatedAt 字段记录轮换时间）
 * 
 * 【新手调试技巧】
 * 如果遇到 403 FORBIDDEN:
 * 1. 检查 ~/.flycode/site-keys.json 中对应站点的 key
 * 2. 在扩展 Options 页面点击"同步站点密钥"
 * 3. 确认请求的 Authorization 头使用的是正确的密钥
 */
export async function requireSiteKeyAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
  site: Exclude<SiteId, "unknown">,
  siteKeyManager: SiteKeyManager
): Promise<void> {
  // ── 步骤 1: 获取 Authorization 请求头 ──
  const authHeader = request.headers.authorization;

  // ── 步骤 2: 检查是否存在且格式正确 ──
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Missing site key"
    });
  }

  // ── 步骤 3: 提取 Token 字符串 ──
  const token = authHeader.slice("Bearer ".length).trim();

  // ── 步骤 4: 调用 SiteKeyManager 验证站点密钥 ──
  // verifySiteKey 内部会检查:
  // 1. 该站点是否有配置的密钥
  // 2. 请求的 Token 是否与配置的密钥匹配
  // 3. 密钥是否已过期或被轮换
  const ok = await siteKeyManager.verifySiteKey(site, token);

  // ── 步骤 5: 根据验证结果决定 ──
  if (!ok) {
    // 注意：这里返回 403 而不是 401
    // 因为 Token 格式可能正确，只是不属于当前站点
    throw new AppError({
      statusCode: 403,                    // HTTP 状态码：403 Forbidden
      code: "FORBIDDEN",                  // 应用错误码
      message: `Invalid site key for ${site}`  // 明确指出哪个站点的密钥无效
    });
  }

  // 认证通过，继续处理请求
}

// =============================================================================
// 文件结束 - 新手学习指引
// =============================================================================
// 
// 【理解这个文件后，你应该掌握】
// ✅ Bearer Token 认证的基本原理和流程
// ✅ 401 (身份) vs 403 (权限) 的区别
// ✅ Fastify preHandler 钩子的使用方式
// ✅ 依赖注入模式（TokenManager/SiteKeyManager 作为参数传入）
// ✅ TypeScript 类型守卫（Exclude<SiteId, "unknown">）
// 
// 【实践任务】
// 1. 使用 curl 测试认证：
//    # 无 Token（应返回 401）
//    curl http://127.0.0.1:39393/mcp/qwen
//    
//    # 错误 Token（应返回 401）
//    curl -H "Authorization: Bearer invalid" http://127.0.0.1:39393/mcp/qwen
//    
//    # 正确 Token（应通过认证）
//    curl -H "Authorization: Bearer <your_token>" http://127.0.0.1:39393/mcp/qwen
// 
// 2. 查看 ~/.flycode/site-keys.json 了解站点密钥结构
// 3. 阅读 ../services/confirmation-center.ts 了解认证后的权限控制
// 
// 【调试技巧】
// - 在守卫函数中添加 console.log 查看请求头
// - 检查 Fastify 日志：~/.flycode/console/*.jsonl
// - 使用浏览器开发者工具查看扩展发送的请求头
// 
// 【安全提醒】
// ⚠️ 永远不要将 Token 硬编码在代码中
// ⚠️ Token 泄露后立即轮换密钥（扩展 Options 页面可操作）
// ⚠️ 生产环境确保 HTTPS（虽然本服务只监听 localhost）
// ⚠️ 定期审计 ~/.flycode/audit/*.jsonl 中的认证失败记录
// 
// 【下一步学习】
// 建议继续阅读:
// - ./pairing.ts: 配对码生成和验证流程
// - ./site-keys.ts: 站点密钥的存储和管理
// - ../services/token-budget.ts: Token 预算控制
// - ../mcp-routes.ts: 认证守卫在 MCP 路由中的实际应用
// =============================================================================
