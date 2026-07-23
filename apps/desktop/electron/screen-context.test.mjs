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
    hide: vi.fn(() => queueMicrotask(() => window.emit("hide"))),
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
  const permissions = Array.isArray(permission) ? [...permission] : [permission];
  let permissionIndex = 0;
  return {
    overlayWindow,
    instance: new ScreenContextService({
      desktopCapturer: { getSources: vi.fn(async () => sources ?? [{ display_id: "2", thumbnail: fakeImage() }]) },
      screen: { getAllDisplays: () => [{ id: 2, size: { width: 2560, height: 1440 } }] },
      systemPreferences: { getMediaAccessStatus: () => permissions[Math.min(permissionIndex++, permissions.length - 1)] },
      overlayWindow,
      platform: "darwin",
      settle: async () => {}
    })
  };
}

describe("ScreenContextService", () => {
  it("captures the current display without hiding the overlay and exposes bytes only to the owning request", async () => {
    const { instance, overlayWindow } = service();
    const metadata = await instance.capture("request-1", { targetDisplayId: 2 });
    expect(metadata.displayId).toBe("2");
    expect(metadata).not.toHaveProperty("bytes");
    expect(instance.readForProvider("other")).toBeNull();
    expect(instance.readForProvider("request-1").base64).toBeTruthy();
    expect(instance.getPreview(metadata.id).bytes).toBeInstanceOf(Uint8Array);
    expect(overlayWindow.hide).not.toHaveBeenCalled();
    expect(overlayWindow.showInactive).not.toHaveBeenCalled();
  });

  it("accepts a real capture when macOS reports a stale denied status", async () => {
    const { instance } = service({ permission: "denied" });
    await expect(instance.capture("request-1", { targetDisplayId: 2 })).resolves.toMatchObject({ displayId: "2" });
    expect(instance.hasVerifiedScreenAccess()).toBe(true);
  });

  it("fails closed when a denied permission cannot produce a capture", async () => {
    const { instance } = service({ permission: "denied", sources: [] });
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

  it.each([
    ["restricted", "permission-restricted"],
    ["unexpected", "permission-unknown"]
  ])("fails closed for %s permission", async (permission, code) => {
    const { instance } = service({ permission });
    await expect(instance.capture("request-1", { targetDisplayId: 2 })).rejects.toMatchObject({ code });
    expect(instance.metadata()).toBeNull();
  });

  it("accepts a non-empty capture when permission status remains unresolved", async () => {
    const { instance } = service({ permission: ["not-determined", "denied"] });
    await expect(instance.capture("request-1", { targetDisplayId: 2 })).resolves.toMatchObject({ displayId: "2" });
    expect(instance.hasVerifiedScreenAccess()).toBe(true);
  });

  it("keeps the overlay visible when the capture source is unavailable or empty", async () => {
    const unavailable = service({ sources: [] });
    await expect(unavailable.instance.capture("request-1", { targetDisplayId: 2 })).rejects.toMatchObject({ code: "source-unavailable" });
    expect(unavailable.instance.metadata()).toBeNull();
    expect(unavailable.overlayWindow.hide).not.toHaveBeenCalled();

    const empty = service({ sources: [{ display_id: "2", thumbnail: { isEmpty: () => true } }] });
    await expect(empty.instance.capture("request-1", { targetDisplayId: 2 })).rejects.toMatchObject({ code: "empty-capture" });
    expect(empty.instance.metadata()).toBeNull();
    expect(empty.overlayWindow.hide).not.toHaveBeenCalled();
  });

  it("uses the only non-empty source when Electron omits its display identifier", async () => {
    const { instance } = service({ sources: [{ display_id: "", thumbnail: fakeImage() }] });
    await expect(instance.capture("request-1", { targetDisplayId: 2 })).resolves.toMatchObject({ displayId: "2" });
  });

  it("rejects an oversized capture after exhausting resize attempts", async () => {
    const oversizedImage = {
      isEmpty: () => false,
      getSize: () => ({ width: 2560, height: 1440 }),
      toPNG: () => Buffer.alloc(5 * 1024 * 1024 + 1, 1),
      resize: () => oversizedImage
    };
    const { instance } = service({ sources: [{ display_id: "2", thumbnail: oversizedImage }] });
    await expect(instance.capture("request-1", { targetDisplayId: 2 })).rejects.toMatchObject({ code: "oversized-capture" });
    expect(instance.metadata()).toBeNull();
  });

  it("cleans up when capture is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { instance } = service();
    await expect(instance.capture("request-1", { targetDisplayId: 2 }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(instance.metadata()).toBeNull();
  });
});
