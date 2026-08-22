import type {
  PlaybackFailurePhase,
  PlaybackFailureReason,
  StreamSource,
} from "./types";

export type FailureDetails = {
  reason: PlaybackFailureReason;
  phase: PlaybackFailurePhase;
  httpStatus?: number;
  message: string;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object"
    ? value as UnknownRecord
    : null;
}

function validHttpStatus(value: unknown): number | undefined {
  const status = typeof value === "number" ? value : Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
}

/** Read only known numeric status fields; never surface upstream error text. */
export function extractHttpStatus(value: unknown): number | undefined {
  const root = record(value);
  if (!root) return undefined;
  const direct = validHttpStatus(root.status) ?? validHttpStatus(root.statusCode);
  if (direct) return direct;
  for (const key of ["response", "request", "error", "event"]) {
    const nested = record(root[key]);
    if (!nested) continue;
    const nestedStatus = validHttpStatus(nested.status)
      ?? validHttpStatus(nested.statusCode)
      ?? (key === "response" ? validHttpStatus(nested.code) : undefined);
    if (nestedStatus) return nestedStatus;
  }
  return undefined;
}

function phaseLabel(phase: PlaybackFailurePhase): string {
  switch (phase) {
    case "probe": return "format check";
    case "manifest": return "stream manifest";
    case "media": return "video data";
    case "decode": return "media";
    case "startup": return "playback startup";
    case "stall": return "live stream";
    case "protocol": return "stream protocol";
  }
}

export function networkFailureMessage(
  phase: PlaybackFailurePhase,
  httpStatus?: number,
  delivery?: StreamSource["delivery"],
): string {
  const target = phaseLabel(phase);
  if (httpStatus === 401 || httpStatus === 403) {
    return `The provider refused the ${target} (HTTP ${httpStatus}). It may not allow this connection or region.`;
  }
  if (httpStatus === 404 || httpStatus === 410) {
    return `The provider no longer has this ${target} (HTTP ${httpStatus}).`;
  }
  if (httpStatus === 429) {
    return "The provider is limiting playback requests right now (HTTP 429).";
  }
  if (httpStatus && httpStatus >= 500) {
    return `The provider${delivery === "relay" ? " or relay" : ""} could not deliver the ${target} (HTTP ${httpStatus}).`;
  }
  if (httpStatus) return `The ${target} request failed (HTTP ${httpStatus}).`;
  if (delivery === "relay") return `The ${target} could not be reached through the CrowFlix relay.`;
  return `The browser could not reach the provider’s ${target}.`;
}

function hlsPhase(details: unknown, hasPlayed: boolean): PlaybackFailurePhase {
  const code = typeof details === "string" ? details.toLowerCase() : "";
  if (/manifest|level|playlist|track|steering|assetlist/.test(code)) return "manifest";
  if (/frag|key/.test(code)) return "media";
  if (/buffer|codec|parsing|decrypt|mux|remux/.test(code)) return "decode";
  return hasPlayed ? "media" : "manifest";
}

export function describeHlsFailure(
  data: unknown,
  hasPlayed: boolean,
  source: StreamSource,
): FailureDetails {
  const value = record(data);
  const type = typeof value?.type === "string" ? value.type : "";
  const phase = hlsPhase(value?.details, hasPlayed);
  const httpStatus = extractHttpStatus(data);
  const network = type.toLowerCase().includes("network");
  return network
    ? {
      reason: "network",
      phase,
      httpStatus,
      message: networkFailureMessage(phase, httpStatus, source.delivery),
    }
    : {
      reason: "media",
      phase: "decode",
      httpStatus,
      message: "The provider returned media this browser could not decode.",
    };
}

export function describeDashFailure(
  data: unknown,
  hasPlayed: boolean,
  source: StreamSource,
): FailureDetails {
  const phase: PlaybackFailurePhase = hasPlayed ? "media" : "manifest";
  const httpStatus = extractHttpStatus(data);
  return {
    reason: "network",
    phase,
    httpStatus,
    message: networkFailureMessage(phase, httpStatus, source.delivery),
  };
}

export function describeMediaElementFailure(
  code: number | undefined,
  hasPlayed: boolean,
  source: StreamSource,
): FailureDetails {
  if (code === 2) {
    const phase: PlaybackFailurePhase = hasPlayed ? "media" : "manifest";
    return {
      reason: "network",
      phase,
      message: networkFailureMessage(phase, undefined, source.delivery),
    };
  }
  if (code === 4) {
    return {
      reason: "unsupported",
      phase: "protocol",
      message: "This browser does not support the media format returned by the provider.",
    };
  }
  return {
    reason: "media",
    phase: "decode",
    message: "The provider returned media this browser could not decode.",
  };
}
