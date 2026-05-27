import express from "express";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { AgentManager } from "./lib/agent-manager.js";
import { MODEL_OPTIONS } from "./lib/model-presets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const uploadDir = path.join(rootDir, ".uploads");
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
let tunnel = null;
let tunnelUrl = "";
let tunnelLog = "";
const HERMES_TEMPLATES = {
  reliability: "Compare these replies and identify which answer is most reliable. Explain the evidence, uncertainty, and weak claims.",
  missingPoints: "Find important omissions, blind spots, and risks across these replies. Explain what should be added.",
  finalSummary: "Create a clear final summary that combines the strongest points from all replies and gives a complete conclusion.",
  critique: "Critique these replies. Point out mistakes, unsupported claims, contradictions, and where each answer is weak.",
  actionPlan: "Extract a practical action plan from these replies. Prioritize concrete next steps and decisions."
};
const HERMES_TEMPLATE_LABELS = {
  reliability: "可靠性分析",
  missingPoints: "遗漏点分析",
  finalSummary: "最终汇总",
  critique: "批判性检查",
  actionPlan: "行动计划"
};
const HERMES_TEMPLATE_STATUS = {
  reliability: "比较这些回复，判断哪个答案更可靠，并说明证据、不确定性和薄弱说法。",
  missingPoints: "找出这些回复里的遗漏点、盲区和风险，并说明还应该补充什么。",
  finalSummary: "整合所有回复里的强项，生成一份清晰完整的最终结论。",
  critique: "检查这些回复里的错误、缺少证据的说法、矛盾点和薄弱处。",
  actionPlan: "从这些回复中整理可执行步骤，并按优先级给出下一步建议。"
};
const hermesState = {
  context: [],
  lastReply: "",
  lastError: "",
  busy: false
};
const manager = new AgentManager({
  configPath: path.join(rootDir, "config", "agents.json"),
  settingsPath: path.join(rootDir, "config", "settings.json"),
  hermesSettingsPath: path.join(rootDir, "config", "hermes.json"),
  profileDir: path.join(rootDir, ".browser-profiles"),
  broadcast: (event) => appBroadcast(event)
});

app.use(express.json({ limit: "45mb" }));

app.get("/api/agents", async (_req, res) => {
  res.json(await manager.listAgents());
});

app.get("/api/models", (_req, res) => {
  res.json(MODEL_OPTIONS);
});

app.get("/api/settings", async (_req, res) => {
  res.json(await manager.readSettings());
});

