/**
 * FlyCode Note: Bearer authentication guard
 * Validates Authorization header and token existence for all protected API routes.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SiteId } from "@flycode/shared-types";
import type { SiteKeyManager, TokenManager } from "../types.js";
import { AppError } from "../utils/errors.js";

export async function requireBearerAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
  tokenManager: TokenManager
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Missing bearer token"
    });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const ok = await tokenManager.verifyToken(token);

  if (!ok) {
    throw new AppError({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Invalid or expired token"
    });
  }
}

export async function requireSiteKeyAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
  site: Exclude<SiteId, "unknown">,
  siteKeyManager: SiteKeyManager
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Missing site key"
    });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const ok = await siteKeyManager.verifySiteKey(site, token);
  if (!ok) {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: `Invalid site key for ${site}`
    });
  }
}
