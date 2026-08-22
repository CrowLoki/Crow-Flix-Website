import { describe, expect, it, vi } from "vitest";
import { RelayError } from "../src/errors";
import { allowedHostname, verifyTurnstile } from "../src/turnstile";

const env = {
  TURNSTILE_SECRET: "test-secret",
  TURNSTILE_ALLOWED_HOSTNAMES: "crowflix.tv,*.crow-flix.pages.dev",
  TURNSTILE_EXPECTED_ACTION: "epg_load",
};

function request(token?: string): Request {
  const headers = new Headers({ "CF-Connecting-IP": "203.0.113.5" });
  if (token) headers.set("X-Turnstile-Token", token);
  return new Request("https://relay.example/epg?country=AU&ids=ABC.au", { headers });
}

describe("Turnstile guide validation", () => {
  it("accepts exact and configured preview hostnames", () => {
    expect(allowedHostname("crowflix.tv", env.TURNSTILE_ALLOWED_HOSTNAMES)).toBe(true);
    expect(allowedHostname("branch.crow-flix.pages.dev", env.TURNSTILE_ALLOWED_HOSTNAMES)).toBe(true);
    expect(allowedHostname("crow-flix.pages.dev", env.TURNSTILE_ALLOWED_HOSTNAMES)).toBe(false);
    expect(allowedHostname("example.com", env.TURNSTILE_ALLOWED_HOSTNAMES)).toBe(false);
  });

  it("rejects a missing token without contacting Siteverify", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(verifyTurnstile(request(), env, fetcher)).rejects.toMatchObject({ status: 403 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when the Worker secret is unavailable", async () => {
    await expect(verifyTurnstile(request("token"), {}, vi.fn<typeof fetch>()))
      .rejects.toMatchObject({ status: 503 });
  });

  it("accepts a successful token with exact action and hostname", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      hostname: "crowflix.tv",
      action: "epg_load",
    }), { status: 200 }));
    await expect(verifyTurnstile(request("token"), env, fetcher)).resolves.toBeUndefined();
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("response=token");
    expect(String(init?.body)).toContain("remoteip=203.0.113.5");
  });

  it("fails closed on a malformed Siteverify response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("null", { status: 200 }),
    );
    await expect(verifyTurnstile(request("token"), env, fetcher))
      .rejects.toMatchObject({ status: 503 });
  });

  it.each([
    { success: false, hostname: "crowflix.tv", action: "epg_load" },
    { success: true, hostname: "evil.example", action: "epg_load" },
    { success: true, hostname: "crowflix.tv", action: "wrong_action" },
  ])("rejects an invalid Siteverify result", async (result) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(result), { status: 200 }),
    );
    await expect(verifyTurnstile(request("token"), env, fetcher))
      .rejects.toBeInstanceOf(RelayError);
  });
});
