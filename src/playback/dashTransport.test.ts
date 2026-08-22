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

describe("native DASH transport", () => {
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
