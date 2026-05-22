import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { getModelPreset } from "./model-presets.js";

const DEFAULT_TIMEOUT_MS = 90_000;
const ATTACHMENT_TIMEOUT_MS = 240_000;
const REPLY_STABLE_MS = 4000;

export class AgentManager {
  constructor({ configPath, settingsPath, profileDir, broadcast }) {
    this.configPath = configPath;
    this.settingsPath = settingsPath;
    this.profileDir = profileDir;
    this.broadcast = broadcast;
    this.contexts = new Map();
    this.pages = new Map();
    this.status = new Map();
    this.lastReplies = new Map();
  }

  async listAgents() {
    const agents = await this.readConfig();
    return agents.map((agent) => ({
      ...agent,
      status: this.status.get(agent.id) ?? "unopened",
      lastReply: this.lastReplies.get(agent.id) ?? ""
    }));
  }

  async readSettings() {
    try {
      const raw = await fs.readFile(this.settingsPath, "utf8");
      return normalizeSettings(JSON.parse(raw));
    } catch {
      return { displayCount: 5 };
    }
  }

  async updateSettings(patch) {
    const settings = normalizeSettings({ ...(await this.readSettings()), ...patch });
    await fs.writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    this.broadcast({ type: "settings", settings });
    return settings;
  }

  async updateAgent(id, patch) {
    const agents = await this.readConfig();
    const index = agents.findIndex((agent) => agent.id === id);
    if (index === -1) throw new Error("AI not found");

    const current = agents[index];
    const next = {
      ...current,
      name: sanitizeString(patch.name, current.name),
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
      url: sanitizeString(patch.url, current.url),
      systemPrompt: sanitizeOptionalString(patch.systemPrompt, current.systemPrompt),
      submitMode: sanitizeSubmitMode(patch.submitMode, current.submitMode),
      selectors: {
        ...current.selectors,
        ...(patch.selectors && typeof patch.selectors === "object" ? patch.selectors : {})
      }
    };
    agents[index] = next;
    await this.writeConfig(agents);
    this.broadcast({ type: "agents", agents: await this.listAgents() });
    return next;
  }

  async selectAgentModel(id, modelKey) {
    const preset = getModelPreset(modelKey);
    if (!preset) throw new Error("Model preset not found");

    const agents = await this.readConfig();
    const targetIndex = agents.findIndex((agent) => agent.id === id);
    if (targetIndex === -1) throw new Error("AI not found");

    const sourceIndex = agents.findIndex((agent) => agent.modelKey === modelKey);
    if (sourceIndex !== -1 && sourceIndex !== targetIndex) {
      const targetModel = agents[targetIndex];
      agents[targetIndex] = { ...agents[sourceIndex], enabled: targetModel.enabled };
      agents[sourceIndex] = { ...targetModel, enabled: agents[sourceIndex].enabled };
    } else {
      const current = agents[targetIndex];
      agents[targetIndex] = {
        ...current,
        ...clonePreset(preset),
        enabled: current.enabled,
        systemPrompt: current.systemPrompt ?? ""
      };
    }

    await this.writeConfig(agents);
    this.broadcast({ type: "agents", agents: await this.listAgents() });
    return this.listAgents();
  }

  async openAgent(id) {
    const agent = await this.requireAgent(id);
    if (!agent.url) throw new Error("URL is empty");

    this.emitStatus(id, "opening");
    const page = await this.ensurePage(agent);
    if (!page.url() || page.url() === "about:blank") {
      await page.goto(agent.url, { waitUntil: "domcontentloaded" });
    }
    this.emitStatus(id, "ready");
    return { ...agent, status: this.status.get(id) };
  }

  async readAgent(id) {
    const agent = await this.requireAgent(id);
    const page = this.pages.get(id);
    if (!page) throw new Error("AI page is not open");

    this.emitStatus(id, "reading");
    const reply = await this.readLatestReply(page, agent);
    this.lastReplies.set(id, reply);
    this.emitStatus(id, "done");
    this.broadcast({ type: "chat-result", agentId: id, reply });
    return { agentId: id, reply };
  }

  async sendToEnabledAgents(message, shareContext, attachments = []) {
    const settings = await this.readSettings();
    const agents = (await this.readConfig()).slice(0, settings.displayCount).filter((agent) => agent.enabled);
    if (settings.sendMode === "polling") {
      const results = [];
      for (const agent of agents) {
        results.push(await this.sendOne(agent, this.buildMessage(agent, agents, message, shareContext), attachments));
      }
      return results;
    }
    return Promise.all(agents.map((agent) => this.sendOne(agent, this.buildMessage(agent, agents, message, shareContext), attachments)));
  }

