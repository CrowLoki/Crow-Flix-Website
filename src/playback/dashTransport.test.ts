import type { MediaPlayerClass } from "dashjs";
import type { RequestInterceptor } from "@svta/cml-request";
import { describe, expect, it, vi } from "vitest";
import { MAX_PLAYBACK_METADATA_BYTES } from "./boundedResponse";
import { toWebPlayableSources } from "../relayClient";
import { installNativeDashTransport } from "./dashTransport";
import type { MediaFetcher } from "./nativeFetch";
import type { StreamSource } from "./types";

type CapturedLoader = {
  load: (
    request: {
      method: string;
      url: string;
      responseType?: XMLHttpRequestResponseType;
      headers?: Record<string, string>;
      customData?: {
        abort?: () => void;
        onabort?: () => void;
        onloadend?: () => void;
      };
    },
    response: Record<string, unknown>,
  ) => boolean;
  abort: () => void;
};

function captureTransport(source: StreamSource, fetcher: MediaFetcher) {
  let loaderFactory: (() => CapturedLoader) | undefined;
  let requestInterceptor: RequestInterceptor | undefined;
  const player = {
    extend: (_name: string, extension: () => CapturedLoader) => {
      loaderFactory = extension;
    },
    addRequestInterceptor: (interceptor: RequestInterceptor) => {
      requestInterceptor = interceptor;
    },
  } as unknown as MediaPlayerClass;
  installNativeDashTransport(player, source, fetcher);
  return { loader: loaderFactory!(), requestInterceptor };
}

