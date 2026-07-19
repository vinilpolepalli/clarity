# Architecture

## Trust boundaries

The Electron main process owns window lifecycle, overlay state, permission requests, shortcuts, provider cancellation, Keychain access, and capability routing. Renderers are sandboxed and context-isolated. Each window has a separate preload exposing only the messages needed by its role.

The transparent overlay is not a dashboard. It is one continuous, movable surface with compact and expanded geometry. Settings/onboarding is a different opaque BrowserWindow; opening or closing it never changes overlay bounds.

SQLite runs in an Electron utility process. Audio capture runs in a separately built Swift executable. A crash in either capability reports a typed degradation instead of taking down the renderer. Provider calls originate on the desktop and use Keychain credentials.

```text
Overlay renderer ── intents ──┐
                              │
Settings renderer ─ settings ─┤
                              ▼
                    Electron main authority
                      │       │        │
             utility process  │    Keychain/provider
                 SQLite       │
                         Swift capture helper
```

## Overlay state and geometry

`@clarity/domain` defines the exhaustive phase union and pure reducer. `@clarity/windowing` defines compact/expanded dimensions, display clamping, bottom-edge growth direction, and collapse restoration. The main process applies those outputs with native `BrowserWindow.setBounds`; the React renderer cannot resize or show a window directly.

Compact width and position are stored independently from expanded height. Expansion keeps x, width, and top edge when there is room, and grows upward near the bottom of the work area. User resize is enabled only while expanded.

## Local data

The utility-process database uses a versioned migration table, WAL, foreign keys, FTS5, and transactions that update a session and its search row together. Preferences are a separate small JSON document written atomically with mode `0600`; secrets never enter it.

Provider keys use the macOS `security` command against a dedicated generic-password service. The renderer can save, delete, and check presence but cannot read a stored key.

## Capture and transcription

The Swift helper accepts newline-delimited versioned control messages. It emits microphone and ScreenCaptureKit audio frames with an epoch, monotonic sequence number, source, sample rate, and channel count. The desktop client detects gaps, drops oldest frames under pressure, and retains a bounded rolling window.

The local transcription adapter calls a user-installed whisper.cpp executable using argument arrays rather than a shell. Model and audio paths are explicit; concurrency and retention are desktop policies.

## Optional cloud

Cloud is not required for capture, transcription, inference, search, artifacts, or export. When enabled, only reviewed artifacts are encrypted client-side with AES-256-GCM. The Supabase schema stores ciphertext, IV, routing metadata, and timestamps under owner-only RLS. Provider keys and raw audio are outside this boundary.
