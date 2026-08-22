import { RelayError } from "./errors";

export const TURNSTILE_TOKEN_HEADER = "X-Turnstile-Token";
export const DEFAULT_TURNSTILE_ACTION = "epg_load";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2_048;
const VERIFY_TIMEOUT_MS = 10_000;

export type TurnstileEnvironment = {
  TURNSTILE_SECRET?: string;
  TURNSTILE_ALLOWED_HOSTNAMES?: string;
  TURNSTILE_EXPECTED_ACTION?: string;
};

type SiteverifyResult = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

function allowedHostname(hostname: string, configured: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return configured
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((allowed) => {
      if (allowed.startsWith("*.")) {
        const suffix = allowed.slice(1);
        return normalized.endsWith(suffix) && normalized.length > suffix.length;
      }
      return normalized === allowed;
    });
}

export async function verifyTurnstile(
  request: Request,
  env: TurnstileEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const secret = env.TURNSTILE_SECRET?.trim();
  const allowedHostnames = env.TURNSTILE_ALLOWED_HOSTNAMES?.trim();
  const expectedAction = env.TURNSTILE_EXPECTED_ACTION?.trim() || DEFAULT_TURNSTILE_ACTION;
  if (!secret || !allowedHostnames) {
    throw new RelayError(503, "Guide verification is temporarily unavailable.");
  }

  const token = request.headers.get(TURNSTILE_TOKEN_HEADER)?.trim() ?? "";
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    throw new RelayError(403, "Complete the browser verification before loading guide data.");
  }

  const form = new URLSearchParams({ secret, response: token });
  const remoteIp = request.headers.get("CF-Connecting-IP")?.trim();
  if (remoteIp) form.set("remoteip", remoteIp);

  let response: Response;
  try {
    response = await fetcher(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    throw new RelayError(503, "Guide verification is temporarily unavailable.");
  }
  if (!response.ok) {
    throw new RelayError(503, "Guide verification is temporarily unavailable.");
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new RelayError(503, "Guide verification is temporarily unavailable.");
  }
  if (typeof result !== "object" || result === null) {
    throw new RelayError(503, "Guide verification is temporarily unavailable.");
  }
  const verification = result as SiteverifyResult;
  if (
    verification.success !== true
    || verification.action !== expectedAction
    || typeof verification.hostname !== "string"
    || !allowedHostname(verification.hostname, allowedHostnames)
  ) {
    throw new RelayError(403, "Cloudflare could not verify this guide request. Please try again.");
  }
}

export { allowedHostname };
