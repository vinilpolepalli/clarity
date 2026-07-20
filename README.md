# Clarity

Clarity is an open-source, local-first meeting copilot for macOS. It uses a compact always-on-top command surface, an expandable answer/history surface, and a separate window for onboarding and settings. Local features do not require an account.

This implementation was created from a clean `origin/main` baseline. It does not reuse the previous prototype’s UI, CSS, renderer, desktop shell, dashboard, preload, IPC surface, or single-window architecture.

## What is implemented

- Two independent Electron windows: a transparent frameless overlay and an opaque settings/onboarding window.
- Main-process-owned, serializable overlay state for hidden, compact idle/listening, expanded empty/response/error/history states.
- Continuing conversation threads with ordered user and assistant turns, follow-ups in the same composer, reopenable local history, and a New chat action.
- Reference-calibrated compact geometry (590×88), expandable/resizable response surface, top-edge anchoring, bounds persistence, and reduced-motion behavior.
- Split onboarding with explicit Accessibility, Microphone, and Screen/System Audio permission explanations and safe continuation when permissions are denied.
- General, Models, Audio, Modes, Keybindings, Profile/Cloud, Privacy, Integrations, and About settings. There is no Billing surface.
- BYOK provider selection with API keys stored only in macOS Keychain, plus a deterministic offline demo provider.
- Ranked NVIDIA NIM presets, live model discovery, saved custom model IDs, and an explicit connection test that verifies the selected key, endpoint, and model with one tiny request.
- Streaming OpenAI-compatible, NVIDIA NIM, and Anthropic provider adapters with cancellation and normalized, redacted failures.
- Native Swift microphone and ScreenCaptureKit system-audio helper with a versioned handshake, sequence epochs, structured errors, and bounded desktop buffering.
- Local `node:sqlite` database isolated in an Electron utility process, with WAL, migrations, ordered conversation messages, FTS5 search, transcripts, artifacts, and exports.
- A local whisper.cpp CLI adapter, context budgeting, generated-artifact validation, transcript prompt-injection marking, and inference backpressure.
- Optional encrypted sync envelopes and a row-level-secured Supabase ciphertext schema. Cloud sync remains off by default and never receives provider keys or performs v1 inference.
- Best-effort overlay content protection with honest wording: Clarity does not claim guaranteed invisibility.

## Requirements

- macOS 14 or later
- Node 20–24 (the current workspace is verified with Node 23.1.0)
- pnpm 10.32.1 through Corepack
- Swift 6-compatible macOS toolchain
- Optional: a local whisper.cpp `whisper-cli` executable and model
- Optional: an NVIDIA NIM, OpenAI, or Anthropic API key

The current Corepack installation may require `COREPACK_INTEGRITY_KEYS=0` because its bundled signing-key list is stale. This affects package-manager bootstrap only, not the application.

## Develop

```bash
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 install
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 dev
```

Development mode uses the offline deterministic provider and a fresh two-window shell. Ask a question, then keep using the same composer for follow-ups; open Recent conversations to resume a saved thread or choose New chat to start over. Provider keys are entered in Settings → Models and stored in Keychain; do not put them in `.env`. After saving a key, refresh the provider catalog or add a custom model ID, select a model, and use Test connection to verify that exact configuration.

## Verify

```bash
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 typecheck
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 test
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 test:native
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 build
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 e2e
```

The Electron E2E suite verifies compact/expanded bounds, anchor retention, narrow reflow, threaded follow-ups, saved-conversation reopening, New chat cancellation, deterministic responses, settings independence, ranked model selection, custom-model validation, no-key connection gates, screen-context opt-in and restart persistence, ephemeral previews, screen-share protection toggling and restart persistence, privacy wording, collapse restoration, and permission-optional onboarding. It also stores visual baselines for compact, response, Settings, and onboarding surfaces.

## Package

```bash
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 package:mac
```

This builds the Swift helper in release mode, bundles it as an extra resource, builds both renderer entries, and produces DMG and ZIP artifacts. With no Apple signing identity or notarization credentials, the output is an unsigned local smoke build. Release CI must provide the signing/notarization credentials documented in the [macOS release procedure](docs/releasing.md).

## Privacy boundary

Clarity’s provider keys, audio capture, local transcription, inference calls, SQLite database, and local search are desktop responsibilities. Optional cloud features receive only explicitly reviewed encrypted artifact envelopes. Integrations are individually disabled by default and require an explicit destination and confirmation before export.

Screen Recording permission is used for system audio and for the optional, default-off `Uses screen` feature. When that toggle is enabled, Clarity captures the display containing the overlay for each submitted question and sends that screenshot directly to the selected BYOK model provider with the conversation request. The overlay is hidden before capture. Screenshot bytes and previews remain only in desktop memory, are replaced by the next request, and are never written to conversation history or cloud sync. Each attached capture is disclosed as `Viewed screen`, including when the provider returns an error.

`setContentProtection` reduces exposure in many common capture paths but cannot protect against every app, OS change, external camera, or capture technique.

The overlay protection switch is enabled by default and can be turned off when the user intentionally wants to share Clarity. See [Content protection compatibility](docs/content-protection.md) for the exact support boundary and qualification matrix.

## Repository map

- `apps/desktop/electron` — main process, two BrowserWindows, preloads, Keychain, and storage utility.
- `apps/desktop/src` — overlay, onboarding, and settings renderers.
- `packages/domain` — runtime state, preferences, and deterministic fixtures.
- `packages/windowing` — geometry and anchor transitions.
- `packages/capture-client` — native helper client, sequence tracking, and bounded buffers.
- `packages/providers` — streaming provider adapters.
- `packages/transcription` — local whisper.cpp adapter.
- `packages/ai-core` — context, validation, injection marking, and backpressure.
- `packages/sync-client` — encrypted optional sync envelope.
- `native/ClarityCapture` — Swift audio helper.
- `supabase/migrations` — optional encrypted artifact schema and RLS.
- [`docs/architecture.md`](docs/architecture.md) — desktop trust boundaries, state ownership, and data flow.
- `.context/plans` and `.context/verification` — ignored plan, evidence ledger, and parity artifacts for this Conductor workspace.

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
