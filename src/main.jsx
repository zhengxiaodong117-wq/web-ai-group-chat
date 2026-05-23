import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const statusLabels = {
  unopened: "未打开",
  opening: "打开中",
  ready: "可发送",
  sending: "发送中",
  waiting: "等待回复",
  reading: "读取中",
  done: "完成",
  error: "失败"
};

const statusTone = {
  unopened: "idle",
  opening: "working",
  ready: "ready",
  sending: "working",
  waiting: "working",
  reading: "working",
  done: "ready",
  error: "error"
};

function App() {
  const [agents, setAgents] = useState([]);
  const [models, setModels] = useState([]);
  const [settings, setSettings] = useState({ displayCount: 3, sendMode: "parallel" });
  const [network, setNetwork] = useState({ local: "", lan: [], tunnelUrl: "" });
  const [accessMode, setAccessMode] = useState("local");
  const [message, setMessage] = useState("");
  const [image, setImage] = useState(null);
  const [fileAttachments, setFileAttachments] = useState([]);
  const [shareContext, setShareContext] = useState(false);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [error, setError] = useState("");
  const [copiedReplyId, setCopiedReplyId] = useState("");
  const [readingAgentId, setReadingAgentId] = useState("");
  const [compareDialog, setCompareDialog] = useState(null);
  const [compareTargetId, setCompareTargetId] = useState("");
  const [compareInstruction, setCompareInstruction] = useState("请分析对方回答，并和你自己上一条回答做对比，指出共同点、差异、优缺点，最后给出更好的综合答案。");
  const [summaryDialog, setSummaryDialog] = useState(null);
  const [summarySourceIds, setSummarySourceIds] = useState([]);
  const [summaryInstruction, setSummaryInstruction] = useState("请综合这些 AI 的回答，提炼共同结论、主要分歧、各自优缺点，最后给出一份更完整、更可靠的汇总答案。");
  const [ruleDialog, setRuleDialog] = useState(null);
  const [rulePrompt, setRulePrompt] = useState("");
  const [hermesMode, setHermesMode] = useState(false);
  const [hermesOpen, setHermesOpen] = useState(false);
  const [hermesState, setHermesState] = useState({ context: [], lastReply: "", lastError: "", busy: false, available: false });
  const [hermesSettings, setHermesSettings] = useState({ runtime: "wsl", target: "", targetLabel: "" });
  const [hermesTargets, setHermesTargets] = useState({ runtime: "wsl", conversations: [], channels: [] });
  const [hermesConfigOpen, setHermesConfigOpen] = useState(false);
  const [hermesConfigBusy, setHermesConfigBusy] = useState(false);
  const [hermesDraft, setHermesDraft] = useState("");
  const [hermesWindow, setHermesWindow] = useState(() => readHermesWindow());
  const [hermesMaximized, setHermesMaximized] = useState(false);
  const dragState = useRef(null);

  useEffect(() => {
    loadInitialState();
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "agents") setAgents(data.agents);
      if (data.type === "settings") setSettings(data.settings);
      if (data.type === "network") setNetwork(data.network);
      if (data.type === "agent-status") {
        setAgents((items) => items.map((item) => item.id === data.agentId ? { ...item, status: data.status } : item));
      }
      if (data.type === "message-sent") {
        setAgents((items) => items.map((item) => item.id === data.agentId ? { ...item, lastSent: data.message, lastError: "" } : item));
      }
      if (data.type === "chat-result") {
        setAgents((items) => items.map((item) => item.id === data.agentId ? { ...item, lastReply: data.reply, lastError: "" } : item));
      }
      if (data.type === "chat-error") {
        setAgents((items) => items.map((item) => item.id === data.agentId ? { ...item, lastError: data.error } : item));
      }
      if (data.type === "chat-cleared") {
        setMessage("");
        setHistory([]);
        setAgents((items) => items.map((item) => ({ ...item, lastSent: "", lastReply: "", lastError: "" })));
      }
      if (data.type === "hermes-state") setHermesState(data.state);
      if (data.type === "hermes-settings") setHermesSettings(data.settings);
    });
    return () => socket.close();
  }, []);

  const visibleAgents = useMemo(() => agents.slice(0, settings.displayCount), [agents, settings.displayCount]);
  const enabledCount = useMemo(() => visibleAgents.filter((agent) => agent.enabled).length, [visibleAgents]);
  const hermesReadableAgents = useMemo(() => visibleAgents.filter((agent) => agent.lastReply), [visibleAgents]);
  const localAddress = useMemo(() => chooseLanAddress(network), [network]);
  const activeUrl = accessMode === "internet" ? network.tunnelUrl : localAddress;
  const networkStopped = accessMode === "internet" && !network.tunnelUrl;

  async function loadInitialState() {
    const [agentsRes, modelsRes, settingsRes, networkRes, hermesRes, hermesSettingsRes] = await Promise.all([
      fetch("/api/agents"),
      fetch("/api/models"),
      fetch("/api/settings"),
      fetch("/api/network"),
      fetch("/api/hermes/state"),
      fetch("/api/hermes/settings")
    ]);
    setAgents(await agentsRes.json());
    setModels(await modelsRes.json());
    setSettings(await settingsRes.json());
    setNetwork(await networkRes.json());
    setHermesState(await hermesRes.json());
    setHermesSettings(await hermesSettingsRes.json());
    refreshHermesTargets();
  }

  async function updateSettings(patch) {
    setError("");
    const next = { ...settings, ...patch };
    setSettings(next);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next)
    });
    if (!res.ok) setError((await res.json()).error ?? "保存设置失败");
  }

  async function selectModel(id, modelKey) {
    setError("");
    const res = await fetch(`/api/agents/${id}/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelKey })
    });
    if (res.ok) setAgents(await res.json());
    else setError((await res.json()).error ?? "切换模型失败");
  }

  async function updateAgent(id, patch) {
    setError("");
    const current = agents.find((agent) => agent.id === id);
    const payload = { ...current, ...patch };
    const res = await fetch(`/api/agents/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "保存失败");
      return;
    }
    await loadInitialState();
  }

  async function openAgent(id) {
    setError("");
    const res = await fetch(`/api/agents/${id}/open`, { method: "POST" });
    if (!res.ok) setError((await res.json()).error ?? "打开失败");
    await loadInitialState();
  }

  async function sendMessage() {
    if ((!message.trim() && !image && fileAttachments.length === 0) || busy) return;
    if (hermesMode) {
      await sendMessageToHermes();
      return;
    }
    setBusy(true);
    setError("");
    const outgoing = message.trim();
    const outgoingImage = image;
    const outgoingFiles = fileAttachments;
    const historyText = [
      outgoing,
      outgoingImage ? `[图片: ${outgoingImage.name}]` : "",
      ...outgoingFiles.map((file) => `[文件: ${file.name}]`)
    ].filter(Boolean).join("\n");
    setHistory((items) => [{ id: crypto.randomUUID(), message: historyText, time: new Date().toLocaleTimeString() }, ...items].slice(0, 8));
    setMessage("");
    setImage(null);
    setFileAttachments([]);

    const res = await fetch("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: outgoing,
        shareContext,
        images: outgoingImage ? [outgoingImage] : [],
        files: outgoingFiles
      })
    });
    if (!res.ok) setError((await res.json()).error ?? "发送失败");
    setBusy(false);
  }

  async function sendMessageToHermes() {
    await sendTextToHermes(message, true);
  }

  async function sendHermesDraft() {
    await sendTextToHermes(hermesDraft, false);
  }

  async function sendTextToHermes(text, fromMainInput) {
    if (!text.trim() || busy || hermesState.busy) return;
    setBusy(true);
    setError("");
    const outgoing = text.trim();
    if (fromMainInput) {
      setHistory((items) => [{ id: crypto.randomUUID(), message: `[Hermes] ${outgoing}`, time: new Date().toLocaleTimeString() }, ...items].slice(0, 8));
      setMessage("");
    } else {
      setHermesDraft("");
    }
    setHermesOpen(true);

    const res = await fetch("/api/hermes/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: outgoing })
    });
    if (res.ok) {
      const data = await res.json();
      setHermesState(data.state);
      setHermesOpen(true);
    } else {
      setError((await res.json()).error ?? "Hermes 发送失败");
    }
    setBusy(false);
  }

  async function analyzeWithHermes(instruction = "") {
    if (busy || hermesState.busy || hermesReadableAgents.length === 0) return;
    setBusy(true);
    setError("");
    const analysisInstruction = typeof instruction === "string" ? instruction.trim() : "";
    const res = await fetch("/api/hermes/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: analysisInstruction })
    });
    if (res.ok) {
      const data = await res.json();
      setHermesState(data.state);
      setHermesOpen(true);
      if (analysisInstruction) setHermesDraft("");
    } else {
      setError((await res.json()).error ?? "Hermes 分析失败");
    }
    setBusy(false);
  }

  async function clearHermes() {
    const res = await fetch("/api/hermes/clear", { method: "POST" });
    if (res.ok) setHermesState(await res.json());
  }

  async function refreshHermesTargets() {
    setHermesConfigBusy(true);
    const res = await fetch("/api/hermes/conversations");
    if (res.ok) setHermesTargets(await res.json());
    else setError((await res.json()).error ?? "读取 Hermes 会话失败");
    setHermesConfigBusy(false);
  }

  async function saveHermesTarget(target, targetLabel) {
    setHermesConfigBusy(true);
    const res = await fetch("/api/hermes/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "wsl", target, targetLabel })
    });
    if (res.ok) setHermesSettings(await res.json());
    else setError((await res.json()).error ?? "保存 Hermes 配置失败");
    setHermesConfigBusy(false);
  }

  function startHermesDrag(event) {
    if (hermesMaximized) return;
    if (event.button !== 0) return;
    if (event.target.closest("button, select, input, textarea")) return;
    dragState.current = {
      x: event.clientX,
      y: event.clientY,
      left: hermesWindow.left,
      top: hermesWindow.top
    };
    window.addEventListener("pointermove", moveHermesWindow);
    window.addEventListener("pointerup", stopHermesDrag, { once: true });
  }

  function moveHermesWindow(event) {
    const state = dragState.current;
    if (!state) return;
    const next = clampHermesWindow({
      ...hermesWindow,
      left: state.left + event.clientX - state.x,
      top: state.top + event.clientY - state.y
    });
    dragState.current.last = next;
    setHermesWindow(next);
  }

  function stopHermesDrag() {
    window.removeEventListener("pointermove", moveHermesWindow);
    if (dragState.current?.last) saveHermesWindow(dragState.current.last);
    dragState.current = null;
  }

  function resizeHermesWindow(width, height) {
    if (hermesMaximized) return;
    const next = clampHermesWindow({ ...hermesWindow, width, height });
    setHermesWindow(next);
    saveHermesWindow(next);
  }

  function toggleHermesMaximize() {
    setHermesMaximized((value) => !value);
  }

  function toggleHermesMode() {
    setHermesMode((value) => {
      const next = !value;
      setHermesOpen(next);
      if (!next) setHermesConfigOpen(false);
      return next;
    });
  }

  function closeHermesPanel() {
    setHermesOpen(false);
    setHermesMode(false);
    setHermesConfigOpen(false);
  }

  async function selectImage(file) {
    setError("");
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("只能选择图片文件");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("图片不能超过 10MB");
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setImage({ name: file.name, type: file.type, size: file.size, dataUrl });
    } catch {
      setError("读取图片失败");
    }
  }

  async function selectFiles(fileList) {
    setError("");
    const selectedFiles = Array.from(fileList ?? []);
    if (selectedFiles.length === 0) return;
    if (fileAttachments.length + selectedFiles.length > 5) {
      setError("一次最多选择 5 个文件");
      return;
    }
    try {
      const nextFiles = [];
      for (const file of selectedFiles) {
        if (!isAllowedFile(file)) {
          setError("支持 PDF、Word、Excel、PPT、TXT、CSV 文件");
          return;
        }
        if (file.size > 25 * 1024 * 1024) {
          setError("单个文件不能超过 25MB");
          return;
        }
        const dataUrl = await readFileAsDataUrl(file);
        nextFiles.push({ id: crypto.randomUUID(), name: file.name, type: file.type || "application/octet-stream", size: file.size, dataUrl });
      }
      setFileAttachments((items) => [...items, ...nextFiles].slice(0, 5));
    } catch {
      setError("读取文件失败");
    }
  }

  function removeFile(id) {
    setFileAttachments((items) => items.filter((file) => file.id !== id));
  }

  async function clearChat() {
    setError("");
    setMessage("");
    setHistory([]);
    setAgents((items) => items.map((item) => ({ ...item, lastSent: "", lastReply: "", lastError: "" })));
    const res = await fetch("/api/chat/clear", { method: "POST" });
    if (!res.ok) setError((await res.json()).error ?? "清空失败");
  }

  async function startTunnel() {
    setError("");
    setNetworkBusy(true);
    const res = await fetch(network.tunnelUrl ? "/api/network/tunnel/restart" : "/api/network/tunnel/start", { method: "POST" });
    if (res.ok) {
      setNetwork(await res.json());
      setAccessMode("internet");
    } else {
      setError((await res.json()).error ?? "生成 Cloudflare 外网链接失败");
    }
    setNetworkBusy(false);
  }

  async function stopTunnel() {
    setError("");
    setNetworkBusy(true);
    const res = await fetch("/api/network/tunnel/stop", { method: "POST" });
    if (res.ok) setNetwork(await res.json());
    else setError((await res.json()).error ?? "关闭外网链接失败");
    setNetworkBusy(false);
  }

  async function copyActiveUrl() {
    if (!activeUrl) return;
    await navigator.clipboard?.writeText(activeUrl).catch(() => {});
  }

  async function copyAgentReply(agent) {
    if (!agent.lastReply) return;
    await navigator.clipboard?.writeText(agent.lastReply).catch(() => {});
    setCopiedReplyId(agent.id);
    window.setTimeout(() => setCopiedReplyId((id) => id === agent.id ? "" : id), 1400);
  }

  async function refreshAgentReply(agent) {
    if (readingAgentId) return;
    setError("");
    setReadingAgentId(agent.id);
    const res = await fetch(`/api/agents/${agent.id}/read`, { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      setAgents((items) => items.map((item) => item.id === agent.id ? { ...item, lastReply: data.reply, lastError: "" } : item));
    } else {
      const data = await res.json().catch(() => ({}));
      const message = data.error ?? "读取失败";
      setAgents((items) => items.map((item) => item.id === agent.id ? { ...item, lastError: message } : item));
      setError(`${agent.name} ${message}`);
    }
    setReadingAgentId("");
  }

  function openCompareDialog(agent) {
    const target = visibleAgents.find((item) => item.id !== agent.id && item.lastReply);
    setError("");
    setCompareDialog(agent);
    setCompareTargetId(target?.id ?? "");
  }

  function closeCompareDialog() {
    setCompareDialog(null);
    setCompareTargetId("");
  }

  async function compareReplies() {
    if (!compareDialog || !compareTargetId || busy) return;
    setBusy(true);
    setError("");
    const sourceAgentId = compareDialog.id;
    const targetAgentId = compareTargetId;
    closeCompareDialog();

    const res = await fetch("/api/chat/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceAgentId, targetAgentId, instruction: compareInstruction })
    });
    if (!res.ok) setError((await res.json()).error ?? "对比失败");
    setBusy(false);
  }

  function openSummaryDialog(agent) {
    const sources = visibleAgents.filter((item) => item.id !== agent.id && item.lastReply);
    setError("");
    setSummaryDialog(agent);
    setSummarySourceIds(sources.map((item) => item.id));
  }

  function openRuleDialog(agent) {
    setError("");
    setRuleDialog(agent);
    setRulePrompt(agent.systemPrompt ?? "");
  }

  function closeRuleDialog() {
    setRuleDialog(null);
    setRulePrompt("");
  }

  async function saveAgentRule() {
    if (!ruleDialog) return;
    await updateAgent(ruleDialog.id, { systemPrompt: rulePrompt });
    closeRuleDialog();
  }

  function closeSummaryDialog() {
    setSummaryDialog(null);
    setSummarySourceIds([]);
  }

  function toggleSummarySource(id) {
    setSummarySourceIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  }

  async function summarizeReplies() {
    if (!summaryDialog || summarySourceIds.length === 0 || busy) return;
    setBusy(true);
    setError("");
    const targetAgentId = summaryDialog.id;
    const sourceAgentIds = summarySourceIds;
    closeSummaryDialog();

    const res = await fetch("/api/chat/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetAgentId, sourceAgentIds, instruction: summaryInstruction })
    });
    if (!res.ok) setError((await res.json()).error ?? "汇总失败");
    setBusy(false);
  }

  const compareOptions = compareDialog
    ? visibleAgents.filter((agent) => agent.id !== compareDialog.id && agent.lastReply)
    : [];
  const summaryOptions = summaryDialog
    ? visibleAgents.filter((agent) => agent.id !== summaryDialog.id && agent.lastReply)
    : [];

  return (
    <main className="app-shell">
      <section className="composer">
        <div className="title-area">
          <h1>网页 AI 群聊</h1>
          <span className="account-email">zhengxiaodong117@gmail.com</span>
        </div>
        <div className="top-controls">
          <label className="count-control">
            显示数量
            <select value={settings.displayCount} onChange={(event) => updateSettings({ displayCount: Number(event.target.value) })}>
              {[1, 2, 3, 4, 5].map((count) => <option value={count} key={count}>{count}</option>)}
            </select>
          </label>
          <span className="enabled-count">{enabledCount} 个已启用</span>
          <label className="count-control">
            发送方式
            <select value={settings.sendMode} onChange={(event) => updateSettings({ sendMode: event.target.value })}>
              <option value="parallel">并发</option>
              <option value="polling">轮询</option>
            </select>
          </label>
          <label className="switch">
            <input type="checkbox" checked={shareContext} onChange={(event) => setShareContext(event.target.checked)} />
            <span />
            让 AI 知道彼此存在
          </label>
        </div>

        <section className="access-card">
          <div className="access-compact">
            <div className="access-title">
              <span className="access-icon">⌁</span>
              <strong>访问方式</strong>
            </div>
            <div className="access-tabs">
              <button className={accessMode === "local" ? "active" : ""} onClick={() => setAccessMode("local")}>⌁ 本地网络</button>
              <button className={accessMode === "internet" ? "active" : ""} onClick={() => setAccessMode("internet")}>◎ 互联网</button>
            </div>
            <div className="access-url-row">
              <span className="link-icon">↪</span>
              <span className="access-url">{activeUrl || (accessMode === "internet" ? "未生成互联网链接" : "未检测到本地网络地址")}</span>
              <button className="copy-button" disabled={!activeUrl} onClick={copyActiveUrl}>⧉</button>
            </div>
            {accessMode === "internet" && (
              <div className="access-actions inline-actions">
                <button disabled={networkBusy} onClick={startTunnel}>{network.tunnelUrl ? "重新生成链接" : "生成链接"}</button>
                <button disabled={networkBusy || !network.tunnelUrl} onClick={stopTunnel}>关闭链接</button>
              </div>
            )}
            <span className={`access-state ${networkStopped ? "stopped" : "running"}`}>
              {networkStopped ? "stopped" : "ready"}
            </span>
            <span className="access-help inline-help">
              {accessMode === "local"
                ? "同一 WiFi 下访问"
                : "临时公网链接，电脑需保持开机联网"}
            </span>
          </div>
        </section>

        <section className="input-panel">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="输入要同时发送给网页 AI 的消息"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
          {image && (
            <div className="attachment-preview">
              <img src={image.dataUrl} alt={image.name} />
              <div>
                <strong>{image.name}</strong>
                <span>Image · {formatFileSize(image.size)}</span>
              </div>
              <button className="icon-button" onClick={() => setImage(null)} title="Remove image" aria-label="Remove image">
                <IconClose />
              </button>
            </div>
          )}
          {fileAttachments.map((fileAttachment) => (
            <div className="attachment-preview file-preview" key={fileAttachment.id}>
              <div className="file-badge">
                <IconFile />
              </div>
              <div>
                <strong>{fileAttachment.name}</strong>
                <span>File · {formatFileSize(fileAttachment.size)}</span>
              </div>
              <button className="icon-button" onClick={() => removeFile(fileAttachment.id)} title="Remove file" aria-label="Remove file">
                <IconClose />
              </button>
            </div>
          ))}
          <div className="composer-actions">
            <label className="attach-button" title="Image">
              <input type="file" accept="image/*" onChange={(event) => {
                selectImage(event.target.files?.[0]);
                event.target.value = "";
              }} />
              <IconImage />
              Image
            </label>
            <label className="attach-button" title="File">
              <input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv,text/markdown" onChange={(event) => {
                selectFiles(event.target.files);
                event.target.value = "";
              }} />
              <IconFile />
              File
            </label>
            <button className="primary icon-text-button" disabled={hermesMode ? (!message.trim() || busy || hermesState.busy) : ((!message.trim() && !image && fileAttachments.length === 0) || busy || enabledCount === 0)} onClick={sendMessage}>
              <IconSend />
              {busy ? "Sending" : hermesMode ? "To Hermes" : "Send"}
            </button>
            <button className={hermesMode ? "icon-text-button hermes-button active" : "icon-text-button hermes-button"} disabled={busy || hermesState.busy} onClick={toggleHermesMode} title="Hermes">
              <IconHermes />
              Hermes
            </button>
            <button className="icon-text-button hermes-button" disabled={busy || hermesState.busy} onClick={() => setHermesOpen(true)} title="打开 Hermes 分析">
              <IconSummary />
              Analyze
            </button>
            <button className="icon-text-button" disabled={busy} onClick={clearChat}>
              <IconClear />
              Clear
            </button>
            {error && <span className="error-text">{error}</span>}
          </div>
        </section>
      </section>

      <section className="agent-grid" style={{ "--visible-count": visibleAgents.length }}>
        {visibleAgents.map((agent) => (
          <article className="agent-card" key={agent.id}>
            <div className="agent-head">
              <select className="model-select" value={agent.modelKey ?? ""} onChange={(event) => selectModel(agent.id, event.target.value)}>
                {models.map((model) => <option value={model.modelKey} key={model.modelKey}>{model.name}</option>)}
              </select>
              <input className="url-input" value={agent.url} placeholder="https:// 或 http://localhost:11434/..." onChange={(event) => updateAgent(agent.id, { url: event.target.value })} />
              <span className={`status ${statusTone[agent.status] ?? "idle"}`}>{statusLabels[agent.status] ?? "未打开"}</span>
            </div>
            <div className="agent-toolbar">
              <label className="check-line">
                <input type="checkbox" checked={agent.enabled} onChange={(event) => updateAgent(agent.id, { enabled: event.target.checked })} />
                启用
              </label>
              <button onClick={() => openAgent(agent.id)}>打开网页/本地模型页</button>
              <button className={agent.systemPrompt ? "rule-button active" : "rule-button"} onClick={() => openRuleDialog(agent)} title="规则提示">
                <IconRules />
                规则提示
              </button>
            </div>
            <ConversationBlock
              sentText={agent.lastSent || "暂无"}
              replyText={agent.lastReply || agent.lastError || "暂无"}
              muted={!agent.lastReply && !agent.lastError}
              error={Boolean(agent.lastError && !agent.lastReply)}
              actions={(
                <>
                  <button className="icon-button" disabled={readingAgentId === agent.id} onClick={() => refreshAgentReply(agent)} title="重新读取答案" aria-label="重新读取答案">
                    <IconRefresh />
                  </button>
                  <button className="icon-button" disabled={!agent.lastReply} onClick={() => copyAgentReply(agent)} title={copiedReplyId === agent.id ? "已复制" : "复制答案"} aria-label="复制答案">
                    <IconCopy />
                  </button>
                  <button className="icon-button" disabled={!agent.lastReply || busy} onClick={() => openCompareDialog(agent)} title="交换答案并对比" aria-label="交换答案并对比">
                    <IconCompare />
                  </button>
                  <button className="icon-button" disabled={!agent.lastReply || busy} onClick={() => openSummaryDialog(agent)} title="汇总多个答案" aria-label="汇总多个答案">
                    <IconSummary />
                  </button>
                </>
              )}
            />
          </article>
        ))}
      </section>

      {compareDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeCompareDialog();
        }}>
          <section className="compare-modal" role="dialog" aria-modal="true" aria-labelledby="compare-title">
            <div className="modal-head">
              <h2 id="compare-title">要做什么？</h2>
              <button className="icon-button" onClick={closeCompareDialog} title="关闭" aria-label="关闭">
                <IconClose />
              </button>
            </div>
            <p>{compareDialog.name} 将和你选择的模型交换答案，双方都会读取对方结果并做分析比较。</p>
            <label className="modal-field">
              选择交换对象
              <select value={compareTargetId} onChange={(event) => setCompareTargetId(event.target.value)}>
                <option value="">请选择</option>
                {compareOptions.map((agent) => (
                  <option value={agent.id} key={agent.id}>{visibleAgents.findIndex((item) => item.id === agent.id) + 1}. {agent.name}</option>
                ))}
              </select>
            </label>
            <label className="modal-field">
              对比要求
              <textarea value={compareInstruction} onChange={(event) => setCompareInstruction(event.target.value)} />
            </label>
            <div className="modal-actions">
              <button onClick={closeCompareDialog}>取消</button>
              <button className="primary" disabled={!compareTargetId || busy} onClick={compareReplies}>开始对比</button>
            </div>
          </section>
        </div>
      )}

      {summaryDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeSummaryDialog();
        }}>
          <section className="compare-modal" role="dialog" aria-modal="true" aria-labelledby="summary-title">
            <div className="modal-head">
              <h2 id="summary-title">让 {summaryDialog.name} 汇总哪些回答？</h2>
              <button className="icon-button" onClick={closeSummaryDialog} title="关闭" aria-label="关闭">
                <IconClose />
              </button>
            </div>
            <p>只会把选中的回答发送给 {summaryDialog.name} 做综合总结，不会重新发送给其他模型。</p>
            <div className="source-list">
              {summaryOptions.length === 0 ? (
                <span className="empty-note">还没有其他可汇总的读回消息</span>
              ) : summaryOptions.map((agent) => (
                <label className="source-option" key={agent.id}>
                  <input type="checkbox" checked={summarySourceIds.includes(agent.id)} onChange={() => toggleSummarySource(agent.id)} />
                  <span>{visibleAgents.findIndex((item) => item.id === agent.id) + 1}. {agent.name}</span>
                </label>
              ))}
            </div>
            <label className="modal-field">
              汇总要求
              <textarea value={summaryInstruction} onChange={(event) => setSummaryInstruction(event.target.value)} />
            </label>
            <div className="modal-actions">
              <button onClick={closeSummaryDialog}>取消</button>
              <button className="primary" disabled={summarySourceIds.length === 0 || busy} onClick={summarizeReplies}>开始汇总</button>
            </div>
          </section>
        </div>
      )}

      {ruleDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeRuleDialog();
        }}>
          <section className="compare-modal" role="dialog" aria-modal="true" aria-labelledby="rule-title">
            <div className="modal-head">
              <h2 id="rule-title">{ruleDialog.name} 的规则提示</h2>
              <button className="icon-button" onClick={closeRuleDialog} title="关闭" aria-label="关闭">
                <IconClose />
              </button>
            </div>
            <p>这里保存的是这个模型自己的长期规则。以后发送普通消息、对比、汇总时都会自动加在消息前面。</p>
            <label className="modal-field">
              规则提示词
              <textarea
                value={rulePrompt}
                onChange={(event) => setRulePrompt(event.target.value)}
                placeholder="例如：请用中文回答；先给结论，再给依据；遇到不确定内容要说明。"
              />
            </label>
            <div className="modal-actions">
              <button onClick={() => setRulePrompt("")}>清空规则</button>
              <button onClick={closeRuleDialog}>取消</button>
              <button className="primary" disabled={busy} onClick={saveAgentRule}>保存规则</button>
            </div>
          </section>
        </div>
      )}

      {hermesOpen && (
        <aside
          className={hermesMaximized ? "hermes-float maximized" : "hermes-float"}
          aria-label="Hermes 会话窗口"
          style={hermesMaximized ? undefined : {
            left: hermesWindow.left,
            top: hermesWindow.top,
            width: hermesWindow.width,
            height: hermesWindow.height
          }}
        >
          <div className="hermes-float-head" onPointerDown={startHermesDrag}>
            <div>
              <strong>Hermes</strong>
              <span>{hermesState.busy ? "分析中" : hermesMode ? "发送到 Hermes" : "待命"}</span>
            </div>
            <div className="hermes-head-actions">
              <button className="text-button" disabled={hermesState.busy || hermesState.context.length === 0} onClick={clearHermes} title="Clear">
                Clear
              </button>
              <button className="icon-button" disabled={hermesConfigBusy} onClick={(event) => {
                event.stopPropagation();
                setHermesConfigOpen((value) => !value);
                if (!hermesConfigOpen) refreshHermesTargets();
              }} title="Hermes 配置" aria-label="Hermes 配置">
                <IconSettings />
              </button>
              <button className="icon-button" onClick={toggleHermesMaximize} title={hermesMaximized ? "还原" : "最大化"} aria-label={hermesMaximized ? "还原" : "最大化"}>
                {hermesMaximized ? <IconRestore /> : <IconMaximize />}
              </button>
              <button className="icon-button" onClick={closeHermesPanel} title="关闭" aria-label="关闭">
                <IconClose />
              </button>
            </div>
          </div>
          {!hermesState.available && <div className="hermes-float-actions"><span className="error-text">未检测到 Hermes</span></div>}
          {hermesConfigOpen && (
            <div className="hermes-config">
              <div className="hermes-config-head">
                <strong>WSL Hermes 连接配置</strong>
                <button disabled={hermesConfigBusy} onClick={refreshHermesTargets}>{hermesConfigBusy ? "刷新中" : "刷新"}</button>
              </div>
              <label>
                发送目标
                <select
                  value={hermesSettings.target}
                  onChange={(event) => {
                    const option = [...event.currentTarget.options].find((item) => item.value === event.target.value);
                    saveHermesTarget(event.target.value, option?.dataset.label ?? "");
                  }}
                >
                  <option value="" data-label="">独立 Hermes 对话（不发送到微信/飞书）</option>
                  {hermesTargets.conversations.map((item) => (
                    <option value={item.target} data-label={`${item.platform} ${item.name}`} key={item.sessionKey}>
                      {item.platform} / {item.chatType} / {item.name}
                    </option>
                  ))}
                  {hermesTargets.channels.map((item) => (
                    <option value={item.target} data-label={`${item.platform} ${item.name}`} key={item.target}>
                      {item.platform} / {item.chatType || "channel"} / {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <span className="hermes-config-note">
                当前：{hermesSettings.target ? `${hermesSettings.targetLabel || hermesSettings.target}` : `独立 Hermes 对话${hermesSettings.sessionId ? ` / ${hermesSettings.sessionId}` : ""}`}
              </span>
              {hermesTargets.error && <span className="hermes-error">{hermesTargets.error}</span>}
            </div>
          )}
          {hermesState.lastError && <div className="hermes-error">{hermesState.lastError}</div>}
          <div className="hermes-chat">
            {hermesState.context.length === 0 ? (
              <span className="empty-note">暂无会话。点亮 Hermes 后发送消息，或让 AI 回复后点 Analyze all。</span>
            ) : hermesState.context.map((item) => (
              <article className={`hermes-bubble ${item.role}`} key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.role === "ai" ? (item.status || "collected") : item.time}</span>
                </div>
                {item.role === "ai" ? (
                  <span className="hermes-status-line">Collected for analysis</span>
                ) : (
                  <pre>{item.text}</pre>
                )}
              </article>
              ))}
          </div>
          <div className="hermes-compose">
            <div className="hermes-input-wrap">
              <textarea
                value={hermesDraft}
                onChange={(event) => setHermesDraft(event.target.value)}
                placeholder="Message Hermes or ask: Compare these replies, identify the most reliable answer, and point out omissions"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendHermesDraft();
                  }
                }}
              />
              <div className="hermes-compose-actions">
                <button className="text-button" disabled={busy || hermesState.busy || hermesReadableAgents.length === 0} onClick={() => analyzeWithHermes(hermesDraft)} title="按输入要求分析主界面回复">
                  {hermesState.busy ? "Analyzing" : "Analyze"}
                </button>
                <button className="icon-button" disabled={!hermesDraft.trim() || busy || hermesState.busy} onClick={sendHermesDraft} title="发送给 Hermes" aria-label="发送给 Hermes">
                  <IconSend />
                </button>
              </div>
            </div>
          </div>
          {!hermesMaximized && <div className="hermes-resize-grip" title="拖动调整大小" onPointerDown={(event) => {
            event.preventDefault();
            const start = { x: event.clientX, y: event.clientY, width: hermesWindow.width, height: hermesWindow.height };
            const onMove = (moveEvent) => resizeHermesWindow(start.width + moveEvent.clientX - start.x, start.height + moveEvent.clientY - start.y);
            const onUp = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
          }} />}
        </aside>
      )}

      <section className="history">
        <h2>最近发送</h2>
        {history.length === 0 ? <p>暂无</p> : history.map((item) => <p key={item.id}><span>{item.time}</span>{item.message}</p>)}
      </section>
    </main>
  );
}

