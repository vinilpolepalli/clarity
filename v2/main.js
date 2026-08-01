const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen } = require('electron');
const path = require('path');
const nim = require('./nim');
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
  win = new BrowserWindow({
    width,
    height: 620,
    x: Math.round((primary.workAreaSize.width - width) / 2),
    y: 24,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
  const r = await nim.chat({
    model: state.model,
    messages: [
      { role: 'system', content: prompts.ASK },
      { role: 'user', content: text }
    ]
  });
  return r;
});

ipcMain.handle('clarity:code', async (_e, { text }) => {
  const r = await nim.chat({
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
  const r = await nim.chat({
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
  return results;
});

ipcMain.handle('clarity:ping', async (_e, id) => nim.pingModel(id));

ipcMain.handle('clarity:clickThrough', (_e, v) => {
  state.clickThrough = !!v;
  if (win) win.setIgnoreMouseEvents(state.clickThrough, { forward: true });
  return { clickThrough: state.clickThrough };
});

ipcMain.handle('clarity:quit', () => app.quit());

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
  createWindow();
  registerHotkeys();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());

module.exports = { state };