  async compareAgentReplies(sourceAgentId, targetAgentId, instruction) {
    if (sourceAgentId === targetAgentId) throw new Error("Please choose two different AIs");

    const agents = await this.readConfig();
    const sourceAgent = agents.find((agent) => agent.id === sourceAgentId);
    const targetAgent = agents.find((agent) => agent.id === targetAgentId);
    if (!sourceAgent || !targetAgent) throw new Error("AI not found");

    const sourceReply = this.lastReplies.get(sourceAgentId);
    const targetReply = this.lastReplies.get(targetAgentId);
    if (!sourceReply) throw new Error(`${sourceAgent.name} has no reply to compare`);
    if (!targetReply) throw new Error(`${targetAgent.name} has no reply to compare`);

    const task = sanitizeCompareInstruction(instruction);
    return Promise.all([
      this.sendOne(sourceAgent, this.buildCompareMessage(sourceAgent, targetAgent, targetReply, task)),
      this.sendOne(targetAgent, this.buildCompareMessage(targetAgent, sourceAgent, sourceReply, task))
    ]);
  }

  async summarizeAgentReplies(targetAgentId, sourceAgentIds, instruction) {
    const agents = await this.readConfig();
    const targetAgent = agents.find((agent) => agent.id === targetAgentId);
    if (!targetAgent) throw new Error("AI not found");

    const uniqueSourceIds = [...new Set(sourceAgentIds)].filter((id) => id !== targetAgentId);
    if (uniqueSourceIds.length === 0) throw new Error("Please choose at least one other AI reply");

    const sources = uniqueSourceIds.map((id) => {
      const agent = agents.find((item) => item.id === id);
      if (!agent) throw new Error("AI not found");
      const reply = this.lastReplies.get(id);
      if (!reply) throw new Error(`${agent.name} has no reply to summarize`);
      return { agent, reply };
    });

    const targetReply = this.lastReplies.get(targetAgentId);
    const task = sanitizeSummaryInstruction(instruction);
    return this.sendOne(targetAgent, this.buildSummaryMessage(targetAgent, targetReply, sources, task));
  }

  async clearChat() {
    this.lastReplies.clear();
    const agents = await this.listAgents();
    this.broadcast({ type: "chat-cleared" });
    this.broadcast({ type: "agents", agents });
    return { ok: true };
  }

