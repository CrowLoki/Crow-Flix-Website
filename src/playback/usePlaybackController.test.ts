import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockHlsError = {
  fatal: boolean;
  type: string;
  details: string;
};

type MockHlsHandler = (event: string, data?: MockHlsError) => void;

type MockHlsInstance = {
  handlers: Map<string, MockHlsHandler>;
  config: Record<string, unknown>;
  loadSource: ReturnType<typeof vi.fn>;
  startLoad: ReturnType<typeof vi.fn>;
};

const hlsState = vi.hoisted(() => ({
  instances: [] as MockHlsInstance[],
  supported: true,
}));

vi.mock("hls.js", () => {
  class MockHls {
    static isSupported = () => hlsState.supported;
    static Events = {
      MEDIA_ATTACHED: "hlsMediaAttached",
      MANIFEST_PARSED: "hlsManifestParsed",
      ERROR: "hlsError",
    };
    static ErrorTypes = {
      NETWORK_ERROR: "networkError",
      MEDIA_ERROR: "mediaError",
    };
    static ErrorDetails = {
      MANIFEST_LOAD_ERROR: "manifestLoadError",
      MANIFEST_LOAD_TIMEOUT: "manifestLoadTimeOut",
      MANIFEST_PARSING_ERROR: "manifestParsingError",
      FRAG_LOAD_ERROR: "fragLoadError",
    };

    handlers = new Map<string, MockHlsHandler>();
    config: Record<string, unknown>;
    startLoad = vi.fn();
    loadSource = vi.fn();
    recoverMediaError = vi.fn();
    attachMedia = vi.fn();
    stopLoad = vi.fn();
    detachMedia = vi.fn();
    destroy = vi.fn();

    constructor(config: Record<string, unknown>) {
      this.config = config;
      hlsState.instances.push(this);
    }

    on(event: string, handler: MockHlsHandler): void {
      this.handlers.set(event, handler);
    }
  }

  return { default: MockHls };
});

