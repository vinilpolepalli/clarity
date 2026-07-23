# Clarity

Clarity is a local-first macOS meeting copilot. It provides a compact, always-on-top assistant for questions, meeting notes, screen-aware prompts, and local conversation history—without requiring an account for core use.

## Inspiration and attribution

Clarity is an independent open-source implementation, inspired by the interaction model of [Cluely](https://cluely.com/) and by the Electron/macOS architecture explored in [cue](https://github.com/Blueturboguy07/cue). Those projects informed the product direction and technical study behind this repository.

Clarity does not claim affiliation with either project. Its code, UI, privacy model, storage layer, provider adapters, and native capture pipeline are maintained independently in this repository under the [AGPL-3.0-only license](LICENSE).

## Highlights

- Local-first by default: conversations, transcripts, search, and settings stay on your Mac.
- Bring your own key: connect OpenAI, Anthropic, or NVIDIA NIM. Keys are stored in macOS Keychain.
- Live meeting notes: capture microphone, system audio, or both; transcribe locally with whisper.cpp; generate a running summary, decisions, and actions.
- Screen context: optionally attach the current display to an individual question when using a confirmed vision-capable model.
- Useful answers: Markdown headings, lists, inline code, syntax-colored code cards, and one-click code copying.
- Private controls: screen context is off by default, screenshots stay in memory only, and overlay protection is best effort.

## What Clarity is—and is not

Clarity is designed to make your own work easier. It does not claim invisibility, bypass operating-system privacy controls, or secretly record your screen. macOS remains in control of Screen Recording, Microphone, and Accessibility permissions.

## Requirements

- macOS 14 or later
- Apple silicon for the packaged local artifact
- Node 20–24 and pnpm 10 for development
- Swift 6-compatible toolchain for native audio capture
- Optional: whisper.cpp CLI plus model file for local transcription
- Optional: OpenAI, Anthropic, or NVIDIA NIM API key

## Install a local build

Build a local Apple-silicon DMG:

```bash
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 install
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 package:mac
```

The artifacts are written to `apps/desktop/release/`. Local builds are ad-hoc signed and are not notarized; macOS may require Control-click → Open on first launch.

For durable permission recognition across upgrades, distribute a build signed with a stable Apple Developer ID and notarize it. The repository supports local packaging, but does not include Apple signing credentials.

## Quick start

1. Launch Clarity and complete onboarding. You can continue without granting optional permissions.
2. Open Settings → Models, choose a provider and model, save your API key, then use Test connection.
3. Ask a question in the overlay. Responses preserve Markdown structure and code formatting.
4. To use screen context, choose a vision-capable model, turn on Screen in the composer, and submit a question.
5. To use live notes, configure whisper.cpp in Settings → Audio, select an audio source, then select Listen.

## Screen Recording permission

Screen context and system-audio capture use macOS Screen & System Audio Recording. Clarity cannot auto-grant this permission: Apple requires the person using the Mac to approve access. This is the same operating-system privacy boundary used by conferencing and browser apps.

When access is needed, Clarity opens the correct System Settings page and automatically retries the question after macOS reports the permission as granted. The capture itself happens in place—Clarity does not hide its overlay before taking a screenshot. The overlay’s best-effort content protection remains enabled by default.

If you are managing company-owned Macs, a device administrator can deploy privacy settings through MDM. Personal Macs must use System Settings:

1. Open System Settings → Privacy & Security → Screen & System Audio Recording.
2. Enable Clarity.
3. Return to Clarity; it will retry automatically while the permission handoff is open.

Apple documents this permission control in its [Screen & System Audio Recording guide](https://support.apple.com/guide/mac-help/allow-apps-to-use-screen-and-audio-recording-mchl592e5686/26/mac/26).

## Privacy model

- Provider keys are stored in Keychain and never sent to optional cloud sync.
- Screen context is opt-in per preference, attached only to a supported/overridden vision model, and retained only in memory for the current answer.
- A `Viewed screen` disclosure identifies the current answer’s temporary screenshot. Screenshots are not written to local conversation history or cloud sync.
- Raw meeting audio is transient; transcription, notes, and conversations are stored locally.
- Cloud sync is optional and disabled by default. It accepts only explicitly reviewed encrypted artifacts.

See [the architecture guide](docs/architecture.md) and [content-protection boundary](docs/content-protection.md) for implementation details and limitations.

## Development

```bash
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 install
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 dev
```

Use Settings → Models for provider configuration. Do not put API keys in `.env` files.

## Validation

```bash
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 typecheck
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 test
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 test:native
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 e2e
COREPACK_INTEGRITY_KEYS=0 corepack pnpm@10.32.1 package:mac
```

The desktop E2E suite covers compact and expanded geometry, controls, threaded conversations, local history, provider selection, screen-context opt-in and failure remediation, capture during overlay recreation, onboarding, live meeting notes, and privacy controls.

## Repository map

- `apps/desktop/electron` — Electron main process, IPC, Keychain, capture orchestration, and persistence.
- `apps/desktop/src` — React overlay, onboarding, settings, and response renderer.
- `packages/domain` — application state, modes, preferences, and demo fixtures.
- `packages/providers` — provider discovery, connection tests, streaming, and multimodal requests.
- `packages/windowing` — overlay geometry and transitions.
- `packages/capture-client` and `native/ClarityCapture` — native audio capture protocol and Swift helper.
- `packages/transcription` — local whisper.cpp adapter.
- `packages/ai-core` — context limits, validation, injection marking, and backpressure.
- `packages/sync-client` — optional encrypted sync envelope.

## License

Clarity is licensed under the GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