app.put("/api/settings", async (req, res) => {
  try {
    res.json(await manager.updateSettings(req.body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/agents/:id", async (req, res) => {
  try {
    res.json(await manager.updateAgent(req.params.id, req.body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/agents/:id/model", async (req, res) => {
  try {
    res.json(await manager.selectAgentModel(req.params.id, req.body?.modelKey));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/agents/:id/open", async (req, res) => {
  try {
    const agent = await manager.openAgent(req.params.id);
    res.json(agent);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/agents/:id/read", async (req, res) => {
  try {
    const result = await manager.readAgent(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/agents/:id/diagnose", async (req, res) => {
  try {
    res.json(await manager.diagnoseAgent(req.params.id));
  } catch (error) {
    const status = /timeout/i.test(error.message) ? "超时" : "读回失败";
    res.status(400).json({
      agentId: req.params.id,
      ok: false,
      repaired: false,
      status,
      checks: [],
      message: error.message || status
    });
  }
});

app.post("/api/chat/send", async (req, res) => {
  const { message = "", shareContext = false, images = [], files = [] } = req.body ?? {};
  if (
    typeof message !== "string" ||
    !message.trim() && (!Array.isArray(images) || images.length === 0) && (!Array.isArray(files) || files.length === 0)
  ) {
    res.status(400).json({ error: "message or attachment is required" });
    return;
  }

  let attachments = [];
  try {
    attachments = await saveIncomingAttachments(images, files);
    const results = await manager.sendToEnabledAgents(message.trim(), Boolean(shareContext), attachments);
    res.json({ results });
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    await cleanupAttachments(attachments);
  }
});

app.get("/api/config/export", async (_req, res) => {
  try {
    res.json({
      ...(await manager.exportConfiguration()),
      hermes: await readHermesSettings()
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/config/import", async (req, res) => {
  try {
    const result = await manager.importConfiguration(req.body ?? {});
    if (req.body?.hermes && typeof req.body.hermes === "object") {
      const settings = await writeHermesSettings(req.body.hermes);
      appBroadcast({ type: "hermes-settings", settings });
    }
    res.json({ ...result, hermes: await readHermesSettings() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/hermes/state", (_req, res) => {
  res.json(readHermesState());
});

app.get("/api/hermes/settings", async (_req, res) => {
  res.json(await readHermesSettings());
});

app.put("/api/hermes/settings", async (req, res) => {
  try {
    const settings = await writeHermesSettings(req.body ?? {});
    appBroadcast({ type: "hermes-settings", settings });
    res.json(settings);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/hermes/conversations", async (_req, res) => {
  try {
    res.json(await listHermesConversations());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/hermes/send", async (req, res) => {
  const { message = "" } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const settings = await readHermesSettings();
    if (settings.target) {
      const result = await sendHermesPlatformMessage(settings.target, message.trim(), settings.runtime);
      rememberHermesContext("user", `Sent to ${settings.targetLabel || settings.target}`, message.trim());
      hermesState.lastReply = `Sent to ${settings.targetLabel || settings.target}`;
      hermesState.lastError = "";
      appBroadcast({ type: "hermes-state", state: readHermesState() });
      res.json({ reply: hermesState.lastReply, result, state: readHermesState() });
      return;
    }

    rememberHermesContext("user", "Sent to Hermes", message.trim());
    appBroadcast({ type: "hermes-state", state: readHermesState() });
    const reply = await runHermes([
      "You are the Hermes assistant inside a web AI group chat.",
      "Reply directly to this user message:",
      "",
      message.trim()
    ].join("\n"), settings.runtime);
    rememberHermesContext("hermes", "Hermes reply", reply);
    hermesState.lastReply = reply;
    hermesState.lastError = "";
    appBroadcast({ type: "hermes-state", state: readHermesState() });
    res.json({ reply, state: readHermesState() });
  } catch (error) {
    hermesState.lastError = error.message;
    appBroadcast({ type: "hermes-state", state: readHermesState() });
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/hermes/analyze", async (req, res) => {
  const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
  const template = typeof req.body?.template === "string" ? req.body.template : "";
  const templateInstruction = HERMES_TEMPLATES[template] ?? "";
  const templateLabel = HERMES_TEMPLATE_LABELS[template] ?? "";
  const templateStatus = HERMES_TEMPLATE_STATUS[template] ?? "";
  const finalInstruction = [templateInstruction, instruction].filter(Boolean).join("\n");
  const settings = await manager.readSettings();
  const collected = (await manager.listAgents())
    .slice(0, settings.displayCount)
    .filter((agent) => typeof agent.lastReply === "string" && agent.lastReply.trim())
    .map((agent) => ({
      id: crypto.randomUUID(),
      role: "ai",
      title: agent.name,
      text: agent.lastReply.trim(),
      status: "collected",
      time: new Date().toLocaleTimeString()
    }));

  const context = collected
    .map((item) => [`[${item.time}] ${item.title}`, item.text].join("\n"))
    .join("\n\n---\n\n");

  if (!context.trim()) {
    res.status(400).json({ error: "Hermes context is empty" });
    return;
  }

  try {
    const hermesSettings = await readHermesSettings();
    rememberHermesContext(
      "status",
      templateLabel || "自定义分析",
      [
        `已读取：${collected.map((item) => item.title).join("、")}`,
        `状态：本次收集到 ${collected.length} 个 AI 回复。`,
        templateStatus ? `分析要求：${templateStatus}` : "",
        !templateStatus && instruction ? `分析要求：${instruction}` : ""
      ].filter(Boolean).join("\n")
    );
    appBroadcast({ type: "hermes-state", state: readHermesState() });
    const reply = await runHermes([
      "You are the Hermes summary and analysis assistant inside a web AI group chat.",
      "The following content contains replies read back from the AI models. Analyze them and provide a clear, complete conclusion.",
      finalInstruction ? `User analysis request: ${finalInstruction}` : "",
      "",
      context
    ].join("\n"), hermesSettings.runtime);
    rememberHermesContext("hermes", "Hermes full analysis", reply);
    hermesState.lastReply = reply;
    hermesState.lastError = "";
    appBroadcast({ type: "hermes-state", state: readHermesState() });
    res.json({ reply, state: readHermesState() });
  } catch (error) {
    hermesState.lastError = error.message;
    appBroadcast({ type: "hermes-state", state: readHermesState() });
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/hermes/clear", (_req, res) => {
  hermesState.context = [];
  hermesState.lastReply = "";
  hermesState.lastError = "";
  appBroadcast({ type: "hermes-state", state: readHermesState() });
  res.json(readHermesState());
});

app.post("/api/chat/compare", async (req, res) => {
  try {
    const { sourceAgentId, targetAgentId, instruction } = req.body ?? {};
    if (!sourceAgentId || !targetAgentId) {
      res.status(400).json({ error: "sourceAgentId and targetAgentId are required" });
      return;
    }

    const results = await manager.compareAgentReplies(sourceAgentId, targetAgentId, instruction);
    res.json({ results });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/chat/summarize", async (req, res) => {
  try {
    const { targetAgentId, sourceAgentIds, instruction } = req.body ?? {};
    if (!targetAgentId || !Array.isArray(sourceAgentIds) || sourceAgentIds.length === 0) {
      res.status(400).json({ error: "targetAgentId and sourceAgentIds are required" });
      return;
    }

    const result = await manager.summarizeAgentReplies(targetAgentId, sourceAgentIds, instruction);
    res.json({ result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/chat/clear", async (_req, res) => {
  res.json(await manager.clearChat());
});

app.post("/api/app/shutdown", async (_req, res) => {
  res.json({ ok: true });
  setTimeout(async () => {
    await shutdown();
    process.exit(0);
  }, 100);
});

app.get("/api/network", (_req, res) => {
  res.json(getNetworkInfo());
});

app.post("/api/network/tunnel/start", async (_req, res) => {
  try {
    if (tunnel && tunnelUrl) {
      res.json(getNetworkInfo());
      return;
    }
    const target = `http://localhost:${Number(process.env.PUBLIC_PORT ?? 5173)}`;
    const network = await startCloudflareTunnel(target);
    res.json(network);
  } catch (error) {
    stopCloudflareTunnel();
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/network/tunnel/restart", async (_req, res) => {
  try {
    stopCloudflareTunnel();
    const target = `http://localhost:${Number(process.env.PUBLIC_PORT ?? 5173)}`;
    const network = await startCloudflareTunnel(target);
    res.json(network);
  } catch (error) {
    stopCloudflareTunnel();
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/network/tunnel/stop", async (_req, res) => {
  stopCloudflareTunnel();
  const network = getNetworkInfo();
  broadcast({ type: "network", network });
  res.json(network);
});

async function startCloudflareTunnel(target) {
  stopCloudflareTunnel();
  tunnelLog = "";
  tunnelUrl = "";
  tunnel = spawn("cloudflared", ["tunnel", "--url", target], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  tunnel.on("close", () => {
    tunnel = null;
    tunnelUrl = "";
    broadcast({ type: "network", network: getNetworkInfo() });
  });

  const onData = (chunk) => {
    tunnelLog += chunk.toString();
    const match = tunnelLog.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !tunnelUrl) {
      tunnelUrl = match[0];
      broadcast({ type: "network", network: getNetworkInfo() });
    }
  };
  tunnel.stdout.on("data", onData);
  tunnel.stderr.on("data", onData);

  const started = await waitForTunnelUrl();
  broadcast({ type: "network", network: started });
  return started;
}

function appBroadcast(event) {
  rememberHermesEvent(event);
  broadcast(event);
}

function rememberHermesEvent(event) {
  if (event?.type === "chat-cleared") {
    hermesState.context = [];
    hermesState.lastReply = "";
    hermesState.lastError = "";
    broadcast({ type: "hermes-state", state: readHermesState() });
  }
}

function rememberHermesContext(role, title, text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return;
  hermesState.context.push({
    id: crypto.randomUUID(),
    role,
    title,
    text: value,
    time: new Date().toLocaleTimeString()
  });
  hermesState.context = hermesState.context.slice(-80);
}

function readHermesState() {
  return {
    context: hermesState.context,
    lastReply: hermesState.lastReply,
    lastError: hermesState.lastError,
    busy: hermesState.busy,
    available: Boolean(findHermesExecutable())
  };
}

async function readHermesSettings() {
  const file = path.join(rootDir, "config", "hermes.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    return normalizeHermesSettings(JSON.parse(raw));
  } catch {
    return normalizeHermesSettings({});
  }
}

async function writeHermesSettings(patch) {
  const file = path.join(rootDir, "config", "hermes.json");
  const current = await readHermesSettings();
  const next = normalizeHermesSettings({ ...current, ...patch });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function normalizeHermesSettings(value) {
  const runtime = ["auto", "wsl", "windows"].includes(value?.runtime) ? value.runtime : "wsl";
  return {
    runtime,
    target: typeof value?.target === "string" ? value.target.trim().slice(0, 300) : "",
    targetLabel: typeof value?.targetLabel === "string" ? value.targetLabel.trim().slice(0, 300) : "",
    sessionId: typeof value?.sessionId === "string" ? value.sessionId.trim().slice(0, 120) : ""
  };
}

async function listHermesConversations() {
  const settings = await readHermesSettings();
  const runtimes = settings.runtime === "auto" ? ["wsl", "windows"] : [settings.runtime];
  const errors = [];
  for (const runtime of runtimes) {
    try {
      const result = runtime === "wsl" ? await listWslHermesConversations() : await listWindowsHermesConversations();
      if (result.conversations.length || result.channels.length) return { ...result, runtime };
    } catch (error) {
      errors.push(`${runtime}: ${error.message}`);
    }
  }
  return { runtime: settings.runtime, conversations: [], channels: [], error: errors.join("\n") };
}

async function listWslHermesConversations() {
  const script = `
import json
from pathlib import Path
home = Path("/home/hermes/.hermes")
sessions_file = home / "sessions" / "sessions.json"
channels_file = home / "channel_directory.json"
sessions = {}
channels = {}
if sessions_file.exists():
    sessions = json.loads(sessions_file.read_text(encoding="utf-8"))
if channels_file.exists():
    channels = json.loads(channels_file.read_text(encoding="utf-8"))
conversations = []
for key, entry in sessions.items():
    origin = entry.get("origin", {})
    platform = entry.get("platform") or origin.get("platform", "")
    chat_id = origin.get("chat_id", "")
    target = f"{platform}:{chat_id}" if platform and chat_id else ""
    conversations.append({
        "sessionKey": key,
        "target": target,
        "platform": platform,
        "chatType": entry.get("chat_type") or origin.get("chat_type", ""),
        "name": entry.get("display_name") or origin.get("chat_name") or origin.get("user_name") or chat_id or key,
        "updatedAt": entry.get("updated_at", "")
    })
conversations.sort(key=lambda x: x.get("updatedAt", ""), reverse=True)
channel_items = []
for platform, items in channels.items():
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            chat_id = item.get("id") or item.get("chat_id") or ""
            channel_items.append({
                "target": f"{platform}:{chat_id}" if chat_id else platform,
                "platform": platform,
                "name": item.get("name") or item.get("display_name") or chat_id or platform,
                "chatType": item.get("type", "")
            })
print(json.dumps({"conversations": conversations[:80], "channels": channel_items[:80]}, ensure_ascii=False))
`;
  return JSON.parse(await runWslPython(script));
}

async function listWindowsHermesConversations() {
  const home = process.env.HERMES_HOME;
  if (!home) return { conversations: [], channels: [] };
  const sessionsPath = path.join(home, "sessions", "sessions.json");
  const channelsPath = path.join(home, "channel_directory.json");
  const sessions = await readJsonIfExists(sessionsPath, {});
  const channels = await readJsonIfExists(channelsPath, {});
  const conversations = Object.entries(sessions).map(([key, entry]) => {
    const origin = entry.origin ?? {};
    const platform = entry.platform ?? origin.platform ?? "";
    const chatId = origin.chat_id ?? "";
    return {
      sessionKey: key,
      target: platform && chatId ? `${platform}:${chatId}` : "",
      platform,
      chatType: entry.chat_type ?? origin.chat_type ?? "",
      name: entry.display_name ?? origin.chat_name ?? origin.user_name ?? chatId ?? key,
      updatedAt: entry.updated_at ?? ""
    };
  }).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const channelItems = [];
  for (const [platform, items] of Object.entries(channels)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const chatId = item.id ?? item.chat_id ?? "";
      channelItems.push({
        target: chatId ? `${platform}:${chatId}` : platform,
        platform,
        name: item.name ?? item.display_name ?? chatId ?? platform,
        chatType: item.type ?? ""
      });
    }
  }
  return { conversations: conversations.slice(0, 80), channels: channelItems.slice(0, 80) };
}

async function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function sendHermesPlatformMessage(target, message, runtime = "auto") {
  const mode = runtime === "windows" ? "windows" : "wsl";
  const script = `
import base64, json, sys
from tools.send_message_tool import send_message_tool
target = base64.b64decode(sys.argv[1]).decode("utf-8")
message = base64.b64decode(sys.argv[2]).decode("utf-8")
print(send_message_tool({"action": "send", "target": target, "message": message}))
`;
  const target64 = Buffer.from(target, "utf8").toString("base64");
  const message64 = Buffer.from(message, "utf8").toString("base64");
  const raw = mode === "wsl"
    ? await runWslPython(script, [target64, message64])
    : await runWindowsPython(script, [target64, message64]);
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function runWslPython(script, args = []) {
  return runCommand("wsl", ["-d", "Ubuntu", "--", "bash", "-lc", `cd /home/hermes/.hermes/hermes-agent && ./venv/bin/python - ${args.map(shellQuote).join(" ")}`], script);
}

function runWindowsPython(script, args = []) {
  const python = process.env.HERMES_HOME
    ? path.join(process.env.HERMES_HOME, "hermes-agent", "venv", "Scripts", "python.exe")
    : "python";
  const cwd = process.env.HERMES_HOME ? path.join(process.env.HERMES_HOME, "hermes-agent") : rootDir;
  return runCommand(python, ["-", ...args], script, cwd);
}

function runCommand(command, args, input = "", cwd = rootDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        NO_COLOR: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stripAnsi(stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function findHermesExecutable() {
  if (process.env.HERMES_HOME) {
    return path.join(process.env.HERMES_HOME, "hermes-agent", "venv", "Scripts", "hermes.exe");
  }
  return "hermes.exe";
}

async function runHermes(prompt, runtime = "wsl") {
  hermesState.busy = true;
  appBroadcast({ type: "hermes-state", state: readHermesState() });

  try {
    const settings = await readHermesSettings();
    const result = runtime === "windows"
      ? await runWindowsHermesChat(prompt, settings.sessionId)
      : await runWslHermesChat(prompt, settings.sessionId);

    if (result.sessionId && result.sessionId !== settings.sessionId) {
      await writeHermesSettings({ sessionId: result.sessionId, runtime: runtime === "windows" ? "windows" : "wsl" });
      appBroadcast({ type: "hermes-settings", settings: await readHermesSettings() });
    }
    return result.reply;
  } finally {
    hermesState.busy = false;
    appBroadcast({ type: "hermes-state", state: readHermesState() });
  }
}

async function runWslHermesChat(prompt, sessionId = "") {
  const script = `
import base64, json, os, subprocess, sys
prompt = base64.b64decode(sys.argv[1]).decode("utf-8")
session_id = base64.b64decode(sys.argv[2]).decode("utf-8") if len(sys.argv) > 2 else ""
cmd = ["./venv/bin/hermes", "chat", "-Q", "--source", "tool"]
if session_id:
    cmd += ["--resume", session_id]
cmd += ["-q", prompt]
env = dict(os.environ)
env["PYTHONIOENCODING"] = "utf-8"
env["PYTHONUTF8"] = "1"
env["NO_COLOR"] = "1"
proc = subprocess.run(cmd, cwd="/home/hermes/.hermes/hermes-agent", text=True, capture_output=True, env=env)
print(json.dumps({"code": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}, ensure_ascii=False))
`;
  const prompt64 = Buffer.from(prompt.slice(0, 24_000), "utf8").toString("base64");
  const session64 = Buffer.from(sessionId, "utf8").toString("base64");
  return parseHermesChatResult(JSON.parse(await runWslPython(script, [prompt64, session64])));
}

function runWindowsHermesChat(prompt, sessionId = "") {
  return new Promise((resolve, reject) => {
    const hermesExe = findHermesExecutable();
    const args = ["chat", "-Q", "--source", "tool"];
    if (sessionId) args.push("--resume", sessionId);
    args.push("-q", prompt.slice(0, 24_000));
    const child = spawn(hermesExe, args, {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        NO_COLOR: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(parseHermesChatResult({ code, stdout, stderr }));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseHermesChatResult(result) {
  const output = stripAnsi(result.stdout ?? "").trim();
  const errorText = stripAnsi(result.stderr ?? "").trim();
  const combined = [output, errorText].filter(Boolean).join("\n");
  const sessionId = combined.match(/session_id:\s*([A-Za-z0-9_-]+)/i)?.[1] ?? "";
  const reply = output
    .split(/\r?\n/)
    .filter((line) => !/^\s*session_id:/i.test(line))
    .filter((line) => !line.includes("Stripped provider prefix"))
    .join("\n")
    .trim();
  if (Number(result.code) === 0 && reply) return { reply, sessionId };
  throw new Error(errorText || reply || `Hermes exited with code ${result.code}`);
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

function waitForTunnelUrl() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (tunnelUrl) {
        clearInterval(timer);
        resolve(getNetworkInfo());
        return;
      }
      if (!tunnel) {
        clearInterval(timer);
        reject(new Error(tunnelLog || "cloudflared stopped before producing a URL"));
        return;
      }
      if (Date.now() - startedAt > 30_000) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for Cloudflare Tunnel URL"));
      }
    }, 250);
  });
}

function stopCloudflareTunnel() {
  if (tunnel) {
    tunnel.kill();
    tunnel = null;
  }
  tunnelUrl = "";
}

const distDir = path.join(rootDir, "dist");
app.use(express.static(distDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"), (error) => {
    if (error) res.status(404).send("Run npm run dev for the development UI, or npm run build before npm start.");
  });
});

wss.on("connection", async (socket) => {
  socket.send(JSON.stringify({ type: "agents", agents: await manager.listAgents() }));
  socket.send(JSON.stringify({ type: "settings", settings: await manager.readSettings() }));
  socket.send(JSON.stringify({ type: "network", network: getNetworkInfo() }));
});

function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

const port = Number(process.env.PORT ?? 5174);
const host = process.env.HOST ?? "0.0.0.0";
server.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

async function shutdown() {
  stopCloudflareTunnel();
  await manager.close();
}

function getNetworkInfo() {
  const frontendPort = Number(process.env.PUBLIC_PORT ?? 5173);
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces ?? []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push(`http://${item.address}:${frontendPort}`);
      }
    }
  }
  return {
    local: `http://127.0.0.1:${frontendPort}`,
    lan: addresses,
    tunnelUrl,
    tunnelProvider: "cloudflare"
  };
}

async function saveIncomingAttachments(images, files) {
  const imageAttachments = await saveIncomingImages(images);
  const fileAttachments = await saveIncomingFiles(files);
  return [...imageAttachments, ...fileAttachments];
}

async function saveIncomingImages(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  if (images.length > 1) throw new Error("Send at most 1 image at a time");

  await fs.mkdir(uploadDir, { recursive: true });
  const saved = [];
  for (const image of images) {
    const name = sanitizeFileName(image?.name ?? "image.png");
    const mimeType = typeof image?.type === "string" ? image.type : "";
    const dataUrl = typeof image?.dataUrl === "string" ? image.dataUrl : "";
    if (!mimeType.startsWith("image/")) throw new Error("Only image files are supported");

    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) throw new Error("Invalid image data");

    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 10 * 1024 * 1024) throw new Error("Image must be 10MB or smaller");

    const filePath = path.join(uploadDir, `${Date.now()}-${crypto.randomUUID()}-${name}`);
    await fs.writeFile(filePath, buffer);
    saved.push({ name, mimeType, path: filePath, kind: "Image" });
  }
  return saved;
}

async function saveIncomingFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  if (files.length > 5) throw new Error("Send at most 5 files at a time");

  await fs.mkdir(uploadDir, { recursive: true });
  const saved = [];
  for (const file of files) {
    const name = sanitizeFileName(file?.name ?? "file");
    const mimeType = typeof file?.type === "string" ? file.type : "application/octet-stream";
    const dataUrl = typeof file?.dataUrl === "string" ? file.dataUrl : "";
    if (!isAllowedDocument(name)) throw new Error("Supported files: PDF, Word, Excel, PPT, TXT, CSV, Markdown");

    const match = dataUrl.match(/^data:([^;]*);base64,(.+)$/);
    if (!match) throw new Error("Invalid file data");

    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 25 * 1024 * 1024) throw new Error("File must be 25MB or smaller");

    const filePath = path.join(uploadDir, `${Date.now()}-${crypto.randomUUID()}-${name}`);
    await fs.writeFile(filePath, buffer);
    saved.push({ name, mimeType, path: filePath, kind: "File" });
  }
  return saved;
}

async function cleanupAttachments(attachments) {
  await Promise.all((attachments ?? []).map((item) => fs.unlink(item.path).catch(() => {})));
}

function sanitizeFileName(name) {
  const cleaned = String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return cleaned || "image.png";
}

function isAllowedDocument(name) {
  const lowerName = String(name).toLowerCase();
  return [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".md"].some((extension) => lowerName.endsWith(extension));
}

