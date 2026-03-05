/**
 * FlyCode Note: DeepSeek DOM selectors (locked to current page snapshot)
 */

export const DEEPSEEK_HOSTS = ["chat.deepseek.com", "www.deepseek.com"];

export const DEEPSEEK_INPUT_SELECTORS = [
  "textarea._27c9245",
  "textarea[placeholder*='DeepSeek']",
  "textarea"
];

export const DEEPSEEK_SEND_BUTTON_SELECTORS = [
  ".b13855df > [role='button']._7436101[aria-disabled='false']",
  ".b13855df ._7436101[role='button'][aria-disabled='false']",
  ".b13855df > button._7436101:not([disabled])",
  "div._7436101[role='button'][aria-disabled='false']",
  "button._7436101:not([disabled])",
  "button[data-testid='send-button']:not([disabled])",
  "button[aria-label*='发送']:not([disabled])",
  "button[aria-label*='Send']:not([disabled])",
  "button[type='submit']:not([disabled])",
  ".b13855df [role='button'][aria-disabled='false']",
  ".b13855df button:not([disabled])"
];

export const DEEPSEEK_MESSAGE_ROOT_SELECTOR = ".ds-message._63c77b1, ._81e7b5e";
export const DEEPSEEK_USER_MARKER_CLASS = "_19d617c";

export const DEEPSEEK_MESSAGE_CONTENT_SELECTORS = [
  ":scope > .fbb737a4",
  ":scope > ._72b6158",
  ":scope ._72b6158",
  ":scope .fbb737a4",
  ":scope .ds-markdown",
  ":scope .md-code-block pre",
  ":scope .md-code-block"
];
