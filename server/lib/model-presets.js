export const MODEL_PRESETS = {
  chatgpt: {
    modelKey: "chatgpt",
    name: "ChatGPT",
    url: "https://chatgpt.com/",
    submitMode: "auto",
    selectors: {
      input: "textarea:not([aria-hidden='true']), div[contenteditable='true']:not(.ql-clipboard):not([aria-hidden='true'])",
      uploadInput: "input[type='file']",
      sendButton: "button[data-testid='send-button'], button[aria-label*='Send'], button[aria-label*='发送'], button[type='submit']",
      reply: "[data-message-author-role='assistant'], .markdown"
    }
  },
  deepseek: {
    modelKey: "deepseek",
    name: "DeepSeek",
    url: "https://chat.deepseek.com/",
    submitMode: "auto",
    selectors: {
      input: "textarea:not([aria-hidden='true']), div[contenteditable='true']:not(.ql-clipboard):not([aria-hidden='true'])",
      sendButton: "button[aria-label*='Send'], button[aria-label*='发送'], button[aria-label*='Submit'], button[aria-label*='提交'], button[type='submit'], button[class*='send']",
      reply: ".ds-markdown, [class*='message']"
    }
  },
  qwen: {
    modelKey: "qwen",
    name: "Qwen",
    url: "https://chat.qwen.ai/",
    submitMode: "auto",
    selectors: {
      input: "textarea.message-input-textarea, textarea:not([aria-hidden='true']), div.ql-editor[contenteditable='true'], div.ProseMirror[contenteditable='true'], div[contenteditable='true']:not(.ql-clipboard):not([aria-hidden='true'])",
      sendButton: "button.send-button, button[aria-label*='Send'], button[aria-label*='发送'], button[type='submit'], button[class*='send']",
      skipButton: ".qwen-chat-mobile-chat-status-answer-now, button:has-text('跳过')",
      reply: ".chat-response-message, .markdown-body, .message-content, [class*='answer'], [class*='response']"
    }
  },
  gemini: {
    modelKey: "gemini",
    name: "Gemini",
    url: "https://gemini.google.com/",
    submitMode: "auto",
    selectors: {
      input: "textarea:not([aria-hidden='true']), div.ql-editor[contenteditable='true'], div[contenteditable='true']:not(.ql-clipboard):not([aria-hidden='true'])",
      uploadInput: "input[type='file']",
      uploadButton: "button[aria-label*='Add files'], button[aria-label*='Upload files'], button[aria-label*='Attach'], button[aria-label*='附件'], button[aria-label*='上传'], button[aria-label*='添加']",
      uploadMenuItem: "[role='menuitem']:has-text('Upload files'), [role='menuitem']:has-text('上传文件'), button:has-text('Upload files'), button:has-text('上传文件'), div:has-text('Upload files'), div:has-text('上传文件')",
      sendButton: "button[aria-label*='Send'], button[aria-label*='发送'], button[aria-label*='Submit'], button[aria-label*='提交'], button[type='submit'], button[class*='send']",
      reply: "model-response message-content, model-response .markdown, model-response .model-response-text, model-response"
    }
  },
  doubao: {
    modelKey: "doubao",
    name: "Doubao",
    url: "https://www.doubao.com/chat/",
    submitMode: "auto",
    selectors: {
      input: "textarea:not([aria-hidden='true']), div[contenteditable='true']:not(.ql-clipboard):not([aria-hidden='true'])",
      sendButton: "button[aria-label*='Send'], button[aria-label*='发送'], button[type='submit'], button[class*='send']",
      reply: "[class*='message'], [class*='answer']"
    }
  }
};

export const MODEL_OPTIONS = Object.values(MODEL_PRESETS).map(({ modelKey, name }) => ({ modelKey, name }));

export function getModelPreset(modelKey) {
  return MODEL_PRESETS[modelKey] ?? null;
}
