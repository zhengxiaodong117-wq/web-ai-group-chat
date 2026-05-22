import React, { useEffect, useMemo, useState } from "react";
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
    });
    return () => socket.close();
  }, []);

  const visibleAgents = useMemo(() => agents.slice(0, settings.displayCount), [agents, settings.displayCount]);
  const enabledCount = useMemo(() => visibleAgents.filter((agent) => agent.enabled).length, [visibleAgents]);
  const localAddress = useMemo(() => chooseLanAddress(network), [network]);
  const activeUrl = accessMode === "internet" ? network.tunnelUrl : localAddress;
  const networkStopped = accessMode === "internet" && !network.tunnelUrl;

  async function loadInitialState() {
    const [agentsRes, modelsRes, settingsRes, networkRes] = await Promise.all([
      fetch("/api/agents"),
      fetch("/api/models"),
      fetch("/api/settings"),
      fetch("/api/network")
    ]);
    setAgents(await agentsRes.json());
    setModels(await modelsRes.json());
    setSettings(await settingsRes.json());
    setNetwork(await networkRes.json());
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
            <button className="primary icon-text-button" disabled={(!message.trim() && !image && fileAttachments.length === 0) || busy || enabledCount === 0} onClick={sendMessage}>
              <IconSend />
              {busy ? "Sending" : "Send"}
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

createRoot(document.getElementById("root")).render(<App />);
