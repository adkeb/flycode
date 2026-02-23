/**
 * FlyCode Note: Injection size guard
 * Estimates token usage and truncates oversized payloads to keep prompt injection within configured limits.
 */
export function applyTokenBudget(content: string, maxTokens: number): { content: string; truncated: boolean } {
  const estimatedTokens = estimateTokens(content);
  if (estimatedTokens <= maxTokens) {
    return { content, truncated: false };
  }

  const maxChars = maxTokens * 4;
  const truncated = `${content.slice(0, maxChars)}\n\n[...TRUNCATED_BY_FLYCODE_TOKEN_BUDGET...]`;
  return { content: truncated, truncated: true };
}

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}
