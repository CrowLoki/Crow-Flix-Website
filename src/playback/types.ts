export type TransportHint =
  | "hls"
  | "dash"
  | "direct"
  | "progressive"
  | "unknown"
  | "unsupported";

/**
 * The IPTV catalogue currently emits `id`/`transport`.  The alias fields keep
 * imported playlists and older cached catalogue responses forwards-compatible.
 */
export type StreamSource = {
  id?: string;
  sourceId?: string;
  title?: string | null;
  url: string;
  referrer?: string | null;
  userAgent?: string | null;
  quality?: string | null;
  label?: string | null;
  transport?: TransportHint | null;
  transportHint?: TransportHint | null;
  isHttps?: boolean;
  requiresHeaders?: boolean;
  preferenceScore?: number;
  /**
   * Browser delivery route. Catalogue/native sources leave this unset.  Web
   * sources use distinct route IDs so a failed direct request does not poison
   * the relay fallback (or vice versa).
   */
  delivery?: "direct" | "relay";
  /** Provider-facing URL used for resolving relative DASH resources. */
  logicalUrl?: string;
  /** Recent, exact-identity health hint from the optional static index. */
  catalogHealth?: CatalogSourceHealth;
  /** Public catalogue/playlist that contributed this exact source. */
  provenance?: string;
  /** Every catalogue/playlist that contributed the same exact URL/header identity. */
  provenances?: string[];
};

export type CatalogSourceHealthStatus =
  | "online"
  | "offline"
  | "blocked"
  | "timeout"
  | "error";

export type CatalogSourceHealth = {
  status: CatalogSourceHealthStatus;
  score: number;
  checkedAt: number;
};

export type PlaybackKind =
  | "hls"
  | "dash"
  | "progressive"
  | "unknown"
  | "unsupported";

export type PlaybackFailureReason =
  | "network"
  | "media"
  | "startup-timeout"
  | "stall-timeout"
  | "unsupported"
  | "autoplay"
  | "aborted";

export type PlaybackFailurePhase =
  | "probe"
  | "manifest"
  | "media"
  | "decode"
  | "startup"
  | "stall"
  | "protocol";

export type SourceHealth = {
  failures: number;
  cooldownUntil: number;
  lastSuccessAt?: number;
};

export type PlaybackStatus =
  | "idle"
  | "loading"
  | "switching"
  | "playing"
  | "interaction-required"
  | "failed";

export type PlaybackDiagnostic = {
  sourceId: string;
  sourceNumber: number;
  transport: PlaybackKind;
  endpoint: string;
  reason: PlaybackFailureReason;
  phase: PlaybackFailurePhase;
  httpStatus?: number;
  delivery?: "direct" | "relay";
  at: string;
};

export function sourceIdentifier(source: StreamSource, _index = 0): string {
  if (source.sourceId || source.id) return source.sourceId || source.id || "";
  const identity = `${source.url}\u0000${source.referrer || ""}\u0000${source.userAgent || ""}`;
  let hash = 0x811c9dc5;
  for (let character = 0; character < identity.length; character += 1) {
    hash ^= identity.charCodeAt(character);
    hash = Math.imul(hash, 0x01000193);
  }
  return `source-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function sourceTransportHint(source: StreamSource): TransportHint {
  return source.transportHint || source.transport || "unknown";
}
