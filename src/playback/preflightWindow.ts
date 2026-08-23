export const LIVE_PAGE_PREFLIGHT_CHANNEL_LIMIT = 48;
export const OTHER_VIEW_PREFLIGHT_CHANNEL_LIMIT = 12;
export const LIVE_CARD_PREFLIGHT_SOURCE_LIMIT = 2;
export const OTHER_CARD_PREFLIGHT_SOURCE_LIMIT = 3;
export const PLAYING_CHANNEL_PREFLIGHT_SOURCE_LIMIT = 12;

/** Prefer the page the viewer can see, deduplicate, and keep the request window bounded. */
export function boundedPreflightKeys(
  visibleKeys: readonly string[],
  fallbackKeys: readonly string[],
  limit: number,
): string[] {
  const preferred = visibleKeys.length ? visibleKeys : fallbackKeys;
  return [...new Set(preferred.filter(Boolean))].slice(0, Math.max(0, limit));
}

export function preflightSourceLimit(
  isPlayingChannel: boolean,
  isLiveView: boolean,
): number {
  if (isPlayingChannel) return PLAYING_CHANNEL_PREFLIGHT_SOURCE_LIMIT;
  return isLiveView
    ? LIVE_CARD_PREFLIGHT_SOURCE_LIMIT
    : OTHER_CARD_PREFLIGHT_SOURCE_LIMIT;
}

/** Check one channel's routes sequentially and stop immediately at readiness. */
export async function findReadyRoute<T>(
  routes: readonly T[],
  cachedStatus: (route: T) => "ready" | "offline" | null,
  check: (route: T) => Promise<"ready" | "offline">,
  signal?: AbortSignal,
): Promise<T | undefined> {
  for (const route of routes) {
    if (signal?.aborted) return undefined;
    const cached = cachedStatus(route);
    if (cached === "ready") return route;
    if (cached === "offline") continue;
    if (await check(route) === "ready") return route;
  }
  return undefined;
}