  async sendOne(agent, message, attachments = []) {
    try {
      if (!agent.url) throw new Error("URL is empty");
      this.emitStatus(agent.id, "sending");
      const page = await this.ensurePage(agent);
      if (!page.url() || page.url() === "about:blank") {
        await page.goto(agent.url, { waitUntil: "domcontentloaded" });
      }

      await this.uploadAttachments(page, agent, attachments);
      const outgoingMessage = this.withAgentRule(agent, message);
      await this.fillAndSend(page, agent, this.normalizeOutgoingMessage(agent, outgoingMessage, attachments));
      await this.handleAfterSubmit(page, agent);
      this.broadcast({ type: "message-sent", agentId: agent.id, message: this.formatSentMessage(outgoingMessage, attachments) });
      this.emitStatus(agent.id, "waiting");
      const reply = await this.waitForReply(page, agent, attachments.length > 0 ? ATTACHMENT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
      this.lastReplies.set(agent.id, reply);
      this.emitStatus(agent.id, "done");
      this.broadcast({ type: "chat-result", agentId: agent.id, reply });
      return { agentId: agent.id, ok: true, reply };
    } catch (error) {
      this.emitStatus(agent.id, "error");
      this.broadcast({ type: "chat-error", agentId: agent.id, error: error.message });
      return { agentId: agent.id, ok: false, error: error.message };
    }
  }

  normalizeOutgoingMessage(agent, message, attachments) {
    if (message?.trim()) return message;
    if (attachments?.length && agent.modelKey === "gemini") {
      return "请分析我上传的文件，并给出清晰、完整的结论。";
    }
    return message;
  }

  withAgentRule(agent, message) {
    const rule = typeof agent.systemPrompt === "string" ? agent.systemPrompt.trim() : "";
    if (!rule) return message;

    const body = typeof message === "string" ? message.trim() : "";
    return [
      "请严格遵守以下规则提示：",
      rule,
      "",
      "用户消息：",
      body
    ].join("\n");
  }

  buildMessage(agent, agents, message, shareContext) {
    if (!shareContext) return message;

    const peers = agents.filter((item) => item.id !== agent.id);
    const peerNames = peers.map((item) => item.name).join(", ") || "none";
    const previousReplies = peers
      .map((item) => {
        const reply = this.lastReplies.get(item.id);
        return reply ? `${item.name}: ${reply}` : `${item.name}: no previous reply`;
      })
      .join("\n");

    return [
      "You are participating in a web AI group chat.",
      `Other active AIs: ${peerNames}`,
      "Previous replies from other AIs:",
      previousReplies || "none",
      "",
      "User message:",
      message
    ].join("\n");
  }

  buildCompareMessage(selfAgent, peerAgent, peerReply, instruction) {
    return [
      "You are participating in a web AI group chat.",
      `${peerAgent.name} gave this answer:`,
      peerReply,
      "",
      "Task:",
      instruction,
      "",
      `Compare ${peerAgent.name}'s answer with your own previous answer. Point out agreements, differences, strengths, weaknesses, and give a concise improved conclusion.`
    ].join("\n");
  }

  buildSummaryMessage(targetAgent, targetReply, sources, instruction) {
    const sourceText = sources
      .map(({ agent, reply }, index) => [`${index + 1}. ${agent.name}:`, reply].join("\n"))
      .join("\n\n");

    return [
      "You are participating in a web AI group chat.",
      targetReply ? `Your own previous answer (${targetAgent.name}):\n${targetReply}` : `You are ${targetAgent.name}.`,
      "",
      "Other AI answers to summarize:",
      sourceText,
      "",
      "Task:",
      instruction
    ].join("\n");
  }

  async fillAndSend(page, agent, message) {
    const inputSelector = agent.selectors?.input;
    if (!inputSelector) throw new Error("Input selector is missing");

    const input = await this.firstVisible(page.locator(inputSelector), "input");
    await input.click();
    if (message) {
      await input.fill(message).catch(async () => {
        await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await input.type(message);
      });
    }

    if (agent.submitMode === "enter") {
      await input.press("Enter");
      return;
    }

    const sendSelector = agent.selectors?.sendButton;
    if (sendSelector && agent.submitMode !== "enter") {
      const sendButton = await this.firstEnabledVisible(page.locator(sendSelector), "send button", 45_000).catch(() => null);
      if (sendButton) {
        await sendButton.scrollIntoViewIfNeeded().catch(() => {});
        await sendButton.click();
        return;
      }
    }

    await input.press("Enter");
  }

  async uploadAttachments(page, agent, attachments) {
    if (!attachments?.length) return;

    const uploadSelector = agent.selectors?.uploadInput ?? "input[type='file']";
    for (const attachment of attachments) {
      if (agent.selectors?.uploadButton) {
        const uploaded = await this.uploadWithFileChooser(page, agent, attachment).catch(() => false);
        if (uploaded) {
          await page.waitForTimeout(1600);
          continue;
        }
      }
      await this.setFileOnBestInput(page, uploadSelector, attachment);
      await page.waitForTimeout(1600);
    }
    if (agent.modelKey === "gemini") await page.waitForTimeout(3500);
  }

  async uploadWithFileChooser(page, agent, attachment) {
    const uploadButton = await this.firstVisible(page.locator(agent.selectors.uploadButton), "upload button", 7000);
    await uploadButton.scrollIntoViewIfNeeded().catch(() => {});
    await uploadButton.click();

    const directChooser = await page.waitForEvent("filechooser", { timeout: 1200 }).catch(() => null);
    if (directChooser) {
      await directChooser.setFiles(attachment.path);
      return true;
    }

    const menuSelector = agent.selectors?.uploadMenuItem ?? [
      "[role='menuitem']:has-text('Upload files')",
      "[role='menuitem']:has-text('上传文件')",
      "button:has-text('Upload files')",
      "button:has-text('上传文件')",
      "div:has-text('Upload files')",
      "div:has-text('上传文件')"
    ].join(", ");
    const menuItem = await this.firstVisible(page.locator(menuSelector), "upload menu item", 5000);
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
    await menuItem.click();
    const chooser = await chooserPromise;
    await chooser.setFiles(attachment.path);
    return true;
  }

  async setFileOnBestInput(page, selector, attachment) {
    const locator = page.locator(selector);
    const deadline = Date.now() + 15_000;
    let lastError = null;

    while (Date.now() < deadline) {
      const count = await locator.count().catch(() => 0);
      const candidates = [];
      for (let index = count - 1; index >= 0; index -= 1) {
        const candidate = locator.nth(index);
        const handle = await candidate.elementHandle().catch(() => null);
        if (!handle) continue;
        const accept = await candidate.getAttribute("accept").catch(() => "");
        candidates.push({ candidate, score: scoreFileInput(accept, attachment) });
      }

      candidates.sort((left, right) => right.score - left.score);
      for (const { candidate } of candidates) {
        try {
          await candidate.setInputFiles(attachment.path);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`No usable file input found for ${attachment.name}${lastError ? `: ${lastError.message}` : ""}`);
  }

  async firstAttached(locator, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const candidate = locator.nth(index);
        const handle = await candidate.elementHandle().catch(() => null);
        if (handle) return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`No ${label} found`);
  }

  formatSentMessage(message, attachments) {
    const attachmentLines = (attachments ?? []).map((item) => `[${item.kind ?? "附件"}: ${item.name}]`);
    return [message, ...attachmentLines].filter(Boolean).join("\n");
  }

  async handleAfterSubmit(page, agent) {
    const skipSelector = agent.selectors?.skipButton;
    if (!skipSelector) return;
    const skipButton = await this.firstVisible(page.locator(skipSelector), "skip button", 12_000).catch(() => null);
    if (!skipButton) return;
    await skipButton.click().catch(() => {});
  }

  async firstVisible(locator, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`No visible ${label} found`);
  }

  async firstEnabledVisible(locator, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        const enabled = await candidate.isEnabled().catch(() => false);
        if (visible && enabled) return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`No enabled ${label} found`);
  }

