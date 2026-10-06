const $ = (id) => document.getElementById(id);
const state = {
  me: null, dialogs: [], peer: null, filter: "all", tab: "code",
  messages: [], selected: null, replyTo: null, demo: false,
  openIds: new Set(), showOlder: false, hasMore: false, editing: null, loadingOlder: false,
};
const settings = Object.assign({
  accent: "mint", enterSend: false, relative: true, mono: 12.5,
  showIds: false, confirmSend: false, linkCards: true, compact: false, drafts: true, clock24: true,
  hidePhone: false, hideUsernames: false, hidePreviews: false, revealClick: false,
  notify: false, notifySound: false, notifyPreview: true, muteBots: false, muteChannels: false,
  rememberBrowser: true, idleLock: 0,
}, JSON.parse(localStorage.getItem("bt_prefs") || "{}"));
const bookmarks = new Set(JSON.parse(localStorage.getItem("bt_marks") || "[]"));
function saveMarks() { localStorage.setItem("bt_marks", JSON.stringify([...bookmarks])); }
const snippets = JSON.parse(localStorage.getItem("bt_snips") || "null") || [
  { name: "verify hmac", lang: "python", body: "def verify(secret: str, body: bytes, header: str) -> bool:\n    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()\n    return hmac.compare_digest(expected, header)\n" },
  { name: "bug report", lang: "markdown", body: "Expected:\n\nActual:\n\nRepro:\n1.\n\n```\nstack\n```\n" },
];

function savePrefs() { localStorage.setItem("bt_prefs", JSON.stringify(settings)); applyPrefs(); }
function saveSnips() { localStorage.setItem("bt_snips", JSON.stringify(snippets)); }
function applyPrefs() {
  document.documentElement.dataset.accent = settings.accent;
  document.documentElement.style.setProperty("--mono-size", settings.mono + "px");
  document.documentElement.style.setProperty("--body-size", (settings.mono + 1.5) + "px");
}
applyPrefs();

// Refreshes the header bits affected by privacy prefs (username visibility).
// Called after saving settings so the change applies without a reload.
function applyPrivacyChrome() {
  if (state.me) {
    const handle = settings.hideUsernames ? "" : (state.me.username ? "@" + state.me.username : "");
    $("meLabel").textContent = handle || state.me.name || "you";
  }
  const d = state.dialogs.find((x) => x.id === state.peer);
  if (d && !state.demo) {
    $("peerSub").textContent = d.username && !settings.hideUsernames ? "@" + d.username + " · " + d.kind : d.kind;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "\u0026amp;",
    "<": "\u0026lt;",
    ">": "\u0026gt;",
    '"': "\u0026quot;",
    "'": "\u0026#39;"
  }[c]));
}

function githubCard(url) {
  const m = url.match(/https?:\/\/(?:github|gitlab)\.com\/([\w.-]+)\/([\w.-]+)(?:\/(pull|issues|commit)\/([\w.-]+))?/i);
  if (!m) return "";
  const host = url.includes("gitlab") ? "GitLab" : "GitHub";
  const kind = m[3] || "repo";
  const ref = m[4] ? kind + " " + m[4] : "repository";
  return `<a class="card" href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><b>${escapeHtml(m[1] + "/" + m[2])}</b><span>${escapeHtml(host + " " + ref)}</span></a>`;
}

function looksLikeDiff(code) {
  const lines = code.split("\n");
  const marks = lines.filter((l) => l.startsWith("+") || l.startsWith("-") || l.startsWith("@@")).length;
  return marks >= 2 && marks / Math.max(lines.length, 1) > 0.4;
}
function renderDiff(code) {
  const rows = code.split("\n").map((line) => {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
    return `<div class="diff-line ${cls}">${escapeHtml(line) || " "}</div>`;
  }).join("");
  return `<div class="diff">${rows}</div><div class="fence-bar"><span>diff</span><button class="ghost" type="button" data-copy="${encodeURIComponent(code)}">copy</button></div>`;
}
function highlight(code, lang) {
  if (window.hljs && lang && hljs.getLanguage(lang)) {
    try { return hljs.highlight(code, { language: lang }).value; } catch (e) {}
  }
  if (window.hljs) {
    try { return hljs.highlightAuto(code).value; } catch (e) {}
  }
  return escapeHtml(code);
}
function renderFence(code, lang) {
  return `<pre class="block"><code class="hljs">${highlight(code, lang)}</code></pre><div class="fence-bar"><span>${escapeHtml(lang || "code")}</span><button class="ghost" type="button" data-copy="${encodeURIComponent(code)}">copy</button></div>`;
}
function renderInline(text) {
  // Pull URLs out first so they are escaped exactly once when re-inserted.
  const urls = [];
  const tokenized = String(text ?? "").replace(/https?:\/\/[^\s<)]+/g, (url) => {
    urls.push(url);
    return "\u0000" + (urls.length - 1) + "\u0000";
  });
  let html = escapeHtml(tokenized).replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const url = urls[Number(i)];
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`;
  });
  if (!settings.linkCards) return `<div class="body">${html}</div>`;
  return `<div class="body">${html}</div>${urls.map(githubCard).join("")}`;
}
function renderText(text) {
  if (!text) return "";
  const parts = [];
  const re = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let last = 0, match;
  while ((match = re.exec(text))) {
    parts.push(renderInline(text.slice(last, match.index)));
    const lang = match[1] || "";
    const code = match[2].replace(/\n$/, "");
    parts.push(lang === "diff" || looksLikeDiff(code) ? renderDiff(code) : renderFence(code, lang));
    last = re.lastIndex;
  }
  parts.push(renderInline(text.slice(last)));
  return parts.join("");
}
function stamp(iso) {
  if (!iso) return "";
  if (!settings.relative) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (settings.clock24) return `${day} ${time}`;
    const h12 = d.getHours() % 12 || 12;
    return `${day} ${h12}:${p(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
  }
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return mins + "m";
  if (mins < 1440) return Math.round(mins / 60) + "h";
  return iso.slice(0, 10);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { detail: text }; }
  if (!res.ok) {
    const detail = data.detail || res.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}
function creds() {
  return {
    api_id: Number(localStorage.getItem("bt_api_id") || 0),
    api_hash: localStorage.getItem("bt_api_hash") || "",
    session: localStorage.getItem("bt_session") || "",
  };
}
function setStatus(text) { $("status").textContent = text; }

