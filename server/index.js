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
const manager = new AgentManager({
  configPath: path.join(rootDir, "config", "agents.json"),
  settingsPath: path.join(rootDir, "config", "settings.json"),
  profileDir: path.join(rootDir, ".browser-profiles"),
  broadcast: (event) => broadcast(event)
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
  if (images.length > 1) throw new Error("一次最多发送 1 张图片");

  await fs.mkdir(uploadDir, { recursive: true });
  const saved = [];
  for (const image of images) {
    const name = sanitizeFileName(image?.name ?? "image.png");
    const mimeType = typeof image?.type === "string" ? image.type : "";
    const dataUrl = typeof image?.dataUrl === "string" ? image.dataUrl : "";
    if (!mimeType.startsWith("image/")) throw new Error("只能发送图片文件");

    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) throw new Error("图片数据无效");

    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 10 * 1024 * 1024) throw new Error("图片不能超过 10MB");

    const filePath = path.join(uploadDir, `${Date.now()}-${crypto.randomUUID()}-${name}`);
    await fs.writeFile(filePath, buffer);
    saved.push({ name, mimeType, path: filePath, kind: "图片" });
  }
  return saved;
}

async function saveIncomingFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  if (files.length > 5) throw new Error("一次最多发送 5 个文件");

  await fs.mkdir(uploadDir, { recursive: true });
  const saved = [];
  for (const file of files) {
    const name = sanitizeFileName(file?.name ?? "file");
    const mimeType = typeof file?.type === "string" ? file.type : "application/octet-stream";
    const dataUrl = typeof file?.dataUrl === "string" ? file.dataUrl : "";
    if (!isAllowedDocument(name)) throw new Error("支持 PDF、Word、Excel、PPT、TXT、CSV 文件");

    const match = dataUrl.match(/^data:([^;]*);base64,(.+)$/);
    if (!match) throw new Error("文件数据无效");

    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 25 * 1024 * 1024) throw new Error("文件不能超过 25MB");

    const filePath = path.join(uploadDir, `${Date.now()}-${crypto.randomUUID()}-${name}`);
    await fs.writeFile(filePath, buffer);
    saved.push({ name, mimeType, path: filePath, kind: "文件" });
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
