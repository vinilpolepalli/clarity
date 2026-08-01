const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function setStatus(msg, kind = '') {
  const el = $('#status');
  el.textContent = msg;
  el.className = 'status ' + kind;
}

// ---- Minimal, safe markdown renderer (headings, bullets, code fences, bold) ----
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function renderMarkdown(md) {
  if (!md) return '';
  const parts = md.split(/```/);
  let html = '';
  parts.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const nl = chunk.indexOf('\n');
      const lang = nl >= 0 ? chunk.slice(0, nl).trim().toLowerCase() : '';
      const body = nl >= 0 ? chunk.slice(nl + 1) : chunk;
      html += `<pre><code class="lang-${lang || 'txt'}">${highlight(body.replace(/\n$/, ''))}</code></pre>`;
    } else {
      html += renderInline(chunk);
    }
  });
  return html;
}
/**
 * Small language-agnostic highlighter. Tokenises in one pass so the escaped
 * output can never be re-tokenised — highlighting user/model text must not
 * become an injection route.
 */
const KEYWORDS = new RegExp(
  '\\b(' +
    ['def','class','return','if','elif','else','for','while','in','not','and','or','import','from','as','with',
     'try','except','finally','raise','lambda','yield','pass','break','continue','async','await','global','None',
     'True','False','self','function','const','let','var','new','this','typeof','instanceof','export','default',
     'interface','type','public','private','static','void','int','float','bool','string','struct','func','package',
     'nil','null','undefined','true','false','switch','case','do','throw','extends','implements'
    ].join('|') +
    ')\\b',
  'g'
);

const LITERALS =
  /(#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|`(?:\\.|[^`\\])*`)/g;

function highlight(src) {
  // Walk the source, styling comments and strings in place and highlighting
  // only the code between them. An earlier version swapped literals for numeric
  // placeholders, which the number rule then styled as numbers — so comments
  // reappeared as stray digits. Segmenting avoids placeholders entirely.
  let out = '';
  let last = 0;
  let m;
  LITERALS.lastIndex = 0;
  while ((m = LITERALS.exec(src)) !== null) {
    out += highlightCode(src.slice(last, m.index));
    out += `<span class="${m[1] ? 'tok-cm' : 'tok-str'}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + highlightCode(src.slice(last));
}

function highlightCode(chunk) {
  if (!chunk) return '';
  return escapeHtml(chunk)
    .replace(KEYWORDS, '<span class="tok-kw">$1</span>')
    .replace(/\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>')
    .replace(/\b([A-Za-z_]\w*)(?=\s*\()/g, '<span class="tok-fn">$1</span>');
}

function renderInline(text) {
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  for (let raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (h) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h3>${fmt(h[2])}</h3>`;
    } else if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${fmt(bullet[1])}</li>`;
    } else if (line === '') {
      if (inList) { html += '</ul>'; inList = false; }
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${fmt(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}
function fmt(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Render a NIM reply. A reasoning model's scratchpad is never the answer, so
 * it is only ever shown behind an explicit "thinking" disclosure — displaying
 * it inline would pass half-finished notes off as guidance.
 */
function answerHtml(r) {
  if (r.content) return renderMarkdown(r.content);
  if (r.truncated) {
    return `<div class="hint">The model ran out of room while reasoning and never reached an answer. Try a shorter question or a non-reasoning model.</div>${thinkingHtml(r.reasoning)}`;
  }
  if (r.reasoning) {
    return `<div class="hint">No answer returned.</div>${thinkingHtml(r.reasoning)}`;
  }
  return '<div class="hint">(no content)</div>';
}
function thinkingHtml(reasoning) {
  if (!reasoning) return '';
  return `<details class="thinking"><summary>Model's reasoning</summary><div>${renderMarkdown(reasoning)}</div></details>`;
}
/** Name the model that actually served the reply, flagging any fallback. */
function modelNote(r) {
  return r.fellBackFrom ? `${r.model} (fell back from ${r.fellBackFrom})` : r.model;
}

window.__answerHtml = answerHtml; // test seam
window.__renderMarkdown = renderMarkdown; // test seam

// ---- Tabs ----
function activateTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'models') loadCatalog();
  if (name === 'settings') loadSettings();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));

