import { describe, expect, it } from "vitest";
import {
  describeDashFailure,
  describeHlsFailure,
  describeMediaElementFailure,
  extractHttpStatus,
  networkFailureMessage,
} from "./failureDetails";

const direct = {
  id: "direct",
  url: "https://provider.test/live.m3u8?secret=hidden",
  delivery: "direct" as const,
};

describe("privacy-safe playback failure details", () => {
  it("extracts known HTTP status shapes without returning upstream text", () => {
    expect(extractHttpStatus({ response: { code: 403, text: "secret upstream URL" } }))
      .toBe(403);
    expect(extractHttpStatus({ error: { status: 502, message: "private" } }))
      .toBe(502);
    expect(extractHttpStatus({ code: 27 })).toBeUndefined();
  });

  it("identifies an HLS manifest refusal with phase and status", () => {
    expect(describeHlsFailure({
      type: "networkError",
      details: "manifestLoadError",
      response: { code: 403, text: "do not surface" },
    }, false, direct)).toEqual({
      reason: "network",
      phase: "manifest",
      httpStatus: 403,
      message: "The provider refused the stream manifest (HTTP 403). It may not allow this connection or region.",
    });
  });

  it("distinguishes post-start DASH media failures and decode failures", () => {
    expect(describeDashFailure({ response: { status: 404 } }, true, direct))
      .toMatchObject({ reason: "network", phase: "media", httpStatus: 404 });
    expect(describeMediaElementFailure(3, true, direct))
      .toMatchObject({ reason: "media", phase: "decode" });
  });

  it("uses a relay-specific message without exposing an endpoint", () => {
    const message = networkFailureMessage("manifest", undefined, "relay");
    expect(message).toBe("The stream manifest could not be reached through the CrowFlix relay.");
    expect(message).not.toContain("provider.test");
  });
});
