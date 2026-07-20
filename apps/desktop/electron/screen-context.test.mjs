import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ScreenContextError, ScreenContextService } from "./screen-context.mjs";

function fakeImage(bytes = 20) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 1200, height: 800 }),
    toPNG: () => Buffer.alloc(bytes, 1),
    resize: () => fakeImage(Math.min(bytes, 10))
  };
}

function fakeWindow() {
  const window = new EventEmitter();
  Object.assign(window, {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => false,
    isAlwaysOnTop: () => true,
    getBounds: () => ({ x: 10, y: 10, width: 500, height: 100 }),
    hide: () => queueMicrotask(() => window.emit("hide")),
    setBounds: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    showInactive: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  });
  return window;
}

function service({ permission = "granted", sources } = {}) {
  const overlayWindow = fakeWindow();
  return {
    overlayWindow,
    instance: new ScreenContextService({
      desktopCapturer: { getSources: vi.fn(async () => sources ?? [{ display_id: "2", thumbnail: fakeImage() }]) },
      screen: { getAllDisplays: () => [{ id: 2, size: { width: 2560, height: 1440 } }] },
      systemPreferences: { getMediaAccessStatus: () => permission },
      overlayWindow,
      platform: "darwin",
      settle: async () => {}
    })
  };
}

describe("ScreenContextService", () => {
  it("captures the frozen display and exposes bytes only to the owning request", async () => {
    const { instance, overlayWindow } = service();
    const metadata = await instance.capture("request-1", { targetDisplayId: 2 });
    expect(metadata.displayId).toBe("2");
    expect(metadata).not.toHaveProperty("bytes");
    expect(instance.readForProvider("other")).toBeNull();
    expect(instance.readForProvider("request-1").base64).toBeTruthy();
    expect(instance.getPreview(metadata.id).bytes).toBeInstanceOf(Uint8Array);
    expect(overlayWindow.showInactive).toHaveBeenCalled();
  });

  it("fails closed when permission is denied", async () => {
    const { instance } = service({ permission: "denied" });
    await expect(instance.capture("request-1", { targetDisplayId: 2 })).rejects.toMatchObject({ code: "permission-denied" });
    expect(instance.metadata()).toBeNull();
  });

  it("invalidates the old preview when cleared", async () => {
    const { instance } = service();
    const metadata = await instance.capture("request-1", { targetDisplayId: 2 });
    instance.clear("request-1");
    expect(instance.getPreview(metadata.id)).toBeNull();
  });

  it("reports a display topology change instead of capturing a different source", async () => {
    const { instance } = service();
    await expect(instance.capture("request-1", { targetDisplayId: 99 })).rejects.toBeInstanceOf(ScreenContextError);
  });
});
