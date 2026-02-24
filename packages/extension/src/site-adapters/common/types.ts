/**
 * FlyCode Note: Site adapter contract (V2)
 * Defines strict site-isolated adapter capabilities for MCP request extraction,
 * input injection, auto-submit, and summary masking.
 */
import type { SiteId } from "@flycode/shared-types";

export type AssistantBlockKind = "mcp-request" | "mcp-response" | "flycode-result" | "flycode-upload" | "unknown";
export type AssistantBlockSource = "assistant" | "user" | "unknown";

export interface AssistantBlock {
  node: HTMLElement;
  kind: AssistantBlockKind;
  text: string;
  source?: AssistantBlockSource;
}

export interface SubmitOutcome {
  ok: boolean;
  method: "button" | "enter" | "none";
  attempts: number;
}

export interface SiteAdapter {
  id: SiteId;
  matches(url: URL): boolean;
  findInput(): HTMLElement | null;
  getCurrentText(): string;
  injectText(text: string): boolean;
  submitAuto(): Promise<SubmitOutcome>;
  conversationId(): string;
  collectAssistantBlocks(): AssistantBlock[];
  applyMaskedSummary(node: HTMLElement, summary: string): void;
}
