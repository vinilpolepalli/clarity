# macOS release procedure

1. Run typecheck, JavaScript tests, native handshake, production build, Electron E2E, and the parity sequence.
2. Build the native helper in release mode and confirm it is embedded at `Contents/Resources/native/ClarityCapture`.
3. Package DMG and ZIP with hardened runtime and the repository entitlements.
4. For a public release, supply an Apple Developer ID Application identity and notarization credentials through the CI secret store. Never commit certificate or App Store Connect credentials.
5. Validate the signature with `codesign --verify --deep --strict`, submit/notarize, staple the ticket, then run `spctl --assess` on the final app.
6. Install from the DMG on a clean macOS user, complete onboarding, grant and revoke each permission, run a capture, submit a demo query, resize/collapse/expand, inspect history, and relaunch.

Without signing credentials, `pnpm package:mac` produces an unsigned smoke artifact only. It is suitable for local verification, not distribution.