function responseAt(url: string, body: string, headers?: HeadersInit): Response {
  const response = new Response(body, { headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("native DASH transport", () => {
  it.each(["logical", "intercepted"])(
    "resolves a redirected relayed MPD's relative segments from the final URL (%s request)",
    async (requestForm) => {
      const originalUrl = "https://provider.test/start/channel.mpd";
      const finalUrl = "https://cdn.test/live/path/manifest.mpd?ticket=fixture";
      const manifest = '<MPD><Period><AdaptationSet><SegmentTemplate media="video/segment-$Number$.m4s" /></AdaptationSet></Period></MPD>';
      const [source] = toWebPlayableSources({
        id: "redirected-dash",
        url: originalUrl,
        transport: "dash",
        userAgent: "Provider UA",
        referrer: "https://provider.test/watch",
      });
      const fetcher: MediaFetcher = vi.fn(async (url) => {
        const upstream = new URL(url).searchParams.get("url")!;
        return responseAt(url, upstream === originalUrl ? manifest : "segment bytes", {
          "X-CrowFlix-Upstream-Url": upstream === originalUrl ? finalUrl : upstream,
        });
      });
      const { loader, requestInterceptor } = captureTransport(source!, fetcher);
      const target: Record<string, unknown> = {};
      const onloadend = vi.fn();
      loader.load({
        method: "GET",
        url: requestForm === "logical" ? originalUrl : source!.url,
        responseType: "text",
        customData: { onloadend },
      }, target);

      await vi.waitFor(() => expect(onloadend).toHaveBeenCalledOnce());
      expect(target.url).toBe(finalUrl);
      expect(target.data).toBe(manifest);
      const media = /media="([^"]+)"/.exec(String(target.data))![1].replace("$Number$", "1");
      const segmentUrl = new URL(media, String(target.url)).href;
      expect(segmentUrl).toBe("https://cdn.test/live/path/video/segment-1.m4s");
      const intercepted = await requestInterceptor!({ url: segmentUrl, responseType: "arrayBuffer" });
      const routed = new URL(intercepted.url);
      expect(routed.searchParams.get("url")).toBe(segmentUrl);
      expect(routed.searchParams.get("ua")).toBe("Provider UA");
      expect(routed.searchParams.get("referer")).toBe("https://provider.test/watch");

      const segmentLoaded = vi.fn();
      loader.load({
        method: "GET",
        url: intercepted.url,
        responseType: "arraybuffer",
        headers: { Range: "bytes=0-4095" },
        customData: { onloadend: segmentLoaded },
      }, {});
      await vi.waitFor(() => expect(segmentLoaded).toHaveBeenCalledOnce());
      expect(fetcher).toHaveBeenLastCalledWith(intercepted.url, source, expect.objectContaining({
        headers: expect.any(Headers),
      }));
      expect(new Headers(vi.mocked(fetcher).mock.calls[1][2]?.headers).get("Range")).toBe("bytes=0-4095");
    },
  );

  it("uses the actual direct redirect URL and ignores upstream-spoofed relay metadata", async () => {
    const originalUrl = "https://provider.test/channel.mpd";
    const finalUrl = "https://cdn.test/direct/manifest.mpd";
    const [source] = toWebPlayableSources({ id: "direct-dash", url: originalUrl, transport: "dash" });
    const fetcher: MediaFetcher = vi.fn(async () => responseAt(finalUrl, "<MPD />", {
      "X-CrowFlix-Upstream-Url": "https://spoofed.test/manifest.mpd",
    }));
    const { loader, requestInterceptor } = captureTransport(source!, fetcher);
    const target: Record<string, unknown> = {};
    const onloadend = vi.fn();
    loader.load({ method: "GET", url: originalUrl, customData: { onloadend } }, target);

    await vi.waitFor(() => expect(onloadend).toHaveBeenCalledOnce());
    expect(requestInterceptor).toBeUndefined();
    expect(target.url).toBe(finalUrl);
    expect(new URL("video/1.m4s", String(target.url)).href).toBe("https://cdn.test/direct/video/1.m4s");
    expect(fetcher).toHaveBeenCalledWith(originalUrl, source, expect.any(Object));
  });

  it.each([
    ["relative URL", "/relative/manifest.mpd"],
    ["script URL", "javascript:alert(1)"],
    ["file URL", "file:///private/manifest.mpd"],
    ["embedded credentials", "https://user:password@cdn.test/manifest.mpd"],
    ["control characters", "https://cdn.test/mani\tfest.mpd"],
    ["oversized URL", `https://cdn.test/${"x".repeat(8_192)}`],
  ])("ignores malformed or unsafe relay URL metadata: %s", async (_label, metadata) => {
    const originalUrl = "https://provider.test/channel.mpd";
    const [source] = toWebPlayableSources({ id: "relay-dash", url: originalUrl, userAgent: "Provider UA" });
    const fetcher: MediaFetcher = vi.fn(async (url) => responseAt(url, "<MPD />", {
      "X-CrowFlix-Upstream-Url": metadata,
    }));
    const { loader } = captureTransport(source!, fetcher);
    const target: Record<string, unknown> = {};
    const onloadend = vi.fn();
    loader.load({ method: "GET", url: source!.url, customData: { onloadend } }, target);

    await vi.waitFor(() => expect(onloadend).toHaveBeenCalledOnce());
    expect(target.url).toBe(originalUrl);
  });

  it("ignores relay metadata on a response redirected away from the configured relay", async () => {
    const originalUrl = "https://provider.test/channel.mpd";
    const [source] = toWebPlayableSources({ id: "relay-dash", url: originalUrl, userAgent: "Provider UA" });
    const fetcher: MediaFetcher = vi.fn(async () => responseAt("https://upstream.test/stream", "<MPD />", {
      "X-CrowFlix-Upstream-Url": "https://spoofed.test/manifest.mpd",
    }));
    const { loader } = captureTransport(source!, fetcher);
    const target: Record<string, unknown> = {};
    const onloadend = vi.fn();
    loader.load({ method: "GET", url: source!.url, customData: { onloadend } }, target);

    await vi.waitFor(() => expect(onloadend).toHaveBeenCalledOnce());
    expect(target.url).toBe(originalUrl);
  });

  it("routes MPD, initialization and media requests through the relay while preserving logical URLs", async () => {
    let loaderFactory: (() => CapturedLoader) | undefined;
    let requestInterceptor: RequestInterceptor | undefined;
    const player = {
      extend: (_name: string, extension: () => CapturedLoader) => {
        loaderFactory = extension;
      },
      addRequestInterceptor: (interceptor: RequestInterceptor) => {
        requestInterceptor = interceptor;
      },
    } as unknown as MediaPlayerClass;
    const [source] = toWebPlayableSources({
      id: "relative-dash",
      url: "https://provider.test/live/channel.mpd",
      userAgent: "Provider UA",
      transport: "dash",
    });
    const requested: string[] = [];
    const fetcher: MediaFetcher = vi.fn(async (url) => {
      requested.push(url);
      return new Response(new Uint8Array([1, 2, 3]), { status: 206 });
    });

    installNativeDashTransport(player, source!, fetcher);
    expect(requestInterceptor).toBeDefined();
    const logicalUrls = [
      "https://provider.test/live/channel.mpd",
      "https://provider.test/live/video/init.mp4",
      "https://provider.test/live/video/segment-1.m4s",
    ];

    for (const logicalUrl of logicalUrls) {
      const target: Record<string, unknown> = {};
      const onloadend = vi.fn();
      loaderFactory!().load({
        method: "GET",
        url: logicalUrl,
        responseType: "arraybuffer",
        customData: { onloadend },
      }, target);
      await vi.waitFor(() => expect(onloadend).toHaveBeenCalledOnce());
      expect(target.url).toBe(logicalUrl);
    }

    expect(requested).toHaveLength(3);
    expect(requested.map((url) => new URL(url).searchParams.get("url")))
      .toEqual(logicalUrls);

    const lowLatencyRequest = await requestInterceptor!({
      url: "https://provider.test/live/video/chunk-2.m4s",
      responseType: "arrayBuffer",
    });
    expect(new URL(lowLatencyRequest.url).searchParams.get("url"))
      .toBe("https://provider.test/live/video/chunk-2.m4s");
  });

  it("notifies dash.js of an abort exactly once and suppresses late completion", async () => {
    let loaderFactory: (() => CapturedLoader) | undefined;
    const player = {
      extend: (_name: string, extension: () => CapturedLoader) => {
        loaderFactory = extension;
      },
    } as unknown as MediaPlayerClass;
    const source: StreamSource = {
      id: "dash-test",
      url: "https://provider.test/live.mpd",
    };
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetcher: MediaFetcher = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    installNativeDashTransport(player, source, fetcher);
    expect(loaderFactory).toBeTypeOf("function");

    const loader = loaderFactory!();
    const onabort = vi.fn();
    const onloadend = vi.fn();
    const customData: {
      abort?: () => void;
      onabort: () => void;
      onloadend: () => void;
    } = { onabort, onloadend };
    const request = {
      method: "GET",
      url: source.url,
      customData,
    };

    expect(loader.load(request, {})).toBe(true);
    request.customData.abort?.();
    request.customData.abort?.();
    loader.abort();

    resolveFetch?.(new Response("<MPD />"));
    await Promise.resolve();
    await Promise.resolve();

    expect(onabort).toHaveBeenCalledTimes(1);
    expect(onloadend).not.toHaveBeenCalled();
  });

  it("reports an oversized manifest as a safe local 413 response", async () => {
    let loaderFactory: (() => CapturedLoader) | undefined;
    const player = {
      extend: (_name: string, extension: () => CapturedLoader) => {
        loaderFactory = extension;
      },
    } as unknown as MediaPlayerClass;
    const source: StreamSource = {
      id: "dash-test",
      url: "https://provider.test/live.mpd",
    };
    const fetcher: MediaFetcher = vi.fn(async () => new Response("<MPD />", {
      headers: {
        "content-length": String(MAX_PLAYBACK_METADATA_BYTES + 1),
      },
    }));

    installNativeDashTransport(player, source, fetcher);
    const loader = loaderFactory!();
    const target: Record<string, unknown> = {};
    const onloadend = vi.fn();
    loader.load({
      method: "GET",
      url: source.url,
      responseType: "text",
      customData: { onloadend },
    }, target);

    await vi.waitFor(() => expect(onloadend).toHaveBeenCalledOnce());
    expect(target.status).toBe(413);
    expect(target.statusText).toBe(
      "The DASH response is larger than CrowFlix's 4 MiB safety limit.",
    );
    expect(target.data).toBeNull();
  });
});
