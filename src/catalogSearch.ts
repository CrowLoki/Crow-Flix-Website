export type CatalogSearchChannel = {
  name: string;
  id?: string;
  altNames?: readonly string[];
  epgAliases?: readonly string[];
  categories?: readonly string[];
  languages?: readonly string[];
  country?: string | null;
  countryName?: string;
  owners?: readonly string[];
  network?: string | null;
  feed?: string | null;
  provenance?: readonly string[];
  timezones?: readonly string[];
  broadcastArea?: readonly string[];
  sources?: readonly { provenance?: string; provenances?: readonly string[] }[];
};

export function normalizeCatalogSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en")
    .replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function channelSearchText(channel: CatalogSearchChannel): string {
  return normalizeCatalogSearch([
    channel.name, channel.id, ...(channel.altNames || []), ...(channel.epgAliases || []),
    ...(channel.categories || []), ...(channel.languages || []), channel.country, channel.countryName,
    ...(channel.owners || []), channel.network, channel.feed, ...(channel.provenance || []),
    ...(channel.timezones || []), ...(channel.broadcastArea || []),
    ...(channel.sources || []).flatMap((source) => [source.provenance, ...(source.provenances || [])]),
  ].filter(Boolean).join(" "));
}

/** Search only display metadata, never media URLs, request headers or tokens. */
export function matchesChannelSearch(channel: CatalogSearchChannel, query: string): boolean {
  const terms = normalizeCatalogSearch(query).split(" ").filter(Boolean);
  if (!terms.length) return true;
  const text = channelSearchText(channel);
  return terms.every((term) => text.includes(term));
}

/** Build once per catalogue snapshot; results retain its channel objects and order. */
export function createChannelSearchIndex<T extends CatalogSearchChannel>(channels: readonly T[]): (query: string) => T[] {
  const entries = channels.map((channel) => ({ channel, text: channelSearchText(channel) }));
  return (query) => {
    const terms = normalizeCatalogSearch(query).split(" ").filter(Boolean);
    return entries.filter(({ text }) => terms.every((term) => text.includes(term)))
      .map(({ channel }) => channel);
  };
}
