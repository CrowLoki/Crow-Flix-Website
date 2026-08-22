import { type SourceHealth, type StreamSource, sourceIdentifier } from "./types";

export const VERIFIED_AVAILABILITY_TTL_MS = 12 * 60 * 60 * 1000;

export type ChannelAvailability =
  | "verified"
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

export function channelAvailability(
  channel: ChannelLike,
  health: Record<string, SourceHealth> = {},
  now = Date.now(),
): ChannelAvailability {
  if (channel.sources.some((source) => {
    return sourceHealthStates(source, health).some((state) => {
      const success = state.lastSuccessAt || 0;
      return success > 0 && now - success <= VERIFIED_AVAILABILITY_TTL_MS;
    });
  })) {
    return "verified";
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
      return expectedBrowserRouteKeys(source).every((key) => {
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
    case "unverified": return 1;
    case "part-time": return 2;
    case "region-limited": return 3;
    case "temporarily-offline": return 4;
  }
}

export function channelReliabilityScore(
  channel: ChannelLike,
  health: Record<string, SourceHealth> = {},
  now = Date.now(),
): number {
  const availability = channelAvailability(channel, health, now);
  const availabilityScore = (4 - availabilityRank(availability)) * 10_000;
  const normalSources = channel.sources.filter(
    (source) => !isRegionLimited(source) && !isPartTime(source),
  ).length;
  const httpsSources = channel.sources.filter(
    (source) => source.url.toLowerCase().startsWith("https://"),
  ).length;
  return availabilityScore
    + Math.min(channel.sources.length, 10) * 100
    + normalSources * 25
    + httpsSources * 5;
}

export function rankChannelsByAvailability<T extends ChannelLike & { name: string }>(
  channels: T[],
  health: Record<string, SourceHealth> = {},
  now = Date.now(),
): T[] {
  return [...channels].sort((left, right) =>
    channelReliabilityScore(right, health, now)
    - channelReliabilityScore(left, health, now)
    || left.name.localeCompare(right.name));
}

export function summarizeAvailability(
  channels: ChannelLike[],
  health: Record<string, SourceHealth> = {},
  now = Date.now(),
): AvailabilitySummary {
  const summary: AvailabilitySummary = {
    verified: 0,
    unverified: 0,
    "part-time": 0,
    "region-limited": 0,
    "temporarily-offline": 0,
  };
  for (const channel of channels) {
    summary[channelAvailability(channel, health, now)] += 1;
  }
  return summary;
}

export function availabilityLabel(value: ChannelAvailability): string {
  switch (value) {
    case "verified": return "LIVE";
    case "unverified": return "CHECK";
    case "part-time": return "PART-TIME";
    case "region-limited": return "REGION";
    case "temporarily-offline": return "OFFLINE";
  }
}
