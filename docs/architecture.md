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

`@clarity/domain` defines the exhaustive phase union, ordered conversation messages, and pure reducer. `@clarity/windowing` defines compact/expanded dimensions, display clamping, bottom-edge growth direction, and collapse restoration. The main process applies those outputs with native `BrowserWindow.setBounds`; the React renderer cannot resize or show a window directly.

Compact width and position are stored independently from expanded height. Expansion keeps x, width, and top edge when there is room, and grows upward near the bottom of the work area. User resize is enabled only while expanded.

## Local data

The utility-process database uses a versioned migration table, WAL, foreign keys, FTS5, and one ordered `conversation_messages` stream per session. Appending a turn and rebuilding that conversation's search row happen in one transaction. Session rows remain the conversation headers while new and resumed chats use the message stream. Preferences are a separate small JSON document written atomically with mode `0600`; secrets never enter it.

Provider keys use the macOS `security` command against a dedicated generic-password service. The renderer can save, delete, and check presence but cannot read a stored key.

Provider calls receive the current conversation rather than only the newest prompt. The desktop bounds context to the latest 24 messages and 18,000 characters before sending it, so follow-ups retain useful history without allowing a thread to grow requests indefinitely.

Screen context is a separate, persistent preference that defaults off. For an enabled request, the Electron main process freezes the overlay's current display, temporarily hides the overlay, captures and bounds a PNG in memory, and attaches it only to the newest user turn sent to an explicitly image-capable provider/model pair. The renderer receives metadata and an authorized ephemeral preview, never raw capture authority. Screenshot bytes are owned by the active request, replaced on the next request, cleared on conversation reset or renderer failure, and excluded from SQLite and optional cloud sync. The assistant turn keeps a `Viewed screen` disclosure even if inference fails after transmission.

## Capture and transcription

The Swift helper accepts newline-delimited versioned control messages. It emits microphone and ScreenCaptureKit audio frames with an epoch, monotonic sequence number, source, sample rate, and channel count. The desktop client detects gaps, drops oldest frames under pressure, and retains a bounded rolling window.

The local transcription adapter calls a user-installed whisper.cpp executable using argument arrays rather than a shell. Model and audio paths are explicit; concurrency and retention are desktop policies.

## Optional cloud

Cloud is not required for capture, transcription, inference, search, artifacts, or export. When enabled, only reviewed artifacts are encrypted client-side with AES-256-GCM. The Supabase schema stores ciphertext, IV, routing metadata, and timestamps under owner-only RLS. Provider keys and raw audio are outside this boundary.
