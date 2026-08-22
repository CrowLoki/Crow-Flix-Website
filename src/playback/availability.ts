import { type SourceHealth, type StreamSource, sourceIdentifier } from "./types";
import {
  isFreshPreflight,
  type SourcePreflight,
} from "./preflight";
import { isFreshCatalogHealth } from "../streamHealthIndex";

export const VERIFIED_AVAILABILITY_TTL_MS = 12 * 60 * 60 * 1000;

export type ChannelAvailability =
  | "verified"
  | "ready"
  | "unverified"
  | "part-time"
  | "region-limited"
  | "temporarily-offline";

export type AvailabilitySummary = Record<ChannelAvailability, number>;

type ChannelLike = { sources: StreamSource[] };

function isRegionLimited(source: StreamSource): boolean {
  const label = source.label?.trim() || "";
  const negated = /\b(?:non|not)[\s-]+geo[\s-]*blocked\b/i.test(label);
  return !negated && /\bgeo[\s-]*blocked\b/i.test(label);
}

function isPartTime(source: StreamSource): boolean {
  return /\bnot\s+(?:24\s*(?:\/|x|×)\s*7|always\s+on)\b/i
    .test(source.label?.trim() || "");
}

function sourceHealthStates(
  source: StreamSource,
  health: Record<string, SourceHealth>,
): SourceHealth[] {
  const base = sourceIdentifier(source);
  const states = [
    health[base],
    health[`${base}:direct`],
    health[`${base}:relay`],
    health[`${base}:https-upgrade`],
  ].filter((state): state is SourceHealth => Boolean(state));
  return states;
}

function expectedBrowserRouteKeys(source: StreamSource): string[] {
  const base = sourceIdentifier(source);
  if (source.delivery) return [base];
  const needsHeaders = Boolean(
    source.requiresHeaders || source.referrer || source.userAgent,
  );
  if (needsHeaders) return [`${base}:relay`];
  return source.url.toLowerCase().startsWith("http://")
    ? [`${base}:relay`, `${base}:https-upgrade`]
    : [`${base}:direct`, `${base}:relay`];
}

function catalogSaysOffline(source: StreamSource, now: number): boolean {
  const health = source.catalogHealth;
  return isFreshCatalogHealth(health, now)
    && (health.status === "offline" || health.status === "timeout" || health.status === "error");
}

export function channelAvailability(
  channel: ChannelLike,
  health: Record<string, SourceHealth> = {},
  now = Date.now(),
  preflights: Record<string, SourcePreflight> = {},
): ChannelAvailability {
  if (channel.sources.some((source) => {
    return sourceHealthStates(source, health).some((state) => {
      const success = state.lastSuccessAt || 0;
      return success > 0 && now - success <= VERIFIED_AVAILABILITY_TTL_MS;
    });
  })) {
    return "verified";
  }

  if (channel.sources.some((source) => {
    return expectedBrowserRouteKeys(source).some((key) => {
      const result = preflights[key];
      return isFreshPreflight(result, now) && result.status === "ready";
    });
  })) {
    return "ready";
  }

  if (
    channel.sources.length > 0
    && channel.sources.every((source) => isRegionLimited(source))
  ) {
    return "region-limited";
  }

  if (
    channel.sources.length > 0
    && channel.sources.every((source) => isPartTime(source))
  ) {
    return "part-time";
  }

  if (
    channel.sources.length > 0
    && channel.sources.every((source) => {
      if (catalogSaysOffline(source, now)) return true;
      return expectedBrowserRouteKeys(source).every((key) => {
        const preflight = preflights[key];
        if (isFreshPreflight(preflight, now)) {
          return preflight.status === "offline";
        }
        const state = health[key];
        return Boolean(state?.failures && (state.cooldownUntil || 0) > now);
      });
    })
  ) {
    return "temporarily-offline";
  }

  return "unverified";
}

export function availabilityRank(value: ChannelAvailability): number {
  switch (value) {
    case "verified": return 0;
    case "ready": return 1;
    case "unverified": return 2;
    case "part-time": return 3;
    case "region-limited": return 4;
    case "temporarily-offline": return 5;
  }
}

export function channelReliabilityScore(
  channel: ChannelLike,
  health: Record<string, SourceHealth> = {},
  now = Date.now(),
  preflights: Record<string, SourcePreflight> = {},
): number {
  const availability = channelAvailability(channel, health, now, preflights);
  const availabilityScore = (5 - availabilityRank(availability)) * 10_000;
  const normalSources = channel.sources.filter(
    (source) => !isRegionLimited(source) && !isPartTime(source),
  ).length;
  const httpsSources = channel.sources.filter(
    (source) => source.url.toLowerCase().startsWith("https://"),
  ).length;
  const catalogHealthScore = channel.sources.reduce((maximum, source) => {
    const health = source.catalogHealth;
    return isFreshCatalogHealth(health, now) && health.status === "online"
      ? Math.max(maximum, Math.round(health.score * 90))
      : maximum;
  }, 0);
  return availabilityScore
    + catalogHealthScore
    + Math.min(channel.sources.length, 10) * 100
    + normalSources * 25
    + httpsSources * 5;
}

export function rankChannelsByAvailability<T extends ChannelLike & { name: string }>(
  channels: T[],
  health: Record<string, SourceHealth> = {},
  now = Date.now(),
  preflights: Record<string, SourcePreflight> = {},
): T[] {
  return [...channels].sort((left, right) =>
    channelReliabilityScore(right, health, now, preflights)
    - channelReliabilityScore(left, health, now, preflights)
    || left.name.localeCompare(right.name));
}

export function summarizeAvailability(
  channels: ChannelLike[],
  health: Record<string, SourceHealth> = {},
  now = Date.now(),
  preflights: Record<string, SourcePreflight> = {},
): AvailabilitySummary {
  const summary: AvailabilitySummary = {
    verified: 0,
    ready: 0,
    unverified: 0,
    "part-time": 0,
    "region-limited": 0,
    "temporarily-offline": 0,
  };
  for (const channel of channels) {
    summary[channelAvailability(channel, health, now, preflights)] += 1;
  }
  return summary;
}

export function availabilityLabel(value: ChannelAvailability): string {
  switch (value) {
    case "verified": return "LIVE";
    case "ready": return "READY";
    case "unverified": return "CHECK";
    case "part-time": return "PART-TIME";
    case "region-limited": return "REGION";
    case "temporarily-offline": return "OFFLINE";
  }
}
