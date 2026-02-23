/**
 * FlyCode Note: Site adapter contract
 * Defines minimal interface content script needs for input access, injection, and conversation tracking.
 */
import type { SiteId } from "@flycode/shared-types";

export interface SiteAdapter {
  id: SiteId;
  matches(url: URL): boolean;
  getInputEl(): HTMLElement | null;
  injectText(text: string): boolean;
  getCurrentText(): string;
  submitCurrentInput(): boolean;
  getConversationId(): string;
}
