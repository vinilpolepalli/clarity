const MAX_LONG_EDGE = 1568;
const MAX_BYTES = 5 * 1024 * 1024;
const RESIZE_STEPS = [1568, 1280, 1024];

export class ScreenContextError extends Error {
  constructor(code, message, permissionStatus = null) {
    super(message);
    this.name = "ScreenContextError";
    this.code = code;
    this.permissionStatus = permissionStatus;
  }
}

function abortError() {
  const error = new Error("Screen capture was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function thumbnailSize(displaySize, longEdge = MAX_LONG_EDGE) {
  const width = Math.max(1, Number(displaySize?.width) || longEdge);
  const height = Math.max(1, Number(displaySize?.height) || longEdge);
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function waitForEvent(target, eventName, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      target.removeListener?.(eventName, done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    target.once(eventName, done);
  });
}

export class ScreenContextService {
  constructor({ desktopCapturer, screen, systemPreferences, overlayWindow, platform = process.platform, settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), captureFixture = null }) {
    this.desktopCapturer = desktopCapturer;
    this.screen = screen;
    this.systemPreferences = systemPreferences;
    this.overlayWindow = overlayWindow;
    this.platform = platform;
    this.settle = settle;
    this.captureFixture = captureFixture;
    this.attachment = null;
    this.ownerRequestId = null;
  }

  permissionStatus() {
    if (this.platform !== "darwin") return "granted";
    return this.systemPreferences.getMediaAccessStatus("screen");
  }

  metadata() {
    if (!this.attachment) return null;
    const { bytes: _bytes, ...metadata } = this.attachment;
    return { ...metadata };
  }

  getPreview(id) {
    if (!this.attachment || this.attachment.id !== id) return null;
    return { mediaType: this.attachment.mediaType, bytes: new Uint8Array(this.attachment.bytes) };
  }

  readForProvider(requestId) {
    if (!this.attachment || this.ownerRequestId !== requestId || this.attachment.requestId !== requestId) return null;
    return { mediaType: this.attachment.mediaType, base64: this.attachment.bytes.toString("base64") };
  }

  clear(requestId) {
    if (requestId && this.ownerRequestId !== requestId) return false;
    this.attachment = null;
    this.ownerRequestId = null;
    return true;
  }

  dispose() {
    this.clear();
  }

  async capture(requestId, snapshot, { signal } = {}) {
    this.clear();
    this.ownerRequestId = requestId;
    throwIfAborted(signal);

    if (this.captureFixture) {
      try {
        const fixture = await this.captureFixture(snapshot);
        throwIfAborted(signal);
        if (this.ownerRequestId !== requestId) throw abortError();
        const bytes = Buffer.from(fixture.bytes);
        if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new ScreenContextError("fixture-invalid", "The injected screen capture is invalid.");
        this.attachment = {
          requestId,
          id: crypto.randomUUID(),
          mediaType: fixture.mediaType ?? "image/png",
          bytes,
          capturedAt: Date.now(),
          displayId: String(fixture.displayId ?? snapshot.targetDisplayId),
          width: fixture.width ?? 1,
          height: fixture.height ?? 1
        };
        return this.metadata();
      } catch (error) {
        if (this.ownerRequestId === requestId) this.clear(requestId);
        throw error;
      }
    }

    let permission = this.permissionStatus();
    if (permission === "denied") {
      this.clear(requestId);
      throw new ScreenContextError("permission-denied", "Screen Recording is off for Clarity.", permission);
    }
    if (permission === "restricted") {
      this.clear(requestId);
      throw new ScreenContextError("permission-restricted", "Screen Recording is restricted by this Mac's policy.", permission);
    }
    if (permission !== "granted" && permission !== "not-determined") {
      this.clear(requestId);
      throw new ScreenContextError("permission-unknown", "Clarity could not verify screen access.", permission);
    }

    const targetId = String(snapshot.targetDisplayId);
    let display = this.screen.getAllDisplays().find((candidate) => String(candidate.id) === targetId);
    if (!display) {
      this.clear(requestId);
      throw new ScreenContextError("display-changed", "The target display changed before Clarity could capture it. Try again.");
    }

    const window = this.overlayWindow;
    const wasVisible = Boolean(window && !window.isDestroyed() && window.isVisible());
    const wasFocused = Boolean(wasVisible && window.isFocused());
    const previousBounds = wasVisible ? window.getBounds() : null;
    const wasAlwaysOnTop = wasVisible ? window.isAlwaysOnTop() : false;

    try {
      if (wasVisible) {
        const hidden = waitForEvent(window, "hide", 250);
        window.hide();
        await hidden;
        await this.settle(100);
      }
      throwIfAborted(signal);
      display = this.screen.getAllDisplays().find((candidate) => String(candidate.id) === targetId);
      if (!display) throw new ScreenContextError("display-changed", "The target display changed before Clarity could capture it. Try again.");
      const sources = await this.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: thumbnailSize(display.size) });
      if (permission === "not-determined") {
        permission = this.permissionStatus();
        if (permission !== "granted") {
          const code = permission === "restricted" ? "permission-restricted" : permission === "denied" ? "permission-denied" : "permission-not-granted";
          throw new ScreenContextError(code, "Screen Recording permission was not granted.", permission);
        }
      }
      throwIfAborted(signal);
      let source = sources.find((candidate) => String(candidate.display_id) === targetId);
      if (!source && sources.length === 1) source = sources[0];
      if (!source) throw new ScreenContextError("source-unavailable", "Clarity could not find the target display. Try again.");
      if (!source.thumbnail || source.thumbnail.isEmpty()) throw new ScreenContextError("empty-capture", "macOS returned an empty screen capture. Try again.");

      let image = source.thumbnail;
      let bytes = image.toPNG();
      for (const edge of RESIZE_STEPS.slice(1)) {
        if (bytes.byteLength <= MAX_BYTES) break;
        image = image.resize({ ...thumbnailSize(image.getSize(), edge), quality: "best" });
        bytes = image.toPNG();
      }
      if (!bytes.byteLength) throw new ScreenContextError("empty-capture", "macOS returned an empty screen capture. Try again.");
      if (bytes.byteLength > MAX_BYTES) throw new ScreenContextError("oversized-capture", "The screen capture is too large to send safely.");
      if (this.ownerRequestId !== requestId) throw abortError();

      const size = image.getSize();
      this.attachment = {
        requestId,
        id: crypto.randomUUID(),
        mediaType: "image/png",
        bytes: Buffer.from(bytes),
        capturedAt: Date.now(),
        displayId: targetId,
        width: size.width,
        height: size.height
      };
      return this.metadata();
    } catch (error) {
      if (this.ownerRequestId === requestId) this.clear(requestId);
      throw error;
    } finally {
      if (wasVisible && window && !window.isDestroyed()) {
        if (previousBounds) window.setBounds(previousBounds, false);
        window.setAlwaysOnTop(wasAlwaysOnTop, "screen-saver", 1);
        if (wasFocused) {
          window.show();
          window.focus();
        } else {
          window.showInactive();
        }
      }
    }
  }
}