function filteredDialogs() {
  const q = ($("chatFilter").value || "").toLowerCase();
  return state.dialogs.filter((d) => {
    if (state.filter === "marks" && !bookmarks.has(d.id)) return false;
    if (state.filter !== "all" && state.filter !== "unread" && state.filter !== "marks" && d.kind !== state.filter) return false;
    if (state.filter === "unread" && !d.unread) return false;
    if (!q) return true;
    return (d.name + " " + (d.username || "") + " " + (d.last || "")).toLowerCase().includes(q);
  });
}
function paintChats() {
  const rows = filteredDialogs();
  $("chats").innerHTML = rows.map((d) => `
    <div class="chat ${state.peer === d.id ? "active" : ""}" data-id="${d.id}">
      <div class="avatar">${escapeHtml(d.name.slice(0, 1).toUpperCase())}</div>
      <div>
        <div class="name">${escapeHtml(d.name)}</div>
        <div class="preview">${settings.hidePreviews ? "Hidden" : escapeHtml(d.last || "")}${settings.showIds ? " · " + d.id : ""}</div>
      </div>
      <div>${d.unread ? `<span class="badge">${d.unread}</span>` : `<span class="kind">${d.kind}</span>`}<button class="star ${bookmarks.has(d.id) ? "on" : ""}" type="button" data-star="${d.id}">*</button></div>
    </div>`).join("") || `<p class="hint" style="padding:12px">No chats in this filter.</p>`;
}
async function loadDialogs() {
  if (state.demo) { paintChats(); return; }
  const data = await api("/api/dialogs?limit=120");
  state.dialogs = data.dialogs;
  paintChats();
  setStatus("backtick · " + state.dialogs.length + " chats");
}
async function openPeer(id) {
  if (state.peer && settings.drafts) localStorage.setItem("bt_draft_" + state.peer, $("draft").value);
  if (state.editing) cancelEdit();
  $("shell").classList.remove("show-chats");
  state.peer = id;
  state.selected = null;
  const d = state.dialogs.find((x) => x.id === id);
  $("peerName").textContent = d ? d.name : id;
  $("peerSub").textContent = d && d.username && !settings.hideUsernames ? "@" + d.username + " · " + d.kind : (d ? d.kind : "");
  $("draft").value = localStorage.getItem("bt_draft_" + id) || "";
  paintChats();
  if (state.demo && id === "2") { state.showOlder = false; state.openIds = new Set(demoMessages().map((m) => m.id)); paint(demoMessages()); renderFlow(); return; }
  if (state.demo) { paint([]); return; }
  const data = await api("/api/messages?peer=" + encodeURIComponent(id) + "&limit=60");
  state.openIds = new Set(data.messages.map((m) => m.id));
  state.showOlder = true;
  state.hasMore = data.messages.length >= 60;
  paint(data.messages);
  renderFlow();
  setStatus("backtick · " + (d ? d.name : id) + " · " + data.messages.length + " msgs");
}

async function loadOlder() {
  if (!state.peer || state.demo || state.loadingOlder || !state.hasMore) return;
  state.loadingOlder = true;
  const oldest = state.messages.length ? state.messages[0].id : 0;
  const log = $("log");
  const before = log.scrollHeight;
  try {
    const data = await api("/api/messages?peer=" + encodeURIComponent(state.peer) + "&limit=60&offset_id=" + oldest);
    if (data.messages.length) {
      data.messages.forEach((m) => state.openIds.add(m.id));
      state.messages = data.messages.concat(state.messages);
      state.hasMore = data.messages.length >= 60;
      paint(state.messages, false);
      log.scrollTop = log.scrollHeight - before;
    } else {
      state.hasMore = false;
      paint(state.messages, false);
    }
  } catch (e) { setStatus("backtick · " + e.message); }
  state.loadingOlder = false;
}

