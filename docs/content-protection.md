# Content protection compatibility

Clarity can ask macOS to omit its floating overlay from supported screenshots, recordings, and screen shares. The Privacy switch is enabled by default and can be turned off when the user intentionally wants to share the overlay.

## Support boundary

Clarity uses Electron's `BrowserWindow.setContentProtection`. On macOS, Electron maps this to `NSWindowSharingNone`. Electron also documents that newer applications using ScreenCaptureKit may still capture a protected window. External cameras and capture hardware are outside the operating system's control.

Protection applies only to the floating overlay. The Settings window remains normally shareable. Clarity does not claim to be invisible or undetectable.

Electron API reference: <https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows>

## States

| Switch state | Clarity behavior | Expected capture behavior |
| --- | --- | --- |
| On | Requests content protection and verifies Electron reports it enabled. | Supported capture paths may omit the overlay; ScreenCaptureKit-based and external capture paths may include it. |
| Off | Disables content protection immediately. | The overlay is normally available to screenshots, recordings, and screen shares. |

The selected state persists across application restarts. On macOS versions that do not release the legacy sharing state on an existing window, Clarity transparently rebuilds only the native overlay window while preserving its application state, bounds, and visibility.

## Qualification procedure

For each capture path below:

1. Install and launch the packaged Clarity build.
2. Open the overlay and place it over a high-contrast test background.
3. Turn `Hide overlay from screen sharing (best effort)` on.
4. Start the relevant full-display, window, or tab capture and record whether the overlay appears.
5. Turn the switch off without restarting Clarity and repeat the same capture.
6. Record the operating-system version, capture-application version, capture mode, date, and observed result.

## Versioned matrix

Do not infer untested results. Add one row per tested capture mode and keep historical rows when an operating system or capture application changes behavior.

| Date | macOS | Capture application and version | Capture mode | Protection on | Protection off | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Pending | Pending | macOS screenshot | Full display and selection | Not yet qualified | Not yet qualified | Test the packaged build. |
| Pending | Pending | QuickTime Player | Full-display recording | Not yet qualified | Not yet qualified | ScreenCaptureKit behavior may vary by macOS release. |
| Pending | Pending | Zoom | Full display and application window | Not yet qualified | Not yet qualified | Record the Zoom version and share mode separately. |
| Pending | Pending | Google Meet in Chrome | Tab, window, and full display | Not yet qualified | Not yet qualified | Browser capture modes may behave differently. |
| Pending | Pending | Microsoft Teams | Full display and application window | Not yet qualified | Not yet qualified | Record the Teams version and share mode separately. |

An `on` result that still includes the overlay is a compatibility limitation to document, not evidence that Clarity failed to request the operating-system flag. An `off` result should normally include the overlay; unexpected results should be reproduced with another ordinary window before being attributed to Clarity.
