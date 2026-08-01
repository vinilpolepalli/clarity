const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen, shell } = require('electron');

// Whisper runs on WASM, which needs SharedArrayBuffer for multithreading.
// Chromium gates SAB behind cross-origin isolation, which a file:// renderer
// can never satisfy — so without this the speech model is pinned to one core.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// System (loopback) audio — the other side of the call. Stock Electron cannot
// capture it on macOS at all; this shim enables the CoreAudio tap and registers
// the display-media handler. It merges with the feature switch set above rather
// than replacing it, so it must be initialised after that line.
try {
  require('electron-audio-loopback').initMain({ forceCoreAudioTap: true });
} catch (e) {
  console.warn('System audio loopback unavailable:', e.message);
}
const path = require('path');
const fs = require('fs');
const nim = require('./nim');
const asr = require('./asr');
const prompts = require('./prompts');

let win = null;
const state = {
  model: nim.DEFAULT_MODEL,
  transcript: [],
  clickThrough: false,
  // Undetectable by default: the window is excluded from screen capture,
  // screen sharing and recording (Cluely's defining property).
  contentProtection: true
};

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const width = Math.min(920, primary.workAreaSize.width);
  // Screenshot harness: fill the display so the mock meeting can be rendered
  // inside the page, behind the overlay. backdrop-filter only samples the same
  // document, so a separate window behind us would not be refracted at all.
  const demo = !!process.env.CLARITY_DEMO_BACKDROP;
  const geom = demo
    ? { ...primary.workArea }
    : { width, height: 620, x: Math.round((primary.workAreaSize.width - width) / 2), y: 24 };

  win = new BrowserWindow({
    ...geom,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // Real OS-level glass: the compositor blurs whatever is actually behind the
    // window, which CSS cannot reach. This is what makes the material live.
    ...(process.platform === 'darwin'
      ? { vibrancy: 'under-window', visualEffectState: 'active' }
      : {}),
    ...(process.platform === 'win32' ? { backgroundMaterial: 'acrylic' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Hide from screen shares / recordings, and keep it hidden as the window is
  // shown on other desktops.
  win.setContentProtection(state.contentProtection);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), demo ? { search: 'demo=1' } : {});
}

// ---- IPC ----
ipcMain.handle('clarity:getState', () => ({
  model: state.model,
  models: nim.MODELS,
  clickThrough: state.clickThrough,
  contentProtection: state.contentProtection
}));

ipcMain.handle('clarity:contentProtection', (_e, v) => {
  state.contentProtection = !!v;
  if (win) win.setContentProtection(state.contentProtection);
  return { contentProtection: state.contentProtection };
});

// Transcript lines produced by live speech recognition in the renderer.
ipcMain.handle('clarity:addTranscript', (_e, line) => {
  if (line && line.trim()) state.transcript.push(line.trim());
  return { transcriptLen: state.transcript.length };
});

ipcMain.handle('clarity:setModel', (_e, id) => {
  state.model = id;
  return { model: state.model };
});

ipcMain.handle('clarity:ask', async (_e, { text }) => {
  const r = await nim.chatOrFallback({
    model: state.model,
    messages: [
      { role: 'system', content: prompts.ASK },
      { role: 'user', content: text }
    ]
  });
  return r;
});

ipcMain.handle('clarity:code', async (_e, { text }) => {
  const r = await nim.chatOrFallback({
    model: state.model,
    messages: [
      { role: 'system', content: prompts.CODE },
      { role: 'user', content: text }
    ],
    maxTokens: 1400
  });
  return r;
});

ipcMain.handle('clarity:meeting', async (_e, { line }) => {
  if (line && line.trim()) state.transcript.push(line.trim());
  const context = state.transcript.slice(-40).join('\n');
  const r = await nim.chatOrFallback({
    model: state.model,
    messages: [
      { role: 'system', content: prompts.MEETING },
      { role: 'user', content: `Live transcript so far:\n${context}\n\nGive live guidance now.` }
    ],
    // Reasoning models spend most of a small budget thinking; leave headroom
    // so the answer itself actually lands.
    maxTokens: 1600
  });
  return { ...r, transcriptLen: state.transcript.length };
});

ipcMain.handle('clarity:capture', async () => {
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: primary.size.width, height: primary.size.height }
  });
  const src = sources[0];
  if (!src) throw new Error('No screen source');
  // NIM rejects inline images much over ~180 KB, so downscale and use JPEG.
  const shot = src.thumbnail.resize({ width: 1024, quality: 'good' });
  return `data:image/jpeg;base64,${shot.toJPEG(70).toString('base64')}`;
});

