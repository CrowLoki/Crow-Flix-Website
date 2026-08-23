import { canonicalCountryCode } from "./broadcastArea";

export type AudienceChannel = {
  country?: string | null;
  languages: readonly string[];
};

export type HomeChannel = {
  categories: readonly string[];
};

export const DEFAULT_AUDIENCE_COUNTRIES = ["AU", "US"] as const;

export function isEnglishLanguage(language: string): boolean {
  return /^(?:english|en|eng)$/i.test(language.trim());
}

export function isEnglishChannel(channel: AudienceChannel): boolean {
  return channel.languages.some(isEnglishLanguage);
}

export function audiencePreferenceScore(channel: AudienceChannel): number {
  const country = canonicalCountryCode(channel.country || "");
  const english = isEnglishChannel(channel);
  if (country === "AU" && english) return 4;
  if (country === "US" && english) return 3;
  if (english) return 2;
  if (country === "AU" || country === "US") return 1;
  return 0;
}

/**
 * JavaScript sorting is stable, so callers can first rank by source health and
 * then use this preference layer without losing the health order within each
 * audience group.
 */
export function prioritizeEnglishAustraliaUnitedStates<T extends AudienceChannel>(
  channels: readonly T[],
): T[] {
  return [...channels].sort((left, right) =>
    audiencePreferenceScore(right) - audiencePreferenceScore(left));
}

export function preferredAudienceCountryOrder(left: string, right: string): number {
  const rank = (value: string) => {
    const country = canonicalCountryCode(value);
    if (country === "AU") return 0;
    if (country === "US") return 1;
    return 2;
  };
  return rank(left) - rank(right) || left.localeCompare(right);
}

const HOME_ENTERTAINMENT_CATEGORIES = new Set([
  "animation",
  "classic",
  "comedy",
  "culture",
  "documentary",
  "entertainment",
  "family",
  "kids",
  "movies",
  "music",
  "science",
  "series",
]);

export function isHomeEntertainmentChannel(channel: HomeChannel): boolean {
  return channel.categories.some((category) =>
    HOME_ENTERTAINMENT_CATEGORIES.has(category.toLocaleLowerCase()));
}
