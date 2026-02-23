/**
 * FlyCode Note: Trace identifier helper
 * Generates unique trace IDs for correlating extension requests with local service audit entries.
 */
export function newTraceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `trace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
