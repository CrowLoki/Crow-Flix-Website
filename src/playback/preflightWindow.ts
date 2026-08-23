export const LIVE_PAGE_PREFLIGHT_CHANNEL_LIMIT = 48;
export const OTHER_VIEW_PREFLIGHT_CHANNEL_LIMIT = 12;
export const LIVE_CARD_PREFLIGHT_ROUTE_LIMIT = 1;
export const OTHER_CARD_PREFLIGHT_ROUTE_LIMIT = 3;
export const PLAYING_CHANNEL_PREFLIGHT_ROUTE_LIMIT = 12;

/** Prefer the page the viewer can see, deduplicate, and keep the request window bounded. */
export function boundedPreflightKeys(
  visibleKeys: readonly string[],
  fallbackKeys: readonly string[],
  limit: number,
): string[] {
  const preferred = visibleKeys.length ? visibleKeys : fallbackKeys;
  return [...new Set(preferred.filter(Boolean))].slice(0, Math.max(0, limit));
}

export function preflightRouteLimit(
  isPlayingChannel: boolean,
  isLiveView: boolean,
): number {
  if (isPlayingChannel) return PLAYING_CHANNEL_PREFLIGHT_ROUTE_LIMIT;
  return isLiveView
    ? LIVE_CARD_PREFLIGHT_ROUTE_LIMIT
    : OTHER_CARD_PREFLIGHT_ROUTE_LIMIT;
}
