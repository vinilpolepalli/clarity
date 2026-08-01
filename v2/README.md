# Clarity v2

A from-scratch rebuild of Clarity as a **Cluely-style undetectable AI meeting copilot** — a frameless, always-on-top, translucent overlay that sits over any app and helps you in real time. Powered entirely by **NVIDIA NIM**, with **`thinkingmachines/inkling`** as the default model.

## Features (all working & Playwright-tested)

| Tab | What it does | Model |
|-----|--------------|-------|
| **Ask** | Ask anything, get an instant answer (code answers rendered as fenced blocks) | selected NIM model |
| **Listen** | **Genuinely live** meeting copilot — captures mic + system audio, transcribes on-device with Whisper, and auto-produces a rolling **Summary / Suggested response / Next actions** as people speak | Whisper + inkling |
| **Code** | Coding-interview / engineering copilot — **Approach / Solution / Complexity** with a complete runnable solution | selected NIM model |
| **Screen** | Screenshots your screen (`desktopCapturer`), downscales to JPEG, and reads it with a vision model to tell you what to do | Llama 3.2 Vision |
| **Models** | Live dashboard that pings every NIM model, shows online/offline status + latency, and lets you switch the active model | — |

### Undetectable

The window is created with `setContentProtection(true)`, so it is **excluded from screen shares, screen recordings and screenshots** — you see it, Zoom/Meet/Teams and QuickTime do not. It is also frameless, hidden from the taskbar/dock, and visible across all workspaces including full-screen apps. The 🛡 button toggles it.

Plus the rest of the overlay chrome: draggable glass pill bar, **click-through** ghost mode (overlay ignores the mouse so you can work behind it), **hide/show**, quit, and global hotkeys (`⌘⏎` Ask, `⌘⇧M` Listen, `⌘⇧C` Code, `⌘⇧S` Screen, `⌘⇧H` hide).

### How live transcription works

NVIDIA NIM has no speech-to-text model in its catalog (checked all 102 — only `riva-translate`, which is text translation), so speech recognition runs **on-device**: OpenAI Whisper (`whisper-tiny.en`, INT8 ONNX) executing in a Web Worker via Transformers.js/WASM. Audio flows mic + system loopback → mixed → resampled to 16 kHz → energy-based VAD splits it into utterances → Whisper → transcript line → NIM guidance. Keeping ASR local also means meeting audio never leaves the machine.

Weights are fetched once by `npm run setup` into `models/` (~42 MB) so the app transcribes offline and never stalls mid-meeting on a download.

## Run

```bash
cd v2
npm install        # postinstall fetches the Whisper weights and bundles the ASR worker
NVIDIA_API_KEY=nvapi-... npm start        # on Linux CI: prefix with `xvfb-run -a`
```

## Test

Playwright launches the real Electron app, screenshots it, and clicks every feature against the live NIM API:

```bash
NVIDIA_API_KEY=nvapi-... xvfb-run -a npx playwright test
```

Screenshots land in `assets/shots/`.

## Architecture

- `main.js` — Electron main process: frameless transparent always-on-top window, content protection, IPC handlers for each feature, screen capture, global hotkeys.
- `preload.js` — safe `contextBridge` API (`window.clarity.*`).
- `nim.js` — NVIDIA NIM client (OpenAI-compatible), model roster, per-request timeout + retry/backoff, health pings.
- `prompts.js` — system prompts for each assist mode.
- `renderer/` — the Cluely-style glass UI (HTML/CSS/JS, no framework), plus `audio.js` (capture + VAD) and `asr-worker.src.js` (Whisper worker, bundled by esbuild).
- `scripts/fetch-model.js` — one-time Whisper weight download.
- `test/app.spec.js` — end-to-end Electron+Playwright tests.

Audio design note: every source funnels through `AudioEngine.pushSamples()`, the single ingestion point for VAD + ASR. The microphone path and the test path both call it, so the code exercised by tests is exactly the code that runs live.

## Note on parity

Cluely ships only macOS/Windows binaries, so a literal side-by-side install and pixel-diff isn't possible in a Linux CI container. The UI replicates Cluely's published style (top command pill, dark glass panels, live meeting-notes layout) and every feature is implemented and verified working rather than mocked.

Two platform caveats are worth being explicit about:
- `setContentProtection` is enforced by the OS compositor. It is fully effective on macOS and Windows; on Linux/X11 there is no equivalent guarantee.
- System (loopback) audio capture depends on the platform providing a loopback device. Where it is unavailable the app degrades to microphone-only and says so in the UI.