// ---- Ask ----
async function doAsk() {
  const text = $('#askInput').value.trim();
  if (!text) return;
  $('#askSend').disabled = true;
  setStatus('Thinking…', 'busy');
  $('#askOut').innerHTML = '<div class="hint">Thinking…</div>';
  try {
    const r = await window.clarity.ask({ text });
    $('#askOut').innerHTML = answerHtml(r);
    setStatus(`Answered · ${modelNote(r)} · ${r.latencyMs}ms`);
  } catch (e) {
    $('#askOut').innerHTML = `<div class="hint">Error: ${escapeHtml(String(e.message || e))}</div>`;
    setStatus('Error', 'err');
  } finally {
    $('#askSend').disabled = false;
  }
}
$('#askSend').addEventListener('click', doAsk);
$('#askInput').addEventListener('keydown', (e) => e.key === 'Enter' && doAsk());

// ---- Code ----
async function doCode() {
  const text = $('#codeInput').value.trim();
  if (!text) return;
  $('#codeSend').disabled = true;
  setStatus('Generating code…', 'busy');
  $('#codeOut').innerHTML = '<div class="hint">Generating…</div>';
  try {
    const r = await window.clarity.code({ text });
    $('#codeOut').innerHTML = answerHtml(r);
    setStatus(`Code ready · ${modelNote(r)} · ${r.latencyMs}ms`);
  } catch (e) {
    $('#codeOut').innerHTML = `<div class="hint">Error: ${escapeHtml(String(e.message || e))}</div>`;
    setStatus('Error', 'err');
  } finally {
    $('#codeSend').disabled = false;
  }
}
$('#codeSend').addEventListener('click', doCode);

// ---- Listen / Meeting ----
function renderTranscript(lines) {
  const el = $('#transcript');
  if (!lines.length) { el.innerHTML = '<div class="hint">Lines you add appear here.</div>'; return; }
  el.innerHTML = lines
    .map((l) => {
      const m = l.match(/^(You|Them):\s*([\s\S]*)$/);
      if (!m) return `<div class="line">${escapeHtml(l)}</div>`;
      const who = m[1].toLowerCase();
      return `<div class="line"><span class="who ${who}">${m[1]}</span>${escapeHtml(m[2])}</div>`;
    })
    .join('');
  el.scrollTop = el.scrollHeight;
}
const localTranscript = [];
async function doMeeting() {
  const line = $('#meetInput').value.trim();
  if (line) { localTranscript.push(line); renderTranscript(localTranscript); $('#meetInput').value = ''; }
  $('#meetAdd').disabled = true;
  setStatus('Analyzing meeting…', 'busy');
  $('#meetOut').innerHTML = '<div class="hint">Analyzing…</div>';
  try {
    const r = await window.clarity.meeting({ line });
    $('#meetOut').innerHTML = answerHtml(r);
    setStatus(`Guidance updated · ${modelNote(r)} · ${r.latencyMs}ms`);
  } catch (e) {
    $('#meetOut').innerHTML = `<div class="hint">Error: ${escapeHtml(String(e.message || e))}</div>`;
    setStatus('Error', 'err');
  } finally {
    $('#meetAdd').disabled = false;
  }
}
$('#meetAdd').addEventListener('click', doMeeting);
$('#meetInput').addEventListener('keydown', (e) => e.key === 'Enter' && doMeeting());

// ---- Live listening (mic + system audio -> Whisper -> transcript -> guidance) ----
const engine = new window.AudioEngine();
window.__clarityEngine = engine; // test seam: lets tests feed known PCM through the real pipeline

engine.onStatus = (msg) => setStatus(msg);
engine.onLag = (lagging, depth) => {
  const el = $('#listenState');
  if (lagging) {
    el.textContent = `Transcription is behind (${depth} queued) — set CLARITY_ASR_MODEL=Xenova/whisper-tiny.en for a faster model`;
    el.classList.add('lagging');
    setStatus('Speech model slower than realtime', 'err');
  } else {
    el.classList.remove('lagging');
  }
};
engine.onLoadProgress = (pct, file) => setStatus(`Loading speech model ${pct}% (${file})`, 'busy');
engine.onTranscript = async (text, speaker, ms) => {
  const line = `${speaker}: ${text}`;
  localTranscript.push(line);
  renderTranscript(localTranscript);
  await window.clarity.addTranscript(line);
  setStatus(`${speaker}: "${text.slice(0, 44)}" (${ms}ms)`);
  // Only re-run guidance when the other side speaks — that's what you need a
  // reply to. Re-running on your own words just talks back at you.
  if ($('#autoGuide').checked && speaker === window.SPEAKER_THEM) doMeeting();
};