function MessageBlock({ title, text, muted, error, actions }) {
  return (
    <div className={`message-block ${muted ? "muted" : ""} ${error ? "message-error" : ""}`}>
      <div className="message-head">
        <strong>{title}</strong>
        {actions && <div className="message-actions">{actions}</div>}
      </div>
      <pre>{text}</pre>
    </div>
  );
}

function ConversationBlock({ sentText, replyText, muted, error, actions }) {
  return (
    <div className={`conversation-block ${muted ? "muted" : ""} ${error ? "message-error" : ""}`}>
      <div className="conversation-section sent-section">
        <strong>发送的消息</strong>
        <pre>{sentText}</pre>
      </div>
      <div className="conversation-section">
        <div className="message-head">
          <strong>读回的消息</strong>
          <div className="message-actions">{actions}</div>
        </div>
        <pre>{replyText}</pre>
      </div>
    </div>
  );
}

function IconCopy() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M5 15V7a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 5v5h-5" />
    </svg>
  );
}

function IconCompare() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7h11l-3-3" />
      <path d="M18 7l-3 3" />
      <path d="M17 17H6l3 3" />
      <path d="M6 17l3-3" />
    </svg>
  );
}

function IconSummary() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6h14" />
      <path d="M5 12h10" />
      <path d="M5 18h7" />
      <path d="M17 15l2 2 3-4" />
    </svg>
  );
}

