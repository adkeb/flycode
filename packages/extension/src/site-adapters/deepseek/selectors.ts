/**
 * FlyCode Note: DeepSeek DOM selectors
 * Isolated selector constants for DeepSeek chat pages.
 */

export const DEEPSEEK_HOSTS = ["chat.deepseek.com", "www.deepseek.com"];

export const DEEPSEEK_INPUT_SELECTORS = [
  "textarea[data-testid='chat-input']",
  "textarea[placeholder*='DeepSeek']",
  "textarea._27c9245",
  "textarea",
  "div[contenteditable='true'][role='textbox']"
];

export const DEEPSEEK_SEND_BUTTON_SELECTORS = [
  "button[data-testid='send-button']",
  "button[aria-label*='Send']",
  "button[aria-label*='发送']",
  ".b13855df button:not([disabled])",
  "button._7436101:not([disabled])"
];

export const DEEPSEEK_ASSISTANT_BLOCK_SELECTORS = [
  // DeepSeek markdown code block wrapper (header + copy/download + pre body)
  ".ds-message .md-code-block",
  "._81e7b5e .md-code-block",
  // DeepSeek plain bubble text containers (assistant + user side)
  ".ds-message ._72b6158",
  ".ds-message .fbb737a4",
  "._81e7b5e ._72b6158",
  "._81e7b5e .fbb737a4",
  ".ds-message pre code",
  ".ds-message pre",
  ".ds-message code",
  ".ds-markdown pre",
  ".ds-markdown code",
  "pre code",
  "pre",
  "code"
];
