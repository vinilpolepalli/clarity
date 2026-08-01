# Clarity v2

A from-scratch rebuild of Clarity as a **Cluely-style undetectable AI meeting copilot** — a frameless, always-on-top, translucent overlay that sits over any app and helps you in real time. Powered entirely by **NVIDIA NIM**, with **`thinkingmachines/inkling`** as the default model.

## Features (all working & Playwright-tested)

| Tab | What it does | Model |
|-----|--------------|-------|
| **Ask** | Ask anything, get an instant answer (code answers rendered as fenced blocks) | selected NIM model |
| **Listen** | **Genuinely live** meeting copilot — captures mic + system audio, transcribes on-device with Whisper, and auto-produces a rolling **Summary / Suggested response / Next actions** as people speak | Whisper + inkling |
| **Code** | Coding-interview / engineering copilot — **Approach / Solution / Complexity** with a complete runnable solution | selected NIM model |
| **Screen** | Screenshots your screen (`desktopCapturer`), downscales to JPEG, and reads it with a vision model to tell you what to do | Llama 3.2 Vision |
| **Models** | Live dashboard of **every model your key can reach** (~100), filterable by name and kind, with cached health checks and latency. Click to switch the active model, or open the full catalogue at [build.nvidia.com/models](https://build.nvidia.com/models) | — |

### Appearance

Two looks, switchable in **Settings**:

- **Shaded** (default) — a flat dark scrim, close to Cluely: mostly opaque so text stays crisp, still translucent enough to keep the call visible, and no expensive refraction pass.
- **Glass** — heavier blur plus real edge refraction via an SVG displacement map (measured: 13px displacement of a straight line behind the panel), and a material that adapts light/dark to whatever is behind it.

Adaptation requires sampling the screen on a timer. The CPU cost is trivial (~11 ms, under 1% duty cycle) but the *surface area* is not: it holds the macOS Screen Recording permission open continuously and can keep a recording indicator lit — the opposite of what an undetectable overlay wants. So **only the glass theme samples**. On the default shaded theme the app touches the screen solely when you press Capture + Analyze, and a test enforces that.

Glass is honestly labelled: it is an emulation. Apple's real Liquid Glass (`.glassEffect()`, `NSGlassEffectView`) is native-only and unreachable from Electron at any version.

### Undetectable

This is an **OS-level window flag**, not a drawing trick. `setContentProtection(true)` maps to:

| Platform | Underlying call |
|----------|-----------------|
| macOS | `NSWindow.sharingType = NSWindowSharingNone` |
| Windows | `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` |
| Linux/X11 | no-op — X11 has no equivalent guarantee |

The compositor itself omits the window from any capture, so it is **excluded from screen shares, screen recordings and screenshots** — you see it, Zoom/Meet/Teams and QuickTime do not. It is on by default and the 🛡 button toggles it. The window is also frameless, hidden from the taskbar/dock, and visible across all workspaces including full-screen apps.

Plus the rest of the overlay chrome: draggable glass pill bar, **click-through** ghost mode (overlay ignores the mouse so you can work behind it), **hide/show**, quit, and global hotkeys (`⌘⏎` Ask, `⌘⇧M` Listen, `⌘⇧C` Code, `⌘⇧S` Screen, `⌘⇧H` hide).

### Listen is not dictation

Dictation transcribes **one microphone**, on purpose, for the person holding it. A meeting copilot has the opposite problem: the words you need help answering are the *other* person's, and they never touch your mic — they arrive over system/loopback audio. So Clarity captures two streams and segments them **independently**:

| Stream | Speaker | Why it matters |
|--------|---------|----------------|
| Microphone | `You` | what you already said — never something to suggest you repeat |
| System / loopback | `Them` | the question you actually need a reply to |

Each stream gets its own VAD state, so you and the other party can talk over each other without merging into one garbled utterance. Every transcript line is labelled, the guidance model is told to anchor on the newest `Them:` line, and auto-guidance only re-fires when *they* speak — otherwise the overlay just talks back at you.

### Choosing a speech model

Whisper runs on-device — **no API key, no cost, no network at inference time**. Set `CLARITY_ASR_MODEL` to trade accuracy against speed. Measured on the same 11s clip at three noise levels (word error rate), and in-app transcription speed:

| Model | Size | Clean | Moderate noise | Heavy noise | In-app speed |
|---|---|---|---|---|---|
| `Xenova/whisper-tiny.en` | 41 MB | 0% | 68% | 45% | **0.42× realtime** |
| `Xenova/whisper-base.en` | 77 MB | 5% | 18% | 100% (collapsed) | ~0.6× |
| `Xenova/whisper-small.en` (default) | 249 MB | 0% | 14% | **0%** | **1.7× realtime** |

Real meetings are the noisy columns. `base` is erratic and can fail outright, so the useful choice is `tiny` (fast) or `small` (robust). `small` is the default; **if transcription can't keep up, the app tells you and names the switch** — a model slower than realtime queues without bound and ends up answering what was said minutes ago.

```bash
CLARITY_ASR_MODEL=Xenova/whisper-tiny.en npm start   # if small lags on your machine
```

Speeds above are from a throttled 4-core CI container; Apple Silicon should be materially faster.

### How transcription works

NVIDIA NIM has no speech-to-text model in its catalog (checked all 102 — only `riva-translate`, which is text translation), so speech recognition runs **on-device**: OpenAI Whisper (`whisper-tiny.en`, INT8 ONNX) in a Web Worker via Transformers.js/WASM. Audio flows capture → 16 kHz resample → per-speaker VAD → Whisper → labelled transcript line → NIM guidance. Keeping ASR local also means meeting audio never leaves the machine.

Weights are fetched once by `npm run setup` into `models/` (~42 MB) so the app transcribes offline and never stalls mid-meeting on a download.

### Reasoning models

`inkling` is a reasoning model: it emits a scratchpad in `reasoning_content` and the real answer in `content`. If it exhausts its token budget while still thinking, `content` comes back empty. Clarity retries once with a larger budget, and **never renders the scratchpad as the answer** — partial notes are only reachable behind an explicit "Model's reasoning" disclosure.

## Install on a Mac

**Prerequisite:** Node 18+ (`brew install node` if you don't have it).

```bash
git clone -b claude/clarity-v2-workspace-0pbbjy https://github.com/vinilpolepalli/clarity
cd clarity/v2
npm install          # pulls deps, bundles the ASR worker, downloads ~281 MB of Whisper weights
npm start
```

Then open **Settings** and paste your NVIDIA NIM API key — it is stored locally in the app's own data directory, never in the repo. Get one free at [build.nvidia.com](https://build.nvidia.com/models). No environment variables needed; `NVIDIA_API_KEY` still works if you prefer it.

macOS will ask for **Microphone** and **Screen Recording** the first time you use Listen and Screen. Both are required — the app is terminated by the OS if it asks without them.

### Build a real .app

```bash
npm run package:mac
```

Produces `dist/Clarity-2.0.0-arm64.dmg` (and a `.zip`) — drag it to Applications like any other app. Built on your own machine, so there is no Gatekeeper quarantine to work around and no Developer ID needed. The bundle is ~580 MB, most of it the speech model weights.

The app runs as a menu-bar-less agent (`LSUIElement`), so it has no Dock icon — quit with the ✕ on the overlay itself.

### Run from source (any platform)

```bash
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

## Resilience

Two failure modes matter for a live tool, and both are handled rather than hidden:

- **A stalled model.** During development `thinkingmachines/inkling` began returning HTTP 504 after ~300s. A copilot that hangs is worse than a weaker one that answers, because the moment to speak passes. Interactive calls now get one short attempt (20s) before falling back to a fast model, and the status line names the fallback so a degraded answer is never mistaken for a normal one.
- **Transcription falling behind.** If the speech model is slower than realtime the queue grows without bound — memory climbs and guidance starts answering minutes-old speech. The engine detects the backlog and surfaces it with the fix.

Health checks distinguish **rate limited** from **unreachable**: a 429 is our own request budget, not a model being down, and reporting it as offline would be wrong.