let listening = false;
async function toggleListening() {
  const btn = $('#listenBtn');
  if (!listening) {
    btn.disabled = true;
    setStatus('Starting capture…', 'busy');
    try {
      const got = await engine.start();
      listening = true;
      btn.textContent = '■ Stop Listening';
      btn.classList.add('recording');
      const srcs = [got.mic && 'You (mic)', got.system && 'Them (system audio)'].filter(Boolean).join(' + ');
      $('#listenState').textContent = `Live — capturing ${srcs}`;
      $('#listenState').classList.add('live');
      setStatus(`Listening (${srcs})`);
    } catch (e) {
      setStatus(`Cannot listen: ${e.message}`, 'err');
      $('#listenState').textContent = `Unavailable: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  } else {
    await engine.stop();
    listening = false;
    btn.textContent = '● Start Listening';
    btn.classList.remove('recording');
    $('#listenState').textContent = 'Idle — click to capture mic & meeting audio';
    $('#listenState').classList.remove('live');
    setStatus('Stopped listening');
  }
}
$('#listenBtn').addEventListener('click', toggleListening);

// ---- Screen ----
async function doScreen() {
  $('#screenGo').disabled = true;
  setStatus('Capturing screen…', 'busy');
  $('#screenOut').innerHTML = '<div class="hint">Capturing & analyzing…</div>';
  try {
    const dataUrl = await window.clarity.captureScreen();
    const r = await window.clarity.screen({ dataUrl, text: $('#screenInput').value.trim() });
    $('#screenOut').innerHTML = answerHtml(r);
    setStatus(`Screen analyzed · ${r.model} · ${r.latencyMs}ms`);
  } catch (e) {
    $('#screenOut').innerHTML = `<div class="hint">Error: ${escapeHtml(String(e.message || e))}</div>`;
    setStatus('Error', 'err');
  } finally {
    $('#screenGo').disabled = false;
  }
}
$('#screenGo').addEventListener('click', doScreen);

// ---- Models dashboard ----
// Shows every model the key can actually reach (~100), not a hardcoded subset.
// Health checks cost one request each, so results are cached on disk for a day
// and only re-run on demand.
let currentModel = null;
let modelMeta = [];
let healthMap = {};

const timeAgo = (ts) => {
  if (!ts) return 'never checked';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'checked just now';
  if (m < 60) return `checked ${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `checked ${h}h ago` : `checked ${Math.round(h / 24)}d ago`;
};

function modelCardHtml(m, ping) {
  const dot = !ping ? '' : ping.ok ? 'ok' : ping.limited ? 'pending' : 'bad';
  const stat = !ping
    ? 'not checked'
    : ping.ok
      ? `${ping.latencyMs}ms`
      : ping.limited
        ? 'rate limited'
        : 'unreachable';
  const sel = m.id === currentModel ? ' selected' : '';
  return `<div class="model-card${sel}" data-id="${escapeHtml(m.id)}">
    <div class="name"><span class="status-dot ${dot}"></span>${escapeHtml(m.label)}</div>
    <div class="id">${escapeHtml(m.id)}</div>
    <div class="meta"><span class="badge">${m.kind}</span><span>${stat}</span></div>
  </div>`;
}

function visibleModels() {
  const q = ($('#modelSearch').value || '').toLowerCase().trim();
  const kind = $('#kindFilter').value;
  return modelMeta.filter(
    (m) => (!kind || m.kind === kind) && (!q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
  );
}

function paintModels() {
  const list = visibleModels();
  const grid = $('#modelGrid');
  grid.innerHTML = list.length
    ? list.map((m) => modelCardHtml(m, healthMap[m.id])).join('')
    : '<div class="hint">No models match that filter.</div>';
  $$('.model-card').forEach((card) => card.addEventListener('click', () => selectModel(card.dataset.id)));
  $('#activeModel').textContent = currentModel || '—';
}

async function selectModel(id) {
  await window.clarity.setModel(id);
  currentModel = id;
  $$('.model-card').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
  $('#activeModel').textContent = id;
  setStatus(`Active model → ${id}`);
}

async function loadCatalog() {
  const st = await window.clarity.getState();
  currentModel = st.model;
  try {
    const cat = await window.clarity.catalog();
    modelMeta = cat.models;
    healthMap = cat.health || {};
    $('#checkedAt').textContent = `${modelMeta.length} models · ${timeAgo(cat.checkedAt)}`;
  } catch (e) {
    // Offline or bad key — fall back to the curated roster so the tab still works.
    modelMeta = st.models;
    $('#checkedAt').textContent = 'catalogue unavailable — showing curated list';
  }
  paintModels();
}

async function refreshModels() {
  if (!modelMeta.length) await loadCatalog();
  setStatus('Checking curated models…', 'busy');
  const results = await window.clarity.listModels();
  results.forEach((r) => { healthMap[r.id] = r; });
  paintModels();
  $('#checkedAt').textContent = `${modelMeta.length} models · checked just now`;
  setStatus(`Curated: ${results.filter((r) => r.ok).length}/${results.length} online`);
}

async function checkAllModels() {
  if (!modelMeta.length) await loadCatalog();
  const ids = visibleModels().map((m) => m.id);
  $('#checkAll').disabled = true;
  setStatus(`Checking ${ids.length} models…`, 'busy');
  try {
    const { results, checkedAt } = await window.clarity.healthCheck(ids);
    results.forEach((r) => { healthMap[r.id] = r; });
    paintModels();
    $('#checkedAt').textContent = `${modelMeta.length} models · ${timeAgo(checkedAt)}`;
    setStatus(`${results.filter((r) => r.ok).length}/${results.length} models online`);
  } catch (e) {
    setStatus(`Health check failed: ${e.message}`, 'err');
  } finally {
    $('#checkAll').disabled = false;
  }
}

window.clarity.onHealthProgress(({ done, total }) => setStatus(`Checking models… ${done}/${total}`, 'busy'));
$('#refreshModels').addEventListener('click', refreshModels);
$('#checkAll').addEventListener('click', checkAllModels);
$('#modelSearch').addEventListener('input', paintModels);
$('#kindFilter').addEventListener('change', paintModels);
$('#browseCatalog').addEventListener('click', async () => {
  const { url } = await window.clarity.openCatalog();
  setStatus(`Opened ${url}`);
});

// ---- Top-bar buttons ----
$('#quitBtn').addEventListener('click', () => window.clarity.quit());
$('#hideBtn').addEventListener('click', () => {
  const b = $('#body'); const s = $('.statusbar');
  const hidden = b.style.display === 'none';
  b.style.display = hidden ? '' : 'none';
  s.style.display = hidden ? '' : 'none';
  $('#hideBtn').textContent = hidden ? '▾' : '▸';
});
let stealth = true;
$('#stealthBtn').addEventListener('click', async () => {
  stealth = !stealth;
  await window.clarity.toggleContentProtection(stealth);
  $('#stealthBtn').classList.toggle('on', stealth);
  setStatus(stealth ? 'Undetectable ON — hidden from screen shares' : 'Undetectable OFF — visible in screen shares');
});

let clickThrough = false;
$('#clickThroughBtn').addEventListener('click', async () => {
  clickThrough = !clickThrough;
  await window.clarity.toggleClickThrough(clickThrough);
  $('#clickThroughBtn').classList.toggle('on', clickThrough);
  setStatus(clickThrough ? 'Click-through ON (overlay ignores mouse)' : 'Click-through OFF');
});

// ---- Global hotkeys from main ----
window.clarity.onHotkey((name) => {
  if (name === 'ask') { activateTab('ask'); $('#askInput').focus(); }
  else if (name === 'code') { activateTab('code'); $('#codeInput').focus(); }
  else if (name === 'meeting') { activateTab('listen'); $('#meetInput').focus(); }
  else if (name === 'screen') { activateTab('screen'); doScreen(); }
  else if (name === 'hide') { $('#hideBtn').click(); }
});

// ---- Settings ----
let cfg = { theme: 'shaded' };

function applyTheme(theme) {
  document.body.classList.toggle('theme-shaded', theme !== 'glass');
  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === theme));
}

function paintKeyState(hasKey, msg, kind) {
  const el = $('#keyState');
  el.textContent = msg || (hasKey ? 'Key saved.' : 'No API key yet — Ask, Code, Listen and Screen need one.');
  el.className = 'key-state ' + (kind || (hasKey ? 'ok' : 'bad'));
}

async function loadSettings() {
  cfg = await window.clarity.getConfig();
  applyTheme(cfg.theme);
  paintKeyState(cfg.hasKey);
  $('#asrSeg').innerHTML = cfg.asrModels
    .map((m) => `<button data-model="${m.id}"${m.id === cfg.asrModel ? ' class="on"' : ''}>${escapeHtml(m.label)} · ${m.mb} MB</button>`)
    .join('');
  $$('#asrSeg button').forEach((b) =>
    b.addEventListener('click', async () => {
      await window.clarity.setConfig({ asrModel: b.dataset.model });
      $$('#asrSeg button').forEach((x) => x.classList.toggle('on', x === b));
      $('#asrHelp').textContent = 'Saved. Restart Clarity for the speech model change to take effect.';
    })
  );
  $('#diag').innerHTML = [
    `Settings file: <code>${escapeHtml(cfg.configPath)}</code>`,
    `Speech model: <code>${escapeHtml(cfg.asrModel)}</code>`,
    `Platform: <code>${escapeHtml(navigator.platform)}</code> · ${navigator.hardwareConcurrency} cores`
  ].join('<br>');
}

$$('#themeSeg button').forEach((b) =>
  b.addEventListener('click', async () => {
    applyTheme(b.dataset.theme);
    await window.clarity.setConfig({ theme: b.dataset.theme });
  })
);

$('#saveKey').addEventListener('click', async () => {
  const key = $('#apiKeyInput').value.trim();
  if (!key) return;
  paintKeyState(false, 'Checking key…', '');
  await window.clarity.setConfig({ apiKey: key });
  const r = await window.clarity.testKey();
  if (r.ok) {
    paintKeyState(true, `Key works — verified against ${r.model}.`, 'ok');
    $('#apiKeyInput').value = '';
  } else {
    paintKeyState(false, `Key rejected: ${r.error}`, 'bad');
  }
});
$('#apiKeyInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('#saveKey').click());

// ---- Adaptive material ----
// Liquid Glass takes its cast from what sits behind it. Poll the mean luminance
// under the overlay and flip the material light when the backdrop is bright, so
// contrast holds over a white doc as well as a dark call.
const LIGHT_ON = 0.62;  // hysteresis: separate thresholds stop it flickering
const LIGHT_OFF = 0.52; // when the backdrop hovers around the boundary
let lightBackdrop = false;

async function sampleBackdrop() {
  try {
    const { luma } = await window.clarity.backdropLuma();
    applyBackdropLuma(luma);
  } catch {
    /* capture unavailable — keep the current material */
  }
}
function applyBackdropLuma(luma) {
  if (!lightBackdrop && luma >= LIGHT_ON) lightBackdrop = true;
  else if (lightBackdrop && luma <= LIGHT_OFF) lightBackdrop = false;
  document.body.classList.toggle('light-backdrop', lightBackdrop);
  return lightBackdrop;
}
window.__applyBackdropLuma = applyBackdropLuma; // test seam
setInterval(sampleBackdrop, 2500);
sampleBackdrop();

// ---- Demo backdrop (screenshot harness) ----
if (new URLSearchParams(location.search).get('demo')) {
  document.body.classList.add('demo');
  $('#demoBackdrop').hidden = false;
}

// ---- Init ----
(async function init() {
  try {
    const st = await window.clarity.getState();
    const c = await window.clarity.getConfig();
    applyTheme(c.theme);
    if (!c.hasKey) {
      // Nothing works without a key, so say so where they'll actually look.
      $('#askOut').innerHTML =
        '<div class="hint">No NVIDIA API key set. Open <b>Settings</b> to add one — it is stored locally on this machine.</div>';
    }
    currentModel = st.model;
    stealth = st.contentProtection;
    $('#stealthBtn').classList.toggle('on', stealth);
    setStatus(`Ready · ${st.model}`);
  } catch (e) {
    setStatus('Ready (no backend state)');
  }
})();