function IconRules() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 4h12a2 2 0 0 1 2 2v14l-4-2-4 2-4-2-4 2V6a2 2 0 0 1 2-2z" />
      <path d="M8 8h8" />
      <path d="M8 12h6" />
    </svg>
  );
}

function IconHermes() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l7 4v6c0 4-3 7-7 8-4-1-7-4-7-8V7z" />
      <path d="M8 9h8" />
      <path d="M9 13h6" />
      <path d="M10 17h4" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6l-.09.09a2 2 0 0 1-3.82 0L10 20a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1l-.09-.09a2 2 0 0 1 0-3.82L4 10a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6l.09-.09a2 2 0 0 1 3.82 0L14 4a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.36.4.7.6 1l.09.09a2 2 0 0 1 0 3.82L20 14a1.7 1.7 0 0 0-.6 1z" />
    </svg>
  );
}

function IconMaximize() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4H4v4" />
      <path d="M16 4h4v4" />
      <path d="M20 16v4h-4" />
      <path d="M4 16v4h4" />
    </svg>
  );
}

function IconRestore() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1" />
      <path d="M10 4h10v10" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

function IconImage() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M7 17l4-4 3 3 2-2 2 3" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M14 4v5h5" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4z" />
    </svg>
  );
}

function IconClear() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  );
}

