/**
 * FlyCode Note: Gemini DOM selectors
 * Centralized selectors for gemini.google.com so logic updates stay localized.
 */

export const GEMINI_HOSTS = ["gemini.google.com"];

export const GEMINI_INPUT_SELECTORS = [
  "rich-textarea div[contenteditable='true']",
  "div[role='textbox'][contenteditable='true']",
  "div[contenteditable='true'][aria-label*='prompt' i]",
  "textarea[aria-label*='message' i]",
  "textarea"
];

export const GEMINI_SEND_BUTTON_SELECTORS = [
  "button[aria-label*='Send message' i]",
  "button[aria-label*='Send' i]",
  "button[aria-label*='发送']",
  "button[mattooltip*='Send' i]",
  "button.send-button"
];

export const GEMINI_BLOCK_SELECTORS = ["pre code", "pre", "code"];

export const GEMINI_MODEL_CONTAINER_SELECTORS = [
  "[data-message-author-role='model']",
  ".model-response",
  ".model-response-container",
  ".response-content"
];

export const GEMINI_USER_CONTAINER_SELECTORS = [
  "[data-message-author-role='user']",
  ".user-query-container",
  ".user-query-content",
  ".chat-turn-user",
  ".user-message"
];

export const GEMINI_USER_MESSAGE_COUNT_SELECTORS = [
  "[data-message-author-role='user']",
  ".user-query-content",
  ".user-message"
];
