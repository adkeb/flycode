/**
 * FlyCode Note: Qwen DOM selectors
 * Centralized selectors for chat.qwen.ai to avoid selector drift across logic files.
 */

export const QWEN_HOSTS = ["chat.qwen.ai"];

export const QWEN_INPUT_SELECTORS = ["textarea.message-input-textarea", "textarea"];

export const QWEN_SEND_BUTTON_SELECTORS = [
  "button.send-button",
  "button[data-testid='send-button']",
  "button[aria-label*='发送']",
  "button[aria-label*='Send']",
  "button[type='submit']"
];

export const QWEN_BLOCK_SELECTORS = [
  "pre.qwen-markdown-code",
  ".qwen-chat-message-user .user-message-content"
];

export const QWEN_ASSISTANT_BLOCK_SELECTOR = QWEN_BLOCK_SELECTORS.join(",");

export const QWEN_CODE_HEADER_SELECTOR = ".qwen-markdown-code-header > div:first-child";

export const QWEN_CODE_BODY_SELECTOR = ".qwen-markdown-code-body";

export const QWEN_CODE_BODY_LINE_SELECTOR = ".qwen-markdown-code-body .view-line";
