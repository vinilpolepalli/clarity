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
      const body = nl >= 0 ? chunk.slice(nl + 1) : chunk;
      html += `<pre><code>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`;
    } else {
      html += renderInline(chunk);
    }
  });
  return html;
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
window.__answerHtml = answerHtml; // test seam

// ---- Tabs ----
function activateTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'models') refreshModels();
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
    setStatus(`Answered · ${r.model} · ${r.latencyMs}ms`);
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
    setStatus(`Code ready · ${r.model} · ${r.latencyMs}ms`);
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
    setStatus(`Guidance updated · ${r.model} · ${r.latencyMs}ms`);
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
let currentModel = null;
let modelMeta = [];
function modelCardHtml(m, ping) {
  const dot = !ping ? 'pending' : ping.ok ? 'ok' : 'bad';
  const stat = !ping ? 'pinging…' : ping.ok ? `${ping.latencyMs}ms` : 'error';
  const sel = m.id === currentModel ? ' selected' : '';
  return `<div class="model-card${sel}" data-id="${m.id}">
    <div class="name"><span class="status-dot ${dot}"></span>${escapeHtml(m.label)}</div>
    <div class="id">${escapeHtml(m.id)}</div>
    <div class="meta"><span class="badge">${m.kind}</span><span>${stat}</span></div>
  </div>`;
}
function paintModels(pings) {
  const grid = $('#modelGrid');
  grid.innerHTML = modelMeta.map((m) => modelCardHtml(m, pings[m.id])).join('');
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
async function refreshModels() {
  const st = await window.clarity.getState();
  modelMeta = st.models;
  currentModel = st.model;
  paintModels({}); // pending state
  setStatus('Pinging models…', 'busy');
  const results = await window.clarity.listModels();
  const byId = {};
  results.forEach((r) => (byId[r.id] = r));
  paintModels(byId);
  const okCount = results.filter((r) => r.ok).length;
  setStatus(`Models: ${okCount}/${results.length} online`);
}
$('#refreshModels').addEventListener('click', refreshModels);

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

// ---- Init ----
(async function init() {
  try {
    const st = await window.clarity.getState();
    currentModel = st.model;
    stealth = st.contentProtection;
    $('#stealthBtn').classList.toggle('on', stealth);
    setStatus(`Ready · ${st.model}`);
  } catch (e) {
    setStatus('Ready (no backend state)');
  }
})();
