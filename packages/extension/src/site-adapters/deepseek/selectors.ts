/**
 * FlyCode Note: DeepSeek DOM selectors
 * Isolated selector constants for DeepSeek chat pages.
 */

export const DEEPSEEK_HOSTS = ["chat.deepseek.com", "www.deepseek.com"];

export const DEEPSEEK_INPUT_SELECTORS = ["textarea[data-testid='chat-input']", "textarea", "div[contenteditable='true'][role='textbox']"];

export const DEEPSEEK_SEND_BUTTON_SELECTORS = [
  "button[data-testid='send-button']",
  "button[aria-label*='Send']",
  "button[aria-label*='发送']"
];

export const DEEPSEEK_ASSISTANT_BLOCK_SELECTORS = ["pre code", "pre", "code", ".ds-message pre", ".ds-message code"];