  async waitForReply(page, agent, timeout = DEFAULT_TIMEOUT_MS) {
    const before = await this.safeReadLatestReply(page, agent);
    const start = Date.now();
    let latest = before;
    let lastChangedAt = Date.now();

    while (Date.now() - start < timeout) {
      await page.waitForTimeout(1500);
      const current = await this.safeReadLatestReply(page, agent);
      if (current && current !== latest) {
        latest = current;
        lastChangedAt = Date.now();
      }
      if (latest && latest !== before && Date.now() - lastChangedAt >= REPLY_STABLE_MS) return latest;
    }

    if (latest && latest !== before) return latest;
    throw new Error("Timed out waiting for reply");
  }

  async readLatestReply(page, agent) {
    const reply = await this.safeReadLatestReply(page, agent);
    if (!reply) throw new Error("No reply text found");
    return reply;
  }

  async safeReadLatestReply(page, agent) {
    const replySelector = agent.selectors?.reply;
    if (!replySelector) throw new Error("Reply selector is missing");

    const locator = page.locator(replySelector);
    const count = await locator.count().catch(() => 0);
    if (count === 0) return "";

    const candidates = [];
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const text = normalizeReply(await candidate.innerText({ timeout: 5000 }).catch(() => ""));
      if (isUsableReply(text, agent)) candidates.push(text);
    }
    return chooseBestReply(candidates);
  }

  async ensurePage(agent) {
    if (this.pages.has(agent.id) && !this.pages.get(agent.id).isClosed()) return this.pages.get(agent.id);

    await fs.mkdir(this.profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(path.join(this.profileDir, agent.id), {
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"]
    });
    const page = context.pages()[0] ?? await context.newPage();
    this.contexts.set(agent.id, context);
    this.pages.set(agent.id, page);
    return page;
  }

  async close() {
    await Promise.all([...this.contexts.values()].map((context) => context.close().catch(() => {})));
  }

  async requireAgent(id) {
    const agent = (await this.readConfig()).find((item) => item.id === id);
    if (!agent) throw new Error("AI not found");
    return agent;
  }

  async readConfig() {
    const raw = await fs.readFile(this.configPath, "utf8");
    return JSON.parse(raw).slice(0, 5);
  }

  async writeConfig(agents) {
    await fs.writeFile(this.configPath, `${JSON.stringify(agents.slice(0, 5), null, 2)}\n`, "utf8");
  }

  emitStatus(agentId, status) {
    this.status.set(agentId, status);
    this.broadcast({ type: "agent-status", agentId, status });
  }
}

