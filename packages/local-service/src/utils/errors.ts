/**
 * FlyCode Note: Unified application error type
 * Defines structured error class used for consistent status codes and response error codes.
 */
import type { AppErrorOptions } from "../types.js";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = "AppError";
    this.statusCode = options.statusCode;
    this.code = options.code;
  }
}