ipcMain.handle('clarity:screen', async (_e, { dataUrl, text }) => {
  // NIM vision models take the OpenAI-style content array; passing the image as
  // an inline <img> tag makes the model describe the data URI instead (or 500).
  const r = await nim.chat({
    model: nim.VISION_MODEL,
    messages: [
      { role: 'system', content: prompts.SCREEN },
      {
        role: 'user',
        content: [
          { type: 'text', text: text || 'What should I do on this screen?' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    maxTokens: 700
  });
  return r;
});

ipcMain.handle('clarity:models', async () => {
  const results = await Promise.all(nim.MODELS.map((m) => nim.pingModel(m.id)));
  results.forEach(recordHealth);
  saveHealth();
  return results;
});

// ---- Model catalogue + cached health ----
// Health checks cost a real request per model, and there are ~100 of them, so
// results are cached on disk and only re-run when stale (or forced).
const HEALTH_TTL_MS = 24 * 60 * 60 * 1000;
const healthPath = () => path.join(app.getPath('userData'), 'model-health.json');
let health = { checkedAt: 0, models: {} };

function loadHealth() {
  try { health = JSON.parse(fs.readFileSync(healthPath(), 'utf8')); } catch { /* first run */ }
}
function saveHealth() {
  try {
    fs.mkdirSync(path.dirname(healthPath()), { recursive: true });
    fs.writeFileSync(healthPath(), JSON.stringify(health));
  } catch { /* cache is best-effort */ }
}
function recordHealth(r) {
  health.models[r.id] = { ok: r.ok, limited: !!r.limited, latencyMs: r.latencyMs, error: r.error || null, at: Date.now() };
  health.checkedAt = Date.now();
}

ipcMain.handle('clarity:catalog', async () => {
  const models = await nim.catalog();
  return {
    models,
    health: health.models,
    checkedAt: health.checkedAt,
    stale: Date.now() - health.checkedAt > HEALTH_TTL_MS
  };
});

ipcMain.handle('clarity:healthCheck', async (e, ids) => {
  const targets = (ids && ids.length ? ids : (await nim.catalog()).map((m) => m.id))
    // Embedding/rerank models don't speak chat/completions; probing them is noise.
    .filter((id) => !/embed|rerank/.test(id));
  const results = await nim.pingAll(targets, {
    concurrency: 4,
    onProgress: (done, total) => e.sender.send('clarity:healthProgress', { done, total })
  });
  results.forEach(recordHealth);
  saveHealth();
  return { results, checkedAt: health.checkedAt };
});

ipcMain.handle('clarity:ping', async (_e, id) => nim.pingModel(id));

ipcMain.handle('clarity:clickThrough', (_e, v) => {
  state.clickThrough = !!v;
  if (win) win.setIgnoreMouseEvents(state.clickThrough, { forward: true });
  return { clickThrough: state.clickThrough };
});

// Liquid Glass adapts to what is behind it: light content gives light glass,
// dark content dark. Sample a small thumbnail of the region under the overlay
// and return its mean luminance so the renderer can adapt.
ipcMain.handle('clarity:backdropLuma', async () => {
  if (!win) return { luma: 0 };
  const display = screen.getPrimaryDisplay();
  const W = 192;
  const H = Math.max(1, Math.round((display.size.height / display.size.width) * W));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: W, height: H } });
  const img = sources[0] && sources[0].thumbnail;
  if (!img || img.isEmpty()) return { luma: 0 };
  const { width, height } = img.getSize();
  const bmp = img.getBitmap(); // BGRA
  const b = win.getBounds();
  const sx = Math.max(0, Math.floor((b.x / display.size.width) * width));
  const sy = Math.max(0, Math.floor((b.y / display.size.height) * height));
  const sw = Math.max(1, Math.floor((b.width / display.size.width) * width));
  const sh = Math.max(1, Math.floor((b.height / display.size.height) * height));
  let sum = 0;
  let n = 0;
  for (let y = sy; y < Math.min(sy + sh, height); y++) {
    for (let x = sx; x < Math.min(sx + sw, width); x++) {
      const i = (y * width + x) * 4;
      // Rec. 709 luma from BGRA
      sum += (0.2126 * bmp[i + 2] + 0.7152 * bmp[i + 1] + 0.0722 * bmp[i]) / 255;
      n++;
    }
  }
  return { luma: n ? sum / n : 0 };
});

ipcMain.handle('clarity:asrConfig', (_e, cores) => ({
  model: asr.model(),
  threads: asr.threads(cores),
  models: asr.MODELS
}));

ipcMain.handle('clarity:quit', () => app.quit());

// The full NIM catalogue lives on the web; the dashboard only pings a curated
// subset, so give people a way to see everything that exists.
ipcMain.handle('clarity:openCatalog', () => {
  shell.openExternal(nim.CATALOG_URL);
  return { url: nim.CATALOG_URL };
});

function registerHotkeys() {
  const map = {
    'CommandOrControl+Enter': 'ask',
    'CommandOrControl+Shift+C': 'code',
    'CommandOrControl+Shift+S': 'screen',
    'CommandOrControl+Shift+M': 'meeting',
    'CommandOrControl+Shift+H': 'hide'
  };
  for (const [accel, name] of Object.entries(map)) {
    globalShortcut.register(accel, () => win && win.webContents.send('clarity:hotkey', name));
  }
}

app.whenReady().then(() => {
  loadHealth();
  createWindow();
  registerHotkeys();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());

module.exports = { state };