function sanitizeString(value, fallback) {
  return typeof value === "string" ? value.trim() : fallback;
}

function sanitizeOptionalString(value, fallback = "") {
  if (typeof value !== "string") return fallback ?? "";
  return value.trim().slice(0, 6000);
}

function clonePreset(preset) {
  return JSON.parse(JSON.stringify(preset));
}

function sanitizeSubmitMode(value, fallback) {
  return value === "enter" || value === "button" || value === "auto" ? value : fallback ?? "auto";
}

function sanitizeCompareInstruction(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "请分析对方回答，并和你自己上一条回答做对比，指出共同点、差异、优缺点，最后给出更好的综合答案。";
}

function sanitizeSummaryInstruction(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "请综合这些 AI 的回答，提炼共同结论、主要分歧、各自优缺点，最后给出一份更完整、更可靠的汇总答案。";
}

function scoreFileInput(accept, attachment) {
  const text = String(accept ?? "").toLowerCase();
  if (!text) return 10;
  const name = String(attachment.name ?? "").toLowerCase();
  const mimeType = String(attachment.mimeType ?? "").toLowerCase();
  if (text.includes(mimeType)) return 100;
  if (attachment.kind === "图片" && text.includes("image")) return 90;
  const extension = path.extname(name);
  if (extension && text.includes(extension)) return 80;
  if (text.includes("*")) return 20;
  return 1;
}

function normalizeReply(text) {
  return text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isUsableReply(text, agent) {
  if (!text || text.length < 2) return false;
  const blocked = [
    "Google AI Plus",
    "Gemini",
    "\u5347\u7ea7\u5230 Google AI Plus",
    "\u53d1\u8d77\u65b0\u5bf9\u8bdd",
    "\u6211\u7684\u5185\u5bb9",
    "\u7b14\u8bb0\u672c",
    "\u65b0\u5efa\u7b14\u8bb0\u672c",
    "\u8bbe\u7f6e\u548c\u5e2e\u52a9",
    "\u4e0e Gemini \u5bf9\u8bdd"
  ];
  const blockedHits = blocked.filter((item) => text.includes(item)).length;
  if (blockedHits >= 2) return false;
  if (/^(Gemini|Gem|Pro|\u5de5\u5177|\u5bf9\u8bdd|\u6211\u7684\u5185\u5bb9|\u7b14\u8bb0\u672c)$/.test(text)) return false;
  if (text.includes("\u6b63\u5728\u641c\u7d22\u7f51\u7edc") || text === "\u8df3\u8fc7") return false;
  if (agent?.modelKey === "gemini" && isGeminiChromeText(text)) return false;
  return true;
}

function isGeminiChromeText(text) {
  const blocked = [
    "Google AI Plus",
    "Gemini Apps",
    "Activity",
    "Extensions",
    "Settings",
    "Help",
    "Privacy",
    "Terms",
    "New chat",
    "Recent",
    "Upload files",
    "Add files",
    "Drag and drop",
    "gemini.google.com"
  ];
  const hits = blocked.filter((item) => text.includes(item)).length;
  if (hits >= 2) return true;
  if (text.length > 3000 && hits >= 1) return true;
  return false;
}

function chooseBestReply(candidates) {
  if (candidates.length === 0) return "";
  const unique = [...new Map(candidates.map((text) => [text, text])).values()];
  unique.sort((left, right) => scoreReply(right) - scoreReply(left));
  return unique[0] ?? "";
}

function scoreReply(text) {
  let score = Math.min(text.length, 4000);
  if (/[。！？.!?]\s*$/.test(text)) score += 80;
  if (text.includes("\n")) score += 60;
  if (text.length > 30) score += 120;
  if (text.length > 120) score += 160;
  if (text.includes("Google AI Plus")) score -= 2000;
  if (text.includes("\u53d1\u8d77\u65b0\u5bf9\u8bdd")) score -= 1500;
  if (text.includes("\u6211\u7684\u5185\u5bb9")) score -= 1000;
  if (text.includes("\u8bbe\u7f6e\u548c\u5e2e\u52a9")) score -= 1000;
  return score;
}

function normalizeSettings(settings) {
  const raw = Number(settings?.displayCount ?? 5);
  const displayCount = Math.min(5, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : 5));
  const sendMode = settings?.sendMode === "polling" ? "polling" : "parallel";
  return { displayCount, sendMode };
}