function chooseLanAddress(network) {
  const addresses = network.lan ?? [];
  return addresses.find((item) => item.includes("192.168.1.")) ?? addresses.find((item) => item.includes("192.168.")) ?? addresses[0] ?? network.local ?? "";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatFileSize(size) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isAllowedFile(file) {
  const allowedExtensions = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".md"];
  const lowerName = file.name.toLowerCase();
  return allowedExtensions.some((extension) => lowerName.endsWith(extension));
}

function readHermesWindow() {
  const fallback = defaultHermesWindow();
  try {
    const value = JSON.parse(localStorage.getItem("hermes-window") || "null");
    return clampHermesWindow({ ...fallback, ...value });
  } catch {
    return fallback;
  }
}

function saveHermesWindow(value) {
  try {
    localStorage.setItem("hermes-window", JSON.stringify(clampHermesWindow(value)));
  } catch {
    // Ignore storage failures; window dragging should still work.
  }
}

function defaultHermesWindow() {
  const width = Math.min(430, Math.max(320, window.innerWidth - 24));
  const height = Math.min(680, Math.max(360, window.innerHeight - 36));
  return {
    width,
    height,
    left: Math.max(12, window.innerWidth - width - 18),
    top: Math.max(12, window.innerHeight - height - 18)
  };
}

function clampHermesWindow(value) {
  const margin = 10;
  const width = Math.min(Math.max(Number(value.width) || 430, 320), Math.max(320, window.innerWidth - margin * 2));
  const height = Math.min(Math.max(Number(value.height) || 520, 300), Math.max(300, window.innerHeight - margin * 2));
  return {
    width,
    height,
    left: Math.min(Math.max(Number(value.left) || margin, margin), Math.max(margin, window.innerWidth - width - margin)),
    top: Math.min(Math.max(Number(value.top) || margin, margin), Math.max(margin, window.innerHeight - height - margin))
  };
}

createRoot(document.getElementById("root")).render(<App />);
