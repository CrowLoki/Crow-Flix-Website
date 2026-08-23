import type { StreamSource } from "./playback/types";
import { MAIN_FEED_OPTION_ID } from "./webCatalog";

export type CatalogMetadataChannel = {
  feed?: string | null;
  owners?: string[];
  network?: string | null;
  provenance?: string[];
  sources?: StreamSource[];
};

export type CatalogMetadataFilters = {
  owner: string;
  network: string;
  feed: string;
  provider: string;
};

export function channelProviders(channel: CatalogMetadataChannel): string[] {
  return [...new Set([
    ...(channel.provenance || []),
    ...(channel.sources || []).flatMap(sourceProvenances),
  ])];
}

export function sourceProvenances(source: Pick<StreamSource, "provenance" | "provenances">): string[] {
  return [...new Set([
    ...(source.provenances || []),
    ...(source.provenance ? [source.provenance] : []),
  ])];
}

/** Display only a source hostname, never its path, query values, or headers. */
export function sourceHostname(source: Pick<StreamSource, "url" | "logicalUrl">): string {
  try { return new URL(source.logicalUrl || source.url).hostname.replace(/^www\./i, ""); }
  catch { return "Unknown host"; }
}

export function sourceProtocol(source: Pick<StreamSource, "url" | "logicalUrl">): string {
  try { return new URL(source.logicalUrl || source.url).protocol.replace(/:$/, "").toUpperCase(); }
  catch { return "UNKNOWN"; }
}

/** Exact first-class metadata filters. "all" never changes membership. */
export function channelMatchesMetadataFilters(
  channel: CatalogMetadataChannel,
  filters: CatalogMetadataFilters,
): boolean {
  if (filters.owner !== "all" && !(channel.owners || []).includes(filters.owner)) return false;
  if (filters.network !== "all" && channel.network !== filters.network) return false;
  if (filters.feed !== "all") {
    const channelFeed = channel.feed || MAIN_FEED_OPTION_ID;
    if (channelFeed !== filters.feed) return false;
  }
  if (filters.provider !== "all" && !channelProviders(channel).includes(filters.provider)) return false;
  return true;
}
