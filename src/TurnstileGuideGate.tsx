import { useEffect, useRef, useState } from "react";

const TURNSTILE_SCRIPT_ID = "crowflix-turnstile-script";
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export const TURNSTILE_ACTION = "epg_load";
export const TURNSTILE_SITEKEY =
  (import.meta.env.VITE_TURNSTILE_SITEKEY as string | undefined)?.trim() ?? "";

type TurnstileOptions = {
  sitekey: string;
  action: string;
  theme: "dark";
  size: "flexible";
  appearance: "always";
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": (code?: string) => void;
  "timeout-callback": () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileOptions) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const removeScript = () => document.getElementById(TURNSTILE_SCRIPT_ID)?.remove();
    const finish = () => {
      if (window.turnstile) resolve(window.turnstile);
      else {
        removeScript();
        reject(new Error("Cloudflare verification did not initialize."));
      }
    };
    const fail = () => {
      removeScript();
      reject(new Error("Cloudflare verification could not be loaded."));
    };
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", finish, { once: true });
      existing.addEventListener("error", fail, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", fail, { once: true });
    document.head.append(script);
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });

  return scriptPromise;
}

export default function TurnstileGuideGate({
  error,
  onError,
  onVerified,
}: {
  error: string | null;
  onError: (message: string) => void;
  onVerified: (token: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  const onVerifiedRef = useRef(onVerified);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onVerifiedRef.current = onVerified; }, [onVerified]);

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | null = null;
    if (!TURNSTILE_SITEKEY) {
      onErrorRef.current("Guide verification is not configured for this deployment.");
      return undefined;
    }
    void loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: TURNSTILE_SITEKEY,
          action: TURNSTILE_ACTION,
          theme: "dark",
          size: "flexible",
          appearance: "always",
          callback: (token) => {
            if (token.length > 0) onVerifiedRef.current(token);
          },
          "expired-callback": () => {
            onErrorRef.current("Verification expired. Please try again.");
          },
          "error-callback": () => {
            onErrorRef.current("Cloudflare could not verify this guide request.");
          },
          "timeout-callback": () => {
            onErrorRef.current("Cloudflare verification timed out. Please try again.");
          },
        });
      })
      .catch((loadError) => {
        if (!cancelled) {
          onErrorRef.current(loadError instanceof Error ? loadError.message : String(loadError));
        }
      });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [attempt]);

  return (
    <section className="turnstile-gate" aria-labelledby="guide-verification-title">
      <div>
        <h2 id="guide-verification-title">Verify this guide request</h2>
        <p>Cloudflare verifies this one programme-guide request to protect the public Crow-Flix relay. No account or payment is required.</p>
      </div>
      <div className="turnstile-widget" ref={containerRef} />
      {error && <div className="turnstile-error" role="alert">{error}</div>}
      {error && <button type="button" onClick={() => { onError(""); setAttempt((value) => value + 1); }}>Retry verification</button>}
      <small>Turnstile receives browser and network security signals, not your favourites, searches, Web Library, or channel list.</small>
    </section>
  );
}
