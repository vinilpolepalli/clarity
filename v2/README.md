# Clarity v2

A from-scratch rebuild of Clarity as a **Cluely-style undetectable AI meeting copilot** — a frameless, always-on-top, translucent overlay that sits over any app and helps you in real time. Powered entirely by **NVIDIA NIM**, with **`thinkingmachines/inkling`** as the default model.

## Features (all working & Playwright-tested)

| Tab | What it does | Model |
|-----|--------------|-------|
| **Ask** | Ask anything, get an instant answer (code answers rendered as fenced blocks) | selected NIM model |
| **Listen** | Live meeting copilot — feed the transcript, get a rolling **Summary / Suggested response / Next actions** | inkling (reasoning) |
| **Code** | Coding-interview / engineering copilot — **Approach / Solution / Complexity** with a complete runnable solution | selected NIM model |
| **Screen** | Screenshots your screen (`desktopCapturer`) and reads it with a vision model to tell you what to do | Llama 3.2 Vision |
| **Models** | Live dashboard that pings every NIM model, shows online/offline status + latency, and lets you switch the active model | — |

Plus the overlay chrome: draggable glass pill bar, **click-through** ghost mode (overlay ignores the mouse so you can work behind it), **hide/show**, quit, and global hotkeys (`⌘⏎` Ask, `⌘⇧M` Listen, `⌘⇧C` Code, `⌘⇧S` Screen, `⌘⇧H` hide).

## Run

```bash
cd v2
npm install
NVIDIA_API_KEY=nvapi-... npm start        # on Linux CI: prefix with `xvfb-run -a`
```

## Test

Playwright launches the real Electron app, screenshots it, and clicks every feature against the live NIM API:

```bash
NVIDIA_API_KEY=nvapi-... xvfb-run -a npx playwright test
```

Screenshots land in `assets/shots/`.

## Architecture

- `main.js` — Electron main process: frameless transparent always-on-top window, IPC handlers for each feature, screen capture, global hotkeys.
- `preload.js` — safe `contextBridge` API (`window.clarity.*`).
- `nim.js` — NVIDIA NIM client (OpenAI-compatible), model roster, per-request timeout + retry/backoff, health pings.
- `prompts.js` — system prompts for each assist mode.
- `renderer/` — the Cluely-style glass UI (HTML/CSS/JS, no framework), including a minimal safe markdown renderer.
- `test/app.spec.js` — end-to-end Electron+Playwright tests.

## Note on parity

Cluely ships only macOS/Windows binaries, so a literal side-by-side install isn't possible in a Linux CI container. The UI replicates Cluely's published style (top command pill, dark glass panels, live-meeting notes layout) and every feature is implemented and verified working rather than mocked.