import {
  PlaybackRun,
  readPlaybackHealth,
  SOURCE_HEALTH_CHANGED_EVENT,
  type PlaybackControllerState,
} from "./usePlaybackController";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("PlaybackRun retry", () => {
  beforeEach(() => {
    hlsState.instances.length = 0;
    hlsState.supported = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    hlsState.instances.length = 0;
  });

  it("rebuilds ordering and restarts at the fresh source zero after exhaustion", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const updates: PlaybackControllerState[] = [];
    const video = {
      ended: false,
      load: vi.fn(),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun(
      {
        key: "retry-channel",
        name: "Retry Channel",
        sources: [
          { id: "first", url: "rtmp://provider.test/first" },
          { id: "final", url: "rtmp://provider.test/final" },
        ],
      },
      video,
      (state) => updates.push(state),
    );

    run.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(updates[updates.length - 1]?.status).toBe("failed");
    expect(updates[updates.length - 1]?.source?.id).toBe("final");

    storage.setItem("crowflix:source-health:v1", JSON.stringify({
      first: { failures: 0, cooldownUntil: 0 },
      final: { failures: 2, cooldownUntil: Date.now() + 60_000 },
    }));
    updates.length = 0;
    run.retry();

    expect(updates[0]?.status).toBe("loading");
    expect(updates[0]?.sourceNumber).toBe(1);
    expect(updates[0]?.source?.id).toBe("first");
    run.dispose();
  });

  it("keeps a locally READY route ahead of a higher-scored catalogue hint", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem("crowflix:source-preflight:v1", JSON.stringify({
      ready: { status: "ready", checkedAt: Date.now(), transport: "hls" },
    }));
    const updates: PlaybackControllerState[] = [];
    const video = {
      ended: false,
      addEventListener: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      removeAttribute: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun({
      key: "ready-priority",
      name: "Ready Priority",
      sources: [
        { id: "catalogue", url: "https://provider.test/catalogue.m3u8", preferenceScore: 99_999 },
        { id: "ready", url: "https://provider.test/ready.m3u8", preferenceScore: 1 },
      ],
    }, video, (state) => updates.push(state));

    run.start();

    expect(updates[0]).toMatchObject({
      status: "loading",
      source: { id: "ready" },
      sourceNumber: 1,
    });
    run.dispose();
  });

  it("publishes safe source choices and switches to the selected route", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const updates: PlaybackControllerState[] = [];
    const video = {
      currentTime: 0,
      ended: false,
      addEventListener: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      removeAttribute: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun({
      key: "source-chooser",
      name: "Source Chooser",
      sources: [
        {
          id: "primary-route",
          url: "https://private-provider.test/live.m3u8?token=hidden",
          delivery: "relay",
          provenance: "IPTV-org",
          provenances: ["IPTV-org", "Mirror index"],
          quality: "1080p",
          preferenceScore: 100,
        },
        {
          id: "backup-route",
          url: "https://backup-provider.test/live.m3u8?token=hidden-too",
          delivery: "direct",
          title: "Provider backup",
          preferenceScore: 90,
        },
      ],
    }, video, (state) => updates.push(state));

    run.start();
    const initial = updates[updates.length - 1];
    expect(initial?.sourceOptions).toHaveLength(2);
    expect(initial?.sourceOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "primary-route",
        label: "IPTV-org + Mirror index",
        detail: "Relay · 1080p · HLS",
      }),
      expect.objectContaining({
        sourceId: "backup-route",
        label: "Provider backup",
        detail: "Direct · HLS",
      }),
    ]));
    expect(JSON.stringify(initial?.sourceOptions)).not.toContain("provider.test");
    expect(JSON.stringify(initial?.sourceOptions)).not.toContain("token=");

    const target = initial?.sourceOptions.find((option) => !option.active);
    expect(target).toBeDefined();
    const updateCount = updates.length;
    run.select(target?.index ?? -1);
    expect(updates).toHaveLength(updateCount + 1);
    expect(updates[updates.length - 1]).toMatchObject({
      status: "switching",
      source: { id: target?.sourceId },
      sourceNumber: (target?.index ?? 0) + 1,
    });

    const selectedUpdateCount = updates.length;
    run.select(target?.index ?? -1);
    run.select(-1);
    run.select(99);
    expect(updates).toHaveLength(selectedUpdateCount);
    run.dispose();
  });

  it("moves a newly READY untried route directly behind a failed route", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const updates: PlaybackControllerState[] = [];
    const video = {
      currentTime: 0,
      ended: false,
      addEventListener: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      removeAttribute: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun({
      key: "late-ready",
      name: "Late Ready",
      sources: [
        { id: "primary", url: "https://provider.test/primary.m3u8", preferenceScore: 100_000 },
        { id: "ordinary", url: "https://provider.test/ordinary.m3u8", preferenceScore: 90_000 },
        { id: "late-ready", url: "https://provider.test/ready.m3u8", preferenceScore: 1 },
      ],
    }, video, (state) => updates.push(state));

    run.start();
    await vi.waitFor(() => expect(hlsState.instances).toHaveLength(1));
    const primary = hlsState.instances[0];
    primary?.handlers.get("hlsMediaAttached")?.("hlsMediaAttached");
    storage.setItem("crowflix:source-preflight:v1", JSON.stringify({
      "late-ready": { status: "ready", checkedAt: Date.now(), transport: "hls" },
    }));
    primary?.handlers.get("hlsError")?.("hlsError", {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(updates[updates.length - 1]).toMatchObject({
      status: "switching",
      source: { id: "late-ready" },
      sourceNumber: 2,
    });
    run.dispose();
  });

  it("exports health safely and announces a source-health change", async () => {
    const storage = memoryStorage();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { dispatchEvent });
    const video = {
      ended: false,
      load: vi.fn(),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun({
      key: "health-channel",
      name: "Health Channel",
      sources: [{ id: "unsupported-health", url: "rtmp://provider.test/live" }],
    }, video, vi.fn());

    run.start();
    await Promise.resolve();

    expect(readPlaybackHealth()).toMatchObject({
      "unsupported-health": { failures: 1 },
    });
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: SOURCE_HEALTH_CHANGED_EVENT,
    });
    run.dispose();
  });

  it("ignores malformed health entries", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem("crowflix:source-health:v1", JSON.stringify({
      valid: { failures: 2, cooldownUntil: 1_000, lastSuccessAt: 900 },
      negative: { failures: -1, cooldownUntil: 0 },
      string: "not health",
      infinite: { failures: 1, cooldownUntil: "Infinity" },
    }));

    expect(readPlaybackHealth()).toEqual({
      valid: { failures: 2, cooldownUntil: 1_000, lastSuccessAt: 900 },
    });
  });

  it("fails over immediately after a fatal manifest error with a bounded manifest policy", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const updates: PlaybackControllerState[] = [];
    const video = {
      currentTime: 0,
      ended: false,
      addEventListener: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      removeAttribute: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun(
      {
        key: "hls-recovery-channel",
        name: "HLS Recovery Channel",
        sources: [
          { id: "primary", url: "https://provider.test/primary.m3u8" },
          { id: "backup", url: "https://provider.test/backup.m3u8" },
        ],
      },
      video,
      (state) => updates.push(state),
    );

    run.start();
    await vi.waitFor(() => expect(hlsState.instances).toHaveLength(1));
    const primary = hlsState.instances[0];
    primary?.handlers.get("hlsMediaAttached")?.("hlsMediaAttached");
    const onError = primary?.handlers.get("hlsError");
    expect(onError).toBeDefined();
    expect(primary.loadSource).toHaveBeenCalledOnce();
    expect(primary.config).toMatchObject({
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 7_000,
          maxLoadTimeMs: 10_000,
          timeoutRetry: null,
          errorRetry: null,
        },
      },
      playlistLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 7_000,
          maxLoadTimeMs: 10_000,
          timeoutRetry: null,
          errorRetry: null,
        },
      },
    });

    onError?.("hlsError", {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(primary.loadSource).toHaveBeenCalledOnce();
    expect(primary.startLoad).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(hlsState.instances).toHaveLength(2));
    expect(updates[updates.length - 1]).toMatchObject({
      status: "switching",
      source: { id: "backup" },
    });
    expect(JSON.parse(storage.getItem("crowflix:source-health:v1") || "{}"))
      .toMatchObject({ primary: { failures: 1 } });
    expect(updates.some((state) => state.message.includes("stream manifest"))).toBe(true);
    expect(updates.some((state) => state.diagnostics[0]?.phase === "manifest")).toBe(true);
    run.dispose();
  });

  it("uses startLoad for a first fatal post-manifest network error", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const video = {
      currentTime: 0,
      ended: false,
      addEventListener: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      removeAttribute: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun(
      {
        key: "hls-fragment-recovery-channel",
        name: "HLS Fragment Recovery Channel",
        sources: [
          { id: "primary", url: "https://provider.test/primary.m3u8" },
        ],
      },
      video,
      vi.fn(),
    );

    run.start();
    await vi.waitFor(() => expect(hlsState.instances).toHaveLength(1));
    const primary = hlsState.instances[0];
    primary?.handlers.get("hlsMediaAttached")?.("hlsMediaAttached");
    const onError = primary?.handlers.get("hlsError");

    onError?.("hlsError", {
      fatal: true,
      type: "networkError",
      details: "fragLoadError",
    });

    expect(primary.loadSource).toHaveBeenCalledOnce();
    expect(primary.startLoad).toHaveBeenCalledOnce();
    expect(storage.getItem("crowflix:source-health:v1")).toBeNull();
    run.dispose();
  });

  it("uses native HLS when the lazy HLS.js runtime is unsupported", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    hlsState.supported = false;
    const video = {
      src: "",
      currentTime: 0,
      ended: false,
      addEventListener: vi.fn(),
      canPlayType: vi.fn(() => "maybe"),
      load: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      removeAttribute: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun({
      key: "native-hls",
      name: "Native HLS",
      sources: [{ id: "native", url: "https://provider.test/native.m3u8" }],
    }, video, vi.fn());

    run.start();
    await vi.waitFor(() => expect(video.load).toHaveBeenCalledOnce());

    expect(video.src).toBe("https://provider.test/native.m3u8");
    expect(video.canPlayType).toHaveBeenCalledWith("application/vnd.apple.mpegurl");
    expect(hlsState.instances).toHaveLength(0);
    run.dispose();
  });
});
