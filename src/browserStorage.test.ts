import { afterEach, describe, expect, it, vi } from "vitest";
import { browserStorage, saveBrowserValue } from "./browserStorage";
import {
  DEFAULT_WEB_DESTINATIONS,
  loadWebDestinations,
  saveWebDestinations,
} from "./webDestinations";

afterEach(() => {
  vi.unstubAllGlobals();
});

function denyBrowserStorage() {
  const getter = vi.fn(() => {
    throw new Error("Storage access denied");
  });
  vi.stubGlobal("localStorage", undefined);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: getter,
  });
  return getter;
}

describe("browser storage adapter", () => {
  it("loads without reading a denied localStorage getter", async () => {
    const getter = denyBrowserStorage();
    vi.resetModules();

    const imported = await import("./browserStorage");

    expect(imported.browserStorage).toBeDefined();
    expect(getter).not.toHaveBeenCalled();
    expect(() => imported.browserStorage.getItem("key")).toThrow(
      "Storage access denied",
    );
  });

  it("delegates reads, writes, and removals with the storage receiver", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem(key: string) {
        expect(this).toBe(storage);
        return stored.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        expect(this).toBe(storage);
        stored.set(key, value);
      },
      removeItem(key: string) {
        expect(this).toBe(storage);
        stored.delete(key);
      },
    };
    vi.stubGlobal("localStorage", storage);

    expect(browserStorage.getItem("key")).toBeNull();
    browserStorage.setItem("key", "value");
    expect(browserStorage.getItem("key")).toBe("value");
    browserStorage.removeItem("key");
    expect(browserStorage.getItem("key")).toBeNull();
  });

  it("leaves denied getter errors available to existing library helpers", () => {
    denyBrowserStorage();

    expect(loadWebDestinations(browserStorage)).toEqual({
      items: DEFAULT_WEB_DESTINATIONS,
      error: "Storage access denied",
    });
    expect(saveWebDestinations(browserStorage, DEFAULT_WEB_DESTINATIONS)).toBe(
      "Storage access denied",
    );
    expect(() => browserStorage.removeItem("key")).toThrow(
      "Storage access denied",
    );
  });

  it("propagates failures from storage methods", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("Read failed"); },
      setItem: () => { throw new Error("Quota exceeded"); },
      removeItem: () => { throw new Error("Removal failed"); },
    });

    expect(() => browserStorage.getItem("key")).toThrow("Read failed");
    expect(() => browserStorage.setItem("key", "value")).toThrow("Quota exceeded");
    expect(() => browserStorage.removeItem("key")).toThrow("Removal failed");
  });
});

describe("best-effort browser preference saves", () => {
  it("serializes and saves a preference when storage is available", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });

    expect(saveBrowserValue("favorites", ["channel-1"])).toBe(true);
    expect(setItem).toHaveBeenCalledWith("favorites", '["channel-1"]');
  });

  it("returns failure without throwing when the storage getter is denied", () => {
    denyBrowserStorage();

    expect(saveBrowserValue("recent", ["channel-1"])).toBe(false);
  });

  it("returns failure without throwing when a write exceeds the quota", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => { throw new Error("Quota exceeded"); },
    });

    expect(saveBrowserValue("favorites", ["channel-1"])).toBe(false);
  });

  it("does not replace a saved preference when JSON serialization fails", () => {
    const setItem = vi.fn();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    vi.stubGlobal("localStorage", { setItem });

    expect(saveBrowserValue("recent", circular)).toBe(false);
    expect(saveBrowserValue("recent", undefined)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });
});