function startEdit(msg) {
  state.editing = msg.id;
  state.replyTo = null;
  $("draft").value = msg.text || "";
  $("sendBtn").textContent = "Save";
  $("replyHint").textContent = "editing message " + msg.id + " · Esc cancels";
  $("draft").focus();
}
function cancelEdit() {
  state.editing = null;
  $("sendBtn").textContent = "Send";
  $("replyHint").textContent = "";
}
async function deleteMessage(msg) {
  if (state.demo) {
    state.messages = state.messages.filter((x) => x.id !== msg.id);
    state.openIds.delete(msg.id);
    paint(state.messages);
    return;
  }
  if (!confirm("Delete this message?")) return;
  try {
    await api("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ peer: state.peer, msg_id: msg.id }) });
    state.messages = state.messages.filter((x) => x.id !== msg.id);
    state.openIds.delete(msg.id);
    paint(state.messages);
    setStatus("backtick · message deleted");
  } catch (e) { setStatus("backtick · " + e.message); }
}
function paint(messages, stick = true) {
  state.messages = messages;
  const older = state.showOlder && state.hasMore
    ? `<div style="text-align:center; margin-bottom:4px;"><button class="ghost" type="button" id="loadOlder">Load older</button></div>` : "";
  let lastDay = "", prevKey = "", prevTime = 0, prevJump = true;
  const dayLabel = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "";
  $("log").innerHTML = older + messages.map((m) => {
    const day = dayLabel(m.date);
    let div = "";
    if (day && day !== lastDay) {
      div = `<div class="day"><span>${escapeHtml(day)}</span></div>`;
      lastDay = day;
      prevKey = "";
    }
    const key = (m.out ? "out:" : "in:") + (m.sender || "");
    const t = m.date ? new Date(m.date).getTime() : 0;
    const jumpHere = !!(m.peer && m.peer !== state.peer);
    const grouped = !jumpHere && !prevJump && prevKey !== "" && key === prevKey && (t - prevTime) < 5 * 60000;
    prevKey = key; prevTime = t; prevJump = jumpHere;
    const peerQ = `peer=${encodeURIComponent(m.peer || state.peer || "")}&msg_id=${m.id}`;
    let media = "";
    if (m.media_kind === "photo") {
      media = `<div class="thumb"><img loading="lazy" src="/api/thumb?${peerQ}" data-full="${m.id}" data-peer="${escapeHtml(m.peer || state.peer || "")}" alt="photo" /></div>`;
    } else if (m.sticker) {
      media = `<img class="sticker" loading="lazy" src="/api/media?${peerQ}" alt="sticker" />`;
    } else if (m.voice) {
      const dur = m.voice_duration ? `<span class="kind">${m.voice_duration}s</span>` : "";
      media = `<div class="voicewrap"><audio controls preload="none" src="/api/media?${peerQ}"></audio>${dur}</div>`;
    } else if (m.file_name) {
      media = `<div class="filechip"><button class="ghost" type="button" data-file="${m.id}">${escapeHtml(m.file_name)}</button><span class="kind">${m.media_kind || "file"}</span></div>`;
    }
    const jump = jumpHere
      ? `<div class="hint" style="margin-bottom:2px;">in <button class="ghost" type="button" data-jump="${m.peer}">${escapeHtml(m.peer_name || m.peer)}</button></div>` : "";
    const reply = m.reply_to
      ? `<button class="replyjump" type="button" data-goto="${m.reply_to}" title="Jump to quoted message">↩ ${escapeHtml(m.reply_sender || ("message #" + m.reply_to))}${m.reply_text ? ": " + escapeHtml(m.reply_text.slice(0, 60)) : ""}</button>` : "";
    const own = m.out ? `<button class="ghost" type="button" data-act="edit" data-id="${m.id}">edit</button><button class="ghost" type="button" data-act="del" data-id="${m.id}">del</button>` : "";
    return `${div}<article class="msg ${m.out ? "out" : ""} ${settings.compact ? "compact" : ""} ${grouped ? "grouped" : ""} ${state.selected === m.id ? "selected" : ""}" data-id="${m.id}">
      ${jump}
      <div class="meta"><span class="who">${escapeHtml(m.sender || (m.out ? "you" : "them"))}</span><span>${stamp(m.date)}</span>
        <button class="ghost" type="button" data-act="inspect" data-id="${m.id}">inspect</button>
        <button class="ghost" type="button" data-act="quote" data-id="${m.id}">quote</button>
        ${own}
        <button class="ghost" type="button" data-act="fence" data-id="${m.id}">fence</button>
      </div>
      ${reply}
      ${renderText(m.text || "").replaceAll('class="body"', settings.revealClick ? 'class="body locked"' : 'class="body"')}
      ${media}
    </article>`;
  }).join("") || `<p class="hint">No messages yet.</p>`;
  if (stick) $("log").scrollTop = $("log").scrollHeight;
}

const INSERTS = {
  python: "```python\n\n```",
  ts: "```ts\n\n```",
  json: "```json\n{}\n```",
  diff: "```diff\n- old\n+ new\n```",
  sql: "```sql\nselect 1;\n```",
  shell: "```bash\n\n```",
  trace: "```\nError:\n  at \n```",
};
function buildInserts() {
  $("inserts").innerHTML = Object.keys(INSERTS).map((k) => `<button type="button" data-insert="${k}">${k}</button>`).join("");
}
function insertAtCursor(text) {
  const el = $("draft");
  const start = el.selectionStart, end = el.selectionEnd;
  el.setRangeText(text, start, end, "end");
  el.focus();
}

function commands() {
  const jumps = filteredDialogs().slice(0, 8).map((d) => ({ label: "Open " + d.name, hint: d.kind, run: () => openPeer(d.id) }));
  const tools = [
    { label: "Export chat as Markdown", hint: "thread", run: () => $("exportBtn").click() },
    { label: "Mark chat read", hint: "thread", run: () => $("readBtn").click() },
    { label: "Search this thread", hint: "thread", run: () => { $("threadSearch").classList.remove("hidden"); $("searchAll").checked = false; $("threadQuery").focus(); } },
    { label: "Search everywhere", hint: "thread", run: () => { $("threadSearch").classList.remove("hidden"); $("searchAll").checked = true; $("threadQuery").focus(); } },
    { label: "Load older messages", hint: "thread", run: () => loadOlder() },
    { label: "Insert Python fence", hint: "compose", run: () => insertAtCursor(INSERTS.python) },
    { label: "Insert diff fence", hint: "compose", run: () => insertAtCursor(INSERTS.diff) },
    { label: "Open bot workbench", hint: "rail", run: () => selectTab("bots") },
    { label: "Open inspector", hint: "rail", run: () => selectTab("inspect") },
    { label: "Open tools", hint: "rail", run: () => selectTab("tools") },
    { label: "Thread stats", hint: "tools", run: () => { selectTab("tools"); setTimeout(() => $("statBtn") && $("statBtn").click(), 0); } },
    { label: "Accent mint", hint: "prefs", run: () => { settings.accent = "mint"; savePrefs(); } },
    { label: "Accent amber", hint: "prefs", run: () => { settings.accent = "amber"; savePrefs(); } },
    { label: "Accent violet", hint: "prefs", run: () => { settings.accent = "violet"; savePrefs(); } },
    { label: "Toggle relative time", hint: "prefs", run: () => { settings.relative = !settings.relative; savePrefs(); paint(state.messages); } },
  ];
  return jumps.concat(tools);
}
function openPalette() {
  $("palette").classList.remove("hidden");
  $("paletteInput").value = "";
  renderPalette("");
  $("paletteInput").focus();
}
function renderPalette(q) {
  const items = commands().filter((c) => c.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  $("paletteList").innerHTML = items.map((c, i) => `<button class="item ${i === 0 ? "on" : ""}" type="button" data-i="${i}"><span>${escapeHtml(c.label)}</span><span class="mini">${escapeHtml(c.hint)}</span></button>`).join("");
  $("paletteList")._items = items;
}

function selectTab(tab) {
  state.tab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (tab === "code") { $("railTitle").textContent = "File preview"; $("railHint").textContent = "Open a code attachment."; }
  if (tab === "inspect") renderInspect();
  if (tab === "bots") renderBots();
  if (tab === "flow") renderFlow();
  if (tab === "snips") renderSnips();
  if (tab === "tools") renderTools();
  if (tab === "prefs") renderPrefs();
}
function renderInspect() {
  $("railTitle").textContent = "Inspector";
  const d = state.dialogs.find((x) => x.id === state.peer);
  const msg = state.messages.find((m) => m.id === state.selected);
  $("railHint").textContent = msg ? "Message " + msg.id : "Select a message, or inspect the peer.";
  const peerKv = d ? `<div class="kv"><span>name</span><b>${escapeHtml(d.name)}</b><span>id</span><b class="mono">${escapeHtml(d.id)}</b><span>kind</span><b>${escapeHtml(d.kind)}</b><span>user</span><b>${escapeHtml(d.username || "-")}</b><span>unread</span><b>${d.unread || 0}</b></div>` : `<p class="hint">No chat open.</p>`;
  const raw = msg ? escapeHtml(JSON.stringify(msg, null, 2)) : "Select inspect on a message.";
  $("preview").innerHTML = peerKv + `<pre class="block"><code>${raw}</code></pre><button class="ghost" type="button" id="loadRaw">Load MTProto JSON</button>`;
}
function renderBots() {
  $("railTitle").textContent = "Bot workbench";
  $("railHint").textContent = "Calls api.telegram.org through this local server. Token stays in this browser.";
  const token = localStorage.getItem("bt_bot") || "";
  $("preview").innerHTML = `<div class="stack">
    <input id="botToken" placeholder="123456:bot-token" value="${escapeHtml(token)}" />
    <div class="inserts">
      <button type="button" data-bot="getMe">getMe</button>
      <button type="button" data-bot="getWebhookInfo">webhook</button>
      <button type="button" data-bot="getUpdates">updates</button>
      <button type="button" data-bot="getMyCommands">commands</button>
      <button type="button" data-bot="deleteWebhook">deleteWebhook</button>
      <button type="button" data-bot="getChatAdministrators">admins</button>
    </div>
    <input id="botChat" placeholder="chat id for sendMessage / admins" />
    <textarea id="botText" placeholder="message text" style="min-height:68px"></textarea>
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <select id="botParse" style="width:auto;"><option value="">plain</option><option>MarkdownV2</option><option>HTML</option></select>
      <label class="hint" style="display:flex; gap:4px; align-items:center;"><input type="checkbox" id="botNoPreview" style="width:auto;" /> no link preview</label>
    </div>
    <button class="primary" type="button" id="botSend">sendMessage</button>
    <div class="inserts">
      <input id="botCbq" placeholder="callback_query_id" style="width:170px;" />
      <button type="button" data-bot="answerCallbackQuery">answerCallback</button>
    </div>
    <pre class="block" id="botOut"><code>Ready.</code></pre>
  </div>`;
}
async function runBot(method, params) {
  const token = $("botToken").value.trim();
  localStorage.setItem("bt_bot", token);
  $("botOut").textContent = "Calling " + method + "...";
  if (state.demo && !token) {
    $("botOut").textContent = JSON.stringify({ ok: true, demo: true, method, result: { username: "platform_alerts_bot" } }, null, 2);
    return;
  }
  try {
    const data = await api("/api/bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, method, params: params || {} }) });
    $("botOut").textContent = JSON.stringify(data, null, 2);
    const log = JSON.parse(localStorage.getItem("bt_botlog") || "[]");
    log.unshift({ at: new Date().toISOString(), method, ok: data.ok });
    localStorage.setItem("bt_botlog", JSON.stringify(log.slice(0, 20)));
  } catch (e) { $("botOut").textContent = e.message; }
}
function linksInThread() {
  const found = [];
  state.messages.forEach((m) => {
    const re = /https?:\/\/[^\s)]+/g;
    let match;
    while ((match = re.exec(m.text || ""))) found.push(match[0]);
  });
  return [...new Set(found)];
}
function renderFlow() {
  $("railTitle").textContent = "Workflow";
  const links = linksInThread();
  $("railHint").textContent = links.length + " links in the open thread.";
  $("preview").innerHTML = links.map((url) => githubCard(url) || `<a class="card" href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><b>link</b><span>${escapeHtml(url)}</span></a>`).join("") || `<p class="hint">No links in the loaded messages.</p>`;
}
function renderSnips() {
  $("railTitle").textContent = "Snippets";
  $("railHint").textContent = "Local only. Insert into the composer.";
  $("preview").innerHTML = snippets.map((s, i) => `<div class="snippet"><b>${escapeHtml(s.name)}</b> <span class="kind">${escapeHtml(s.lang)}</span><div class="fence-bar"><span></span><span><button class="ghost" type="button" data-snip="${i}">insert</button> <button class="ghost" type="button" data-del="${i}">delete</button></span></div></div>`).join("")
    + `<div class="stack"><input id="snipName" placeholder="name" /><input id="snipLang" placeholder="lang" value="python" /><textarea id="snipBody" style="min-height:70px" placeholder="body"></textarea><button class="primary" type="button" id="snipSave">Save snippet</button></div>`;
}
function b64url(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = pad + "=".repeat((4 - pad.length % 4) % 4);
  const bin = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function renderTools() {
  $("railTitle").textContent = "Tools";
  $("railHint").textContent = "Local helpers. Nothing here is sent unless you insert it into a chat.";
  $("preview").innerHTML = `<div class="stack">
    <div class="tool-block"><h4>Thread stats</h4><button class="ghost" type="button" id="statBtn">Count this thread</button><pre class="block" id="statOut"><code>Loaded messages only.</code></pre></div>
    <div class="tool-block"><h4>Regex against thread</h4><input id="toolRe" placeholder="error|TODO|FIXME" /><button class="ghost" type="button" id="toolReBtn">Test</button><pre class="block" id="toolReOut"><code></code></pre></div>
    <div class="tool-block"><h4>JSON</h4><textarea id="toolJson" style="min-height:60px" placeholder="{ }"></textarea><button class="ghost" type="button" id="jsonPretty">Pretty</button> <button class="ghost" type="button" id="jsonMin">Minify</button> <button class="ghost" type="button" id="jsonInsert">Insert</button></div>
    <div class="tool-block"><h4>JWT decode</h4><textarea id="toolJwt" style="min-height:48px" placeholder="header.payload.sig"></textarea><button class="ghost" type="button" id="jwtBtn">Decode</button><pre class="block" id="jwtOut"><code>No signature check. Decode only.</code></pre></div>
    <div class="tool-block"><h4>Encode / hash</h4><textarea id="toolRaw" style="min-height:48px" placeholder="text"></textarea><button class="ghost" type="button" id="b64e">Base64</button> <button class="ghost" type="button" id="b64d">Decode</button> <button class="ghost" type="button" id="shaBtn">SHA-256</button><pre class="block" id="encOut"><code></code></pre></div>
    <div class="tool-block"><h4>Unix time</h4><input id="toolTs" placeholder="seconds or ms" /><button class="ghost" type="button" id="tsBtn">Convert</button> <button class="ghost" type="button" id="nowBtn">Now</button><pre class="block" id="tsOut"><code></code></pre></div>
    <div class="tool-block"><h4>Peer id</h4><input id="toolPeer" placeholder="-100123 or user id" /><button class="ghost" type="button" id="peerBtn">Explain</button><pre class="block" id="peerOut"><code></code></pre></div>
    <div class="tool-block"><h4>Inline keyboard</h4><input id="kbLabel" placeholder="button label" /><input id="kbData" placeholder="callback_data" /><button class="ghost" type="button" id="kbInsert">Insert reply_markup JSON</button></div>
  </div>`;
}
function renderPrefs() {
  $("railTitle").textContent = "Settings";
  $("railHint").textContent = "Telegram account settings, plus Backtick-only options.";
  $("preview").innerHTML = `<div class="stack" id="settingsRoot"><p class="hint">Loading Telegram settings…</p></div>`;
  loadSettings();
}
async function loadSettings() {
  const local = `<div class="tool-block"><h4>Backtick privacy</h4>
    <p class="hint">These hide data in this client only. They do not change who can see you on Telegram.</p>
    <label class="field"><input id="prefHidePhone" type="checkbox" ${settings.hidePhone ? "checked" : ""}/> hide phone number</label>
    <label class="field"><input id="prefHideUser" type="checkbox" ${settings.hideUsernames ? "checked" : ""}/> hide usernames</label>
    <label class="field"><input id="prefHidePrev" type="checkbox" ${settings.hidePreviews ? "checked" : ""}/> hide sidebar previews</label>
    <label class="field"><input id="prefReveal" type="checkbox" ${settings.revealClick ? "checked" : ""}/> hide message text until clicked</label>
    <label class="field"><input id="prefIds" type="checkbox" ${settings.showIds ? "checked" : ""}/> show peer ids</label>
    <label class="field"><input id="prefLinks" type="checkbox" ${settings.linkCards ? "checked" : ""}/> GitHub and GitLab cards</label>
  </div>
  <div class="tool-block"><h4>Backtick notifications</h4>
    <p class="hint">Local alerts while this tab is open. Not Telegram push.</p>
    <label class="field"><input id="prefNotify" type="checkbox" ${settings.notify ? "checked" : ""}/> desktop notifications</label>
    <label class="field"><input id="prefSound" type="checkbox" ${settings.notifySound ? "checked" : ""}/> sound</label>
    <label class="field"><input id="prefPrevNote" type="checkbox" ${settings.notifyPreview ? "checked" : ""}/> include message preview</label>
    <label class="field"><input id="prefMuteBots" type="checkbox" ${settings.muteBots ? "checked" : ""}/> mute bots</label>
    <label class="field"><input id="prefMuteChan" type="checkbox" ${settings.muteChannels ? "checked" : ""}/> mute channels</label>
  </div>
  <div class="tool-block"><h4>Backtick session</h4>
    <p class="hint">This browser and the session file on the machine running the server.</p>
    <label class="field"><input id="prefRemember" type="checkbox" ${settings.rememberBrowser ? "checked" : ""}/> remember session in this browser</label>
    <label class="field">idle lock minutes <input id="prefIdle" type="number" min="0" max="240" value="${settings.idleLock || 0}" /></label>
    <button class="ghost" type="button" id="forgetBrowser">Forget browser session</button>
    <button class="ghost" type="button" id="forgetFile">Forget server session file</button>
  </div>
  <div class="tool-block"><h4>Backtick appearance</h4>
    <label class="field">accent <select id="prefAccent"><option>mint</option><option>amber</option><option>violet</option><option>blue</option></select></label>
    <label class="field">mono size <input id="prefMono" type="number" min="11" max="18" value="${settings.mono}" /></label>
    <label class="field"><input id="prefRel" type="checkbox" ${settings.relative ? "checked" : ""}/> relative timestamps</label>
    <label class="field"><input id="prefEnter" type="checkbox" ${settings.enterSend ? "checked" : ""}/> Enter sends</label>
    <label class="field"><input id="prefConfirm" type="checkbox" ${settings.confirmSend ? "checked" : ""}/> confirm before send</label>
    <label class="field"><input id="prefCompact" type="checkbox" ${settings.compact ? "checked" : ""}/> compact messages</label>
    <label class="field"><input id="prefDrafts" type="checkbox" ${settings.drafts ? "checked" : ""}/> keep a draft per chat</label>
    <label class="field"><input id="prefClock" type="checkbox" ${settings.clock24 ? "checked" : ""}/> 24-hour clock</label>
    <button class="primary" type="button" id="saveLocal">Save Backtick settings</button>
  </div>`;
  if (state.demo) {
    $("settingsRoot").innerHTML = `<p class="hint">Demo account. Sign in to edit Telegram privacy, profile, and sessions.</p>` + local;
    $("prefAccent").value = settings.accent;
    return;
  }
  try {
    const data = await api("/api/settings");
    const p = data.profile;
    const keys = Object.keys(data.privacy);
    const privacy = keys.map((k) => `<label class="field">${k.replaceAll("_", " ")}
      <select data-priv="${k}"><option>everyone</option><option>contacts</option><option>nobody</option></select></label>`).join("");
    const sessions = data.sessions.map((s) => `<div class="snippet"><b>${escapeHtml(s.device || "device")}</b> <span class="kind">${escapeHtml(s.platform || "")}</span><div class="hint">${escapeHtml(s.app || "")} · ${escapeHtml(s.country || "")} · ${s.current ? "this session" : ""}</div>${s.current ? "" : `<button class="ghost" type="button" data-kill="${s.hash}">Terminate</button>`}</div>`).join("");
    $("settingsRoot").innerHTML = `<div class="tool-block"><h4>Account</h4>
      <div class="kv"><span>id</span><b>${p.id}</b><span>phone</span><b>${escapeHtml(p.phone || "")}</b><span>user</span><b>${escapeHtml(p.username || "-")}</b></div>
      <input id="setFirst" placeholder="first name" value="${escapeHtml(p.first_name)}" />
      <input id="setLast" placeholder="last name" value="${escapeHtml(p.last_name)}" />
      <textarea id="setAbout" style="min-height:52px" placeholder="bio, 70 characters">${escapeHtml(p.about || "")}</textarea>
      <button class="primary" type="button" id="saveProfile">Save profile</button>
    </div>
    <div class="tool-block"><h4>Privacy</h4><p class="hint">Who can see this. Custom exception lists stay as custom until you pick a broad rule.</p>${privacy}<button class="primary" type="button" id="savePrivacy">Save privacy</button></div>
    <div class="tool-block"><h4>Devices</h4>${sessions || "<p class='hint'>No other sessions.</p>"}</div>` + local;
    keys.forEach((k) => {
      const sel = document.querySelector(`[data-priv="${k}"]`);
      if (sel && ["everyone", "contacts", "nobody"].includes(data.privacy[k])) sel.value = data.privacy[k];
    });
    $("prefAccent").value = settings.accent;
  } catch (e) {
    $("settingsRoot").innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>` + local;
  }
}

function demoMessages() {
  return [
    { id: 11, out: false, sender: "Ada", date: "2026-10-01T15:02:00", text: "Webhook handler is dropping the hash on retry. Patch:\n\n```diff\n- digest = hmac.new(key, body).hexdigest()\n+ digest = hmac.new(key, body, hashlib.sha256).hexdigest()\n```\nhttps://github.com/backtick/api/pull/128" },
    { id: 12, out: true, sender: "you", date: "2026-10-01T15:06:00", text: "Good catch. Shipping this:\n\n```python\ndef verify(secret: str, body: bytes, header: str) -> bool:\n    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()\n    return hmac.compare_digest(expected, header)\n```" },
    { id: 13, out: false, sender: "platform-alerts", date: "2026-10-01T15:11:00", text: "CI green on `main`. Preview file attached.", file_name: "verify.py", media_kind: "code" },
  ];
}
function demo() {
  state.demo = true;
  state.me = { name: "Demo User", username: "demo_user" };
  state.dialogs = [
    { id: "1", name: "platform-alerts", username: "platform_alerts_bot", kind: "bot", unread: 3, last: "deploy prod failed on migrate" },
    { id: "2", name: "api-review", username: null, kind: "group", unread: 0, last: "left a diff on the webhook handler" },
    { id: "3", name: "Ada Lovelace", username: "ada", kind: "user", unread: 1, last: "pushed the session fix" },
  ];
  $("auth").classList.add("hidden");
  $("shell").classList.remove("hidden");
  $("meLabel").textContent = "@demo_user";
  state.peer = "2";
  paintChats();
  $("peerName").textContent = "api-review";
  $("peerSub").textContent = "group · demo data, not your Telegram account";
  paint(demoMessages());
  $("railTitle").textContent = "verify.py";
  $("railHint").textContent = "412 bytes · python · demo";
  $("preview").innerHTML = renderFence("def verify(secret: str, body: bytes, header: str) -> bool:\n    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()\n    return hmac.compare_digest(expected, header)\n", "python");
  setStatus("backtick · demo");
}
async function boot() {
  if (location.protocol === "file:" || new URLSearchParams(location.search).has("demo")) {
    demo();
    return;
  }
  const c = creds();
  if (c.session && c.api_id && c.api_hash) {
    try {
      const data = await api("/api/auth/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
      enter(data.me);
      return;
    } catch (e) { localStorage.removeItem("bt_session"); }
  }
}
$("demoBtn").onclick = (ev) => {
  ev.preventDefault();
  try { demo(); }
  catch (e) {
    const err = $("authErr");
    if (err) err.textContent = e.message;
  }
};
function enter(me) {
  state.me = me;
  $("auth").classList.add("hidden");
  $("shell").classList.remove("hidden");
  const handle = settings.hideUsernames ? "" : (me.username ? "@" + me.username : "");
  $("meLabel").textContent = handle || me.name || "you";
  armNotify();
  armIdle();
  connectLive();
  loadDialogs();
}
let lastUnread = 0;
let notifyTimer = null;
let idleTimer = null;
function armNotify() {
  if (notifyTimer) clearInterval(notifyTimer);
  if (!settings.notify || state.demo) return;
  if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
  notifyTimer = setInterval(pollNotify, 20000);
}
async function pollNotify() {
  if (state.demo) return;
  try {
    const data = await api("/api/dialogs?limit=30");
    // When the live socket is up it handles notifications itself; the poll
    // is then just a silent count sync (and a fallback notifier when offline).
    const liveNow = !!ws && ws.readyState === 1;
    const unread = data.dialogs.filter((d) => {
      if (settings.muteBots && d.kind === "bot") return false;
      if (settings.muteChannels && d.kind === "channel") return false;
      return d.unread;
    });
    const count = unread.reduce((n, d) => n + d.unread, 0);
    if (!liveNow && count > lastUnread && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
      const top = unread[0];
      new Notification(top ? top.name : "Backtick", { body: settings.notifyPreview && top ? top.last : "New messages" });
      if (settings.notifySound) beep();
    }
    lastUnread = count;
  } catch (e) {}
}
function beep() {
  const ctx = new AudioContext();
  const o = ctx.createOscillator();
  o.frequency.value = 660;
  o.connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.08);
}
let ws = null;
function connectLive() {
  if (state.demo || ws || !state.me) return;
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  try {
    ws = new WebSocket(proto + location.host + "/api/ws");
  } catch (e) { ws = null; return; }
  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    if (data.type === "error") { setStatus("backtick · live updates unavailable"); ws.close(); return; }
    if (data.type === "message") onLiveMessage(data.peer, data.message);
  };
  ws.onclose = () => {
    ws = null;
    if (!state.demo && state.me) setTimeout(connectLive, 3000);
  };
}
function onLiveMessage(peer, m) {
  if (peer === state.peer && state.openIds.has(m.id)) {
    // Already on screen (echo of our own send, or an edit from another device): update in place.
    const i = state.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) state.messages[i] = m;
    paint(state.messages);
    return;
  }
  state.openIds.add(m.id);
  if (peer === state.peer) {
    state.messages.push(m);
    paint(state.messages);
  }
  const d = state.dialogs.find((x) => x.id === peer);
  if (d) {
    if (!m.out) d.unread = (d.unread || 0) + 1;
    d.last = (m.text || "").replace(/\n/g, " ").slice(0, 140) || (m.file_name ? "[file]" : d.last);
    state.dialogs = [d, ...state.dialogs.filter((x) => x !== d)];
    paintChats();
  } else {
    loadDialogs();
  }
  if (!m.out && settings.notify && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
    const muted = (settings.muteBots && d && d.kind === "bot") || (settings.muteChannels && d && d.kind === "channel");
    if (!muted) {
      const total = state.dialogs.reduce((n, x) => n + (x.unread || 0), 0);
      if (total > lastUnread) {
        new Notification(d ? d.name : "Backtick", { body: settings.notifyPreview && d ? d.last : "New messages" });
        if (settings.notifySound) beep();
      }
      lastUnread = total;
    }
  }
}
function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!settings.idleLock) return;
  const reset = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      $("shell").classList.add("hidden");
      $("auth").classList.remove("hidden");
      $("authErr").textContent = "Locked after idle. Reload and restore the session to continue.";
    }, settings.idleLock * 60000);
  };
  ["mousemove", "keydown"].forEach((ev) => document.addEventListener(ev, reset));
  reset();
}

buildInserts();
$("codeBtn").onclick = async () => {
  $("authErr").textContent = "";
  const fd = new FormData($("authForm"));
  try {
    await api("/api/auth/send-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_id: Number(fd.get("api_id")), api_hash: fd.get("api_hash"), phone: fd.get("phone") }) });
    localStorage.setItem("bt_api_id", fd.get("api_id"));
    localStorage.setItem("bt_api_hash", fd.get("api_hash"));
    $("authErr").textContent = "Code sent. Check Telegram, then sign in.";
  } catch (e) { $("authErr").textContent = e.message; }
};
$("authForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const fd = new FormData($("authForm"));
  try {
    const data = await api("/api/auth/sign-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: fd.get("code") || "", password: fd.get("password") || "" }) });
    if (data.needs_password) {
      $("passField").classList.remove("hidden");
      $("authForm").elements.code.value = "";
      $("authErr").textContent = "This account has 2FA. Enter the cloud password and sign in again.";
      return;
    }
    localStorage.setItem("bt_session", data.session);
    if (!settings.rememberBrowser) localStorage.removeItem("bt_session");
    localStorage.setItem("bt_api_id", fd.get("api_id"));
    localStorage.setItem("bt_api_hash", fd.get("api_hash"));
    enter(data.me);
  } catch (e) { $("authErr").textContent = e.message; }
};
$("filters").onclick = (ev) => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  state.filter = btn.dataset.filter;
  document.querySelectorAll("#filters button").forEach((b) => b.classList.toggle("on", b === btn));
  paintChats();
};
$("chats").onclick = (ev) => {
  const star = ev.target.closest("[data-star]");
  if (star) {
    const id = star.dataset.star;
    bookmarks.has(id) ? bookmarks.delete(id) : bookmarks.add(id);
    saveMarks();
    paintChats();
    return;
  }
  const row = ev.target.closest(".chat");
  if (row) openPeer(row.dataset.id);
};
$("chatFilter").oninput = () => paintChats();
async function uploadFile(file) {
  if (!file || !state.peer) return;
  if (state.demo) { setStatus("backtick · upload needs a signed-in server"); return; }
  const started = performance.now();
  setStatus("backtick · uploading " + file.name + " in 512KB parts");
  const body = new FormData();
  body.append("peer", state.peer);
  body.append("caption", $("draft").value);
  body.append("upload", file);
  let data;
  try {
    const res = await fetch("/api/upload", { method: "POST", body });
    data = await res.json();
    if (!res.ok) throw new Error(data.detail || "upload failed");
  } catch (e) { setStatus("backtick · " + e.message); return; }
  const seconds = (performance.now() - started) / 1000;
  const mbps = (file.size / 1e6 / seconds).toFixed(2);
  setStatus("backtick · uploaded " + file.name + " at " + mbps + " MB/s");
  state.messages.push(data.message);
  state.openIds.add(data.message.id);
  paint(state.messages);
  $("filePick").value = "";
}
$("filePick").onchange = () => uploadFile($("filePick").files[0]);
{
  // Drag & drop files onto the thread to upload them.
  const threadEl = document.querySelector(".thread");
  let dragDepth = 0;
  threadEl.addEventListener("dragenter", (ev) => { ev.preventDefault(); dragDepth++; threadEl.classList.add("dropping"); });
  threadEl.addEventListener("dragover", (ev) => ev.preventDefault());
  threadEl.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; threadEl.classList.remove("dropping"); } });
  threadEl.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    threadEl.classList.remove("dropping");
    const files = [...(ev.dataTransfer ? ev.dataTransfer.files : [])];
    if (!files.length) return;
    if (!state.peer || state.demo) { setStatus("backtick · open a chat to drop files"); return; }
    files.forEach(uploadFile);
  });
}
$("composer").onsubmit = async (ev) => {
  ev.preventDefault();
  if (!state.peer) return;
  const text = $("draft").value;
  if (!text.trim()) return;
  if (settings.confirmSend && !confirm("Send this message?")) return;
  if (state.editing) {
    const id = state.editing;
    if (state.demo) {
      const m = state.messages.find((x) => x.id === id);
      if (m) { m.text = text; m.edited = true; }
      $("draft").value = "";
      cancelEdit();
      paint(state.messages);
      return;
    }
    try {
      const data = await api("/api/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ peer: state.peer, msg_id: id, text }) });
      const i = state.messages.findIndex((x) => x.id === id);
      if (i >= 0) state.messages[i] = data.message;
      $("draft").value = "";
      cancelEdit();
      paint(state.messages);
      setStatus("backtick · message edited");
    } catch (e) { setStatus("backtick · " + e.message); }
    return;
  }
  if (state.demo) {
    const m = { id: Date.now(), out: true, sender: "you", date: new Date().toISOString(), text };
    state.messages.push(m);
    state.openIds.add(m.id);
    $("draft").value = "";
    paint(state.messages);
    return;
  }
  doSend(text, false);
};

async function doSend(text, retried) {
  let data;
  try {
    data = await api("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ peer: state.peer, text, reply_to: state.replyTo }) });
  } catch (e) {
    const m = /Retry in (\d+)s/.exec(e.message || "");
    if (m && !retried) {
      const secs = Number(m[1]);
      setStatus(`backtick · Telegram rate limit, retrying in ${secs}s`);
      setTimeout(() => doSend(text, true), secs * 1000);
      return;
    }
    setStatus("backtick · " + e.message);
    return;
  }
  const sent = data.messages || [data.message];
  sent.forEach((msg) => { state.messages.push(msg); state.openIds.add(msg.id); });
  $("draft").value = "";
  state.replyTo = null;
  $("replyHint").textContent = "";
  paint(state.messages);
  if (data.split) setStatus(`backtick · sent as ${data.split} messages`);
}
$("draft").onkeydown = (ev) => {
  if (ev.key === "Escape" && state.editing) { ev.preventDefault(); cancelEdit(); return; }
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey || (settings.enterSend && !ev.shiftKey))) {
    ev.preventDefault();
    $("composer").requestSubmit();
  }
  if (ev.key === "`" && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    const el = $("draft");
    const selected = el.value.slice(el.selectionStart, el.selectionEnd) || "code";
    el.setRangeText("```\n" + selected + "\n```", el.selectionStart, el.selectionEnd, "end");
  }
};
$("clearReply").onclick = () => { state.replyTo = null; $("replyHint").textContent = ""; };
$("attachBtn").onclick = () => $("filePick").click();
$("log").onclick = async (ev) => {
  if (ev.target.id === "loadOlder") { loadOlder(); return; }
  const jump = ev.target.closest("[data-jump]");
  if (jump) { openPeer(jump.dataset.jump); return; }
  const go = ev.target.closest("[data-goto]");
  if (go) {
    const el = document.querySelector(`#log article[data-id="${go.dataset.goto}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    } else {
      setStatus("backtick · quoted message is not loaded");
    }
    return;
  }
  const thumb = ev.target.closest("[data-full]");
  if (thumb) {
    if (state.demo || !thumb.dataset.peer) return;
    selectTab("code");
    const pq = `peer=${encodeURIComponent(thumb.dataset.peer)}&msg_id=${thumb.dataset.full}`;
    $("railTitle").textContent = "Photo";
    $("railHint").textContent = "full size · click to open";
    $("preview").innerHTML = `<a href="/api/media?${pq}" target="_blank" rel="noreferrer"><img style="max-width:100%; border-radius:8px;" src="/api/media?${pq}" alt="photo" /></a>`;
    return;
  }
  const locked = ev.target.closest(".body.locked");
  if (locked) { locked.classList.remove("locked"); return; }
  const copy = ev.target.closest("[data-copy]");
  if (copy) { await navigator.clipboard.writeText(decodeURIComponent(copy.dataset.copy)); copy.textContent = "copied"; return; }
  const act = ev.target.closest("[data-act]");
  if (act) {
    state.selected = Number(act.dataset.id);
    const msg = state.messages.find((m) => m.id === state.selected);
    if (act.dataset.act === "quote" && msg) {
      state.replyTo = msg.id;
      $("replyHint").textContent = "replying to " + msg.id;
      insertAtCursor("> " + (msg.text || "").split("\n")[0] + "\n");
    }
    if (act.dataset.act === "fence" && msg) insertAtCursor("```\n" + (msg.text || "") + "\n```");
    if (act.dataset.act === "edit" && msg) { startEdit(msg); return; }
    if (act.dataset.act === "del" && msg) { deleteMessage(msg); return; }
    if (act.dataset.act === "inspect") selectTab("inspect");
    return;
  }
  const file = ev.target.closest("[data-file]");
  if (!file || !state.peer) return;
  selectTab("code");
  if (state.demo) return;
  const res = await fetch(`/api/file?peer=${encodeURIComponent(state.peer)}&msg_id=${file.dataset.file}`);
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const data = await res.json();
    $("railTitle").textContent = data.name;
    $("railHint").textContent = data.bytes + " bytes · " + (data.lang || "text");
    $("preview").innerHTML = renderFence(data.text, data.lang);
  } else {
    const blob = await res.blob();
    $("preview").innerHTML = `<a href="${URL.createObjectURL(blob)}" download>Download</a>`;
  }
};
$("searchToggle").onclick = () => { $("threadSearch").classList.toggle("hidden"); $("threadQuery").focus(); };
$("runSearch").onclick = async () => {
  if (state.demo) return;
  const q = $("threadQuery").value.trim();
  if (!q) return;
  try {
    if ($("searchAll").checked) {
      const data = await api("/api/gsearch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q, limit: 30 }) });
      state.showOlder = false;
      paint(data.messages.slice().reverse());
      setStatus("backtick · " + data.messages.length + " hits everywhere");
      return;
    }
    if (!state.peer) return;
    let query = q;
    const regex = query.startsWith("/re ");
    if (regex) query = query.slice(4);
    const data = await api("/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ peer: state.peer, query, regex }) });
    state.showOlder = false;
    paint(data.messages.slice().reverse());
    setStatus("backtick · " + data.messages.length + " hits");
  } catch (e) { setStatus("backtick · " + e.message); }
};
$("exportBtn").onclick = () => {
  if (!state.peer) return;
  if (state.demo) {
    const blob = new Blob(["# api-review\n\ndemo export\n"], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "api-review.md";
    a.click();
    return;
  }
  window.location = "/api/export?peer=" + encodeURIComponent(state.peer);
};
$("readBtn").onclick = async () => {
  if (!state.peer || state.demo) return;
  await api("/api/read?peer=" + encodeURIComponent(state.peer), { method: "POST" });
  setStatus("backtick · marked read");
};
$("logoutBtn").onclick = async () => {
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  if (!state.demo) await api("/api/auth/logout", { method: "POST" });
  localStorage.removeItem("bt_session");
  location.href = "/";
};
$("chatsToggle").onclick = () => { $("shell").classList.toggle("show-chats"); $("shell").classList.remove("show-rail"); };
$("railToggle").onclick = () => { $("shell").classList.toggle("show-rail"); $("shell").classList.remove("show-chats"); };
$("paletteBtn").onclick = openPalette;
$("palette").onclick = (ev) => { if (ev.target.id === "palette") $("palette").classList.add("hidden"); };
$("paletteInput").oninput = (ev) => renderPalette(ev.target.value);
$("paletteForm").onsubmit = (ev) => {
  ev.preventDefault();
  const item = ($("paletteList")._items || [])[0];
  if (item) item.run();
  $("palette").classList.add("hidden");
};
$("paletteList").onclick = (ev) => {
  const btn = ev.target.closest("[data-i]");
  if (!btn) return;
  $("paletteList")._items[Number(btn.dataset.i)].run();
  $("palette").classList.add("hidden");
};
$("tabs").onclick = (ev) => { const btn = ev.target.closest("button"); if (btn) selectTab(btn.dataset.tab); };
$("preview").onclick = async (ev) => {
  const bot = ev.target.closest("[data-bot]");
  if (bot) {
    const method = bot.dataset.bot;
    const params = method === "getUpdates" ? { limit: 5 } : {};
    if ((method === "getChatAdministrators" || method === "getChat") && $("botChat").value.trim()) {
      params.chat_id = $("botChat").value.trim();
    }
    if (method === "answerCallbackQuery") {
      if (!$("botCbq").value.trim()) { $("botOut").textContent = "Enter a callback_query_id first."; return; }
      params.callback_query_id = $("botCbq").value.trim();
      params.text = "ack";
    }
    return runBot(method, params);
  }
  if (ev.target.id === "botSend") {
    const params = { chat_id: $("botChat").value, text: $("botText").value };
    if ($("botParse").value) params.parse_mode = $("botParse").value;
    if ($("botNoPreview").checked) params.disable_web_page_preview = true;
    return runBot("sendMessage", params);
  }
  if (ev.target.id === "snipSave") {
    snippets.push({ name: $("snipName").value || "snippet", lang: $("snipLang").value || "text", body: $("snipBody").value });
    saveSnips();
    renderSnips();
  }
  const snip = ev.target.closest("[data-snip]");
  if (snip) insertAtCursor("```" + snippets[snip.dataset.snip].lang + "\n" + snippets[snip.dataset.snip].body + "\n```");
  const del = ev.target.closest("[data-del]");
  if (del) { snippets.splice(Number(del.dataset.del), 1); saveSnips(); renderSnips(); }
  if (ev.target.id === "loadRaw" && state.selected && !state.demo) {
    const data = await api(`/api/raw?peer=${encodeURIComponent(state.peer)}&msg_id=${state.selected}`);
    $("preview").insertAdjacentHTML("beforeend", `<pre class="block"><code>${escapeHtml(JSON.stringify(data.message, null, 2))}</code></pre>`);
  }
  if (ev.target.id === "statBtn") {
    const msgs = state.messages;
    const links = linksInThread().length;
    const fences = msgs.reduce((n, m) => n + ((m.text || "").match(/```/g) || []).length / 2, 0);
    const files = msgs.filter((m) => m.file_name).length;
    $("statOut").textContent = JSON.stringify({ messages: msgs.length, out: msgs.filter((m) => m.out).length, links, fences: Math.floor(fences), files }, null, 2);
  }
  if (ev.target.id === "toolReBtn") {
    try {
      const re = new RegExp($("toolRe").value, "i");
      const hits = state.messages.filter((m) => re.test(m.text || "")).slice(0, 8).map((m) => (m.sender || "") + ": " + (m.text || "").slice(0, 80));
      $("toolReOut").textContent = hits.join("\n") || "No matches in loaded messages.";
    } catch (e) { $("toolReOut").textContent = e.message; }
  }
  if (ev.target.id === "jsonPretty" || ev.target.id === "jsonMin") {
    try {
      const obj = JSON.parse($("toolJson").value);
      $("toolJson").value = ev.target.id === "jsonMin" ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
    } catch (e) { $("toolJson").value = e.message; }
  }
  if (ev.target.id === "jsonInsert") insertAtCursor("```json\n" + $("toolJson").value + "\n```");
  if (ev.target.id === "jwtBtn") {
    try {
      const parts = $("toolJwt").value.trim().split(".");
      $("jwtOut").textContent = JSON.stringify({ header: JSON.parse(b64url(parts[0])), payload: JSON.parse(b64url(parts[1])) }, null, 2);
    } catch (e) { $("jwtOut").textContent = "Could not decode: " + e.message; }
  }
  if (ev.target.id === "b64e") $("encOut").textContent = btoa(unescape(encodeURIComponent($("toolRaw").value)));
  if (ev.target.id === "b64d") {
    try { $("encOut").textContent = decodeURIComponent(escape(atob($("toolRaw").value.trim()))); }
    catch (e) { $("encOut").textContent = e.message; }
  }
  if (ev.target.id === "shaBtn") {
    crypto.subtle.digest("SHA-256", new TextEncoder().encode($("toolRaw").value)).then((buf) => {
      $("encOut").textContent = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    });
  }
  if (ev.target.id === "nowBtn") $("toolTs").value = String(Math.floor(Date.now() / 1000));
  if (ev.target.id === "tsBtn") {
    const n = Number($("toolTs").value);
    const ms = n < 1e12 ? n * 1000 : n;
    $("tsOut").textContent = new Date(ms).toISOString();
  }
  if (ev.target.id === "peerBtn") {
    const n = $("toolPeer").value.trim();
    let note = "User ids are positive. Basic groups are negative. Channels and supergroups look like -100 plus the channel id.";
    if (n.startsWith("-100")) note = "Supergroup or channel. Channel id " + n.slice(4) + ". Marked peer id " + n + ".";
    $("peerOut").textContent = note;
  }
  if (ev.target.id === "kbInsert") {
    const markup = { inline_keyboard: [[{ text: $("kbLabel").value || "Ack", callback_data: $("kbData").value || "ack" }]] };
    insertAtCursor("```json\n" + JSON.stringify(markup, null, 2) + "\n```");
  }
  if (ev.target.id === "saveLocal") {
    settings.accent = $("prefAccent").value;
    settings.mono = Number($("prefMono").value);
    settings.relative = $("prefRel").checked;
    settings.enterSend = $("prefEnter").checked;
    settings.showIds = $("prefIds").checked;
    settings.hidePhone = $("prefHidePhone").checked;
    settings.hideUsernames = $("prefHideUser").checked;
    settings.hidePreviews = $("prefHidePrev").checked;
    settings.revealClick = $("prefReveal").checked;
    settings.notify = $("prefNotify").checked;
    settings.notifySound = $("prefSound").checked;
    settings.notifyPreview = $("prefPrevNote").checked;
    settings.muteBots = $("prefMuteBots").checked;
    settings.muteChannels = $("prefMuteChan").checked;
    settings.rememberBrowser = $("prefRemember").checked;
    settings.idleLock = Number($("prefIdle").value || 0);
    settings.confirmSend = $("prefConfirm").checked;
    settings.linkCards = $("prefLinks").checked;
    settings.compact = $("prefCompact").checked;
    settings.drafts = $("prefDrafts").checked;
    settings.clock24 = $("prefClock").checked;
    savePrefs();
    if (!settings.rememberBrowser) localStorage.removeItem("bt_session");
    paint(state.messages);
    paintChats();
    applyPrivacyChrome();
    armNotify();
    setStatus("backtick · settings saved");
  }
  if (ev.target.id === "forgetBrowser") {
    localStorage.removeItem("bt_session");
    setStatus("backtick · browser session forgotten");
  }
  if (ev.target.id === "forgetFile") {
    api("/api/settings/forget-file", { method: "POST" }).then(() => setStatus("backtick · server session file removed")).catch((e) => setStatus(e.message));
  }
  if (ev.target.id === "saveProfile") {
    api("/api/settings/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ first_name: $("setFirst").value, last_name: $("setLast").value, about: $("setAbout").value }) }).then(() => setStatus("backtick · profile saved")).catch((e) => setStatus(e.message));
  }
  if (ev.target.id === "savePrivacy") {
    const jobs = [...document.querySelectorAll("[data-priv]")].map((sel) => api("/api/settings/privacy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: sel.dataset.priv, value: sel.value }) }));
    Promise.all(jobs).then(() => setStatus("backtick · privacy saved")).catch((e) => setStatus(e.message));
  }
  const kill = ev.target.closest("[data-kill]");
  if (kill) {
    api("/api/settings/sessions/terminate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hash: Number(kill.dataset.kill) }) }).then(() => loadSettings()).catch((e) => setStatus(e.message));
  }
  if (ev.target.id === "prefAccent" || ev.target.id === "prefMono" || ev.target.id === "prefRel" || ev.target.id === "prefEnter") {
    settings.accent = $("prefAccent").value;
    settings.mono = Number($("prefMono").value);
    settings.relative = $("prefRel").checked;
    settings.enterSend = $("prefEnter").checked;
    savePrefs();
    paint(state.messages);
  }
};
$("preview").onchange = $("preview").onclick;
document.addEventListener("keydown", (ev) => {
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "p") { ev.preventDefault(); openPalette(); }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); $("chatFilter").focus(); }
  if (ev.key === "Escape") $("palette").classList.add("hidden");
  if (typing || !state.dialogs.length) return;
  if (ev.key === "j" || ev.key === "k") {
    const rows = filteredDialogs();
    const idx = Math.max(0, rows.findIndex((d) => d.id === state.peer));
    const next = ev.key === "j" ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
    if (rows[next]) openPeer(rows[next].id);
  }
});
boot();
