import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type Hls from "hls.js";
import type { MediaInfo, MediaPlayerClass, Representation } from "dashjs";
import { createTauriHlsLoader } from "./TauriHlsLoader";
import { installNativeDashTransport } from "./dashTransport";
import {
  describeDashFailure,
  describeHlsFailure,
  describeMediaElementFailure,
  extractHttpStatus,
  networkFailureMessage,
  type FailureDetails,
} from "./failureDetails";
import {
  classifySource,
  orderPlaybackSources,
  sanitizeStreamUrl,
  shouldFallback,
} from "./logic";
import { probeSource } from "./nativeFetch";
import { orderSourcesByPreflight, readSourcePreflights } from "./preflight";
import {
  type PlaybackDiagnostic,
  type PlaybackFailureReason,
  type PlaybackKind,
  type PlaybackStatus,
  type SourceHealth,
  type StreamSource,
  sourceIdentifier,
} from "./types";
import { ProgressWatchdog } from "./stallWatchdog";

// Fail a dead manifest promptly, but allow a healthy slow provider enough time
// to deliver and decode its first media segment.
const MANIFEST_FIRST_BYTE_TIMEOUT_MS = 7_000;
const MANIFEST_LOAD_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 35_000;
const STALL_TIMEOUT_MS = 25_000;
const HEALTH_STORAGE_KEY = "crowflix:source-health:v1";
const PREFERRED_STORAGE_KEY = "crowflix:preferred-source:v1";
export const SOURCE_HEALTH_CHANGED_EVENT = "crowflix:source-health-changed";

function isManifestNetworkFailure(details: unknown): boolean {
  return /manifest|level|playlist|track|steering/i.test(String(details ?? ""));
}

function displayLanguage(value?: string | null): string {
  const language = value?.trim();
  if (!language) return "";
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(language) || language;
  } catch {
    return language;
  }
}

function selectableTextTracks(textTracks: TextTrackList): Array<{ track: TextTrack; index: number }> {
  return Array.from(textTracks)
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.kind === "subtitles" || track.kind === "captions");
}

function textTrackIdentity(label?: string | null, language?: string | null): string {
  return `${label?.trim().toLocaleLowerCase() || ""}\u0000${language?.trim().toLocaleLowerCase().split("-")[0] || ""}`;
}

function bitrateLabel(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return "";
  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(bitsPerSecond >= 10_000_000 ? 0 : 1)} Mbps`
    : `${Math.round(bitsPerSecond / 1_000)} kbps`;
}

function qualityLabel(height: number, name: string | undefined, bitrate: number): string {
  if (height > 0) return `${height}p`;
  if (name?.trim()) return name.trim();
  return bitrateLabel(bitrate) || "Stream quality";
}

function qualityDetail(width: number, height: number, bitrate: number): string | undefined {
  return [
    width > 0 && height > 0 ? `${width}×${height}` : "",
    bitrateLabel(bitrate),
  ].filter(Boolean).join(" · ") || undefined;
}

function dashQualityOption(representation: Representation, selected: string) {
  const id = `dash-quality-${representation.id}`;
  return {
    id,
    label: qualityLabel(representation.height, "", representation.bandwidth),
    detail: qualityDetail(representation.width, representation.height, representation.bandwidth),
    active: selected === id,
    sort: representation.height || representation.bandwidth,
  };
}

function sameDashTrack(left: MediaInfo, right: MediaInfo | null): boolean {
  if (!right) return false;
  if (left.id !== null && right.id !== null) return left.id === right.id;
  return left.index === right.index && left.lang === right.lang && left.type === right.type;
}

function dashTrackOption(
  track: MediaInfo,
  id: string,
  active: boolean,
  fallback: string,
): PlaybackMediaOption {
  const language = displayLanguage(track.lang);
  const label = track.labels.find((item) => item.lang === track.lang)?.text
    || track.labels[0]?.text
    || language
    || `${fallback} ${track.index === null ? "" : track.index + 1}`.trim();
  return {
    id,
    label,
    detail: [language, track.codec || ""].filter(Boolean).join(" · ") || undefined,
    active,
  };
}

export type PlaybackChannel = {
  key: string;
  name: string;
  sources: StreamSource[];
};

export type PlaybackControllerState = {
  status: PlaybackStatus;
  message: string;
  source: StreamSource | null;
  sourceNumber: number;
  sourceTotal: number;
  canNext: boolean;
  sourceOptions: PlaybackSourceOption[];
  subtitleOptions: PlaybackMediaOption[];
  qualityOptions: PlaybackMediaOption[];
  audioOptions: PlaybackMediaOption[];
  diagnostics: PlaybackDiagnostic[];
};

export type PlaybackSourceOption = {
  index: number;
  sourceId: string;
  label: string;
  detail: string;
  active: boolean;
};

export type PlaybackMediaOption = {
  id: string;
  label: string;
  detail?: string;
  active: boolean;
};

export type PlaybackController = PlaybackControllerState & {
  retry: () => void;
  next: () => void;
  selectSource: (index: number) => void;
  selectSubtitle: (id: string) => void;
  selectQuality: (id: string) => void;
  selectAudio: (id: string) => void;
  resume: () => void;
};

const IDLE_STATE: PlaybackControllerState = {
  status: "idle",
  message: "",
  source: null,
  sourceNumber: 0,
  sourceTotal: 0,
  canNext: false,
  sourceOptions: [],
  subtitleOptions: [{ id: "off", label: "Off", active: true }],
  qualityOptions: [{ id: "auto", label: "Auto", detail: "Source default", active: true }],
  audioOptions: [{ id: "default", label: "Default audio", active: true }],
  diagnostics: [],
};

export function usePlaybackController(
  channel: PlaybackChannel | null,
  videoRef: RefObject<HTMLVideoElement | null>,
): PlaybackController {
  const [state, setState] = useState<PlaybackControllerState>(IDLE_STATE);
  const runRef = useRef<PlaybackRun | null>(null);

  useEffect(() => {
    runRef.current?.dispose();
    runRef.current = null;
    const video = videoRef.current;
    if (!channel || !video) {
      setState(IDLE_STATE);
      return;
    }
    const run = new PlaybackRun(channel, video, setState);
    runRef.current = run;
    run.start();
    return () => {
      run.dispose();
      if (runRef.current === run) runRef.current = null;
    };
  }, [channel, videoRef]);

  return {
    ...state,
    retry: useCallback(() => runRef.current?.retry(), []),
    next: useCallback(() => runRef.current?.next(), []),
    selectSource: useCallback((index: number) => runRef.current?.select(index), []),
    selectSubtitle: useCallback((id: string) => runRef.current?.selectSubtitle(id), []),
    selectQuality: useCallback((id: string) => runRef.current?.selectQuality(id), []),
    selectAudio: useCallback((id: string) => runRef.current?.selectAudio(id), []),
    resume: useCallback(() => runRef.current?.resume(), []),
  };
}

export class PlaybackRun {
  private orderedSources: StreamSource[] = [];
  private health: Record<string, SourceHealth> = {};
  private cursor = 0;
  private generation = 0;
  private disposed = false;
  private attemptCleanup: (() => void) | null = null;
  private diagnostics: PlaybackDiagnostic[] = [];
  private subtitleOptions: PlaybackMediaOption[] = IDLE_STATE.subtitleOptions;
  private qualityOptions: PlaybackMediaOption[] = IDLE_STATE.qualityOptions;
  private audioOptions: PlaybackMediaOption[] = IDLE_STATE.audioOptions;
  private selectSubtitleImpl: ((id: string) => void) | null = null;
  private selectQualityImpl: ((id: string) => void) | null = null;
  private selectAudioImpl: ((id: string) => void) | null = null;
  private lastStatus: PlaybackStatus = "idle";
  private lastMessage = "";

  constructor(
    private readonly channel: PlaybackChannel,
    private readonly video: HTMLVideoElement,
    private readonly update: (state: PlaybackControllerState) => void,
  ) {
    this.health = readPlaybackHealth();
    this.refreshSourceOrder();
  }

  start(): void {
    if (!this.orderedSources.length) {
      this.update({
        ...IDLE_STATE,
        status: "failed",
        message: "This preview card has no live source. Open CrowFlix on the desktop to load the live catalogue.",
      });
      return;
    }
    this.startAttempt(0, "loading");
  }

  retry(): void {
    if (this.disposed) return;
    this.health = readPlaybackHealth();
    this.refreshSourceOrder();
    if (!this.orderedSources.length) return;
    this.startAttempt(0, "loading");
  }

  next(): void {
    if (this.disposed) return;
    this.reorderRemainingSources();
    if (this.cursor + 1 >= this.orderedSources.length) return;
    this.startAttempt(this.cursor + 1, "switching");
  }

  select(index: number): void {
    if (
      this.disposed
      || !Number.isInteger(index)
      || index < 0
      || index >= this.orderedSources.length
      || index === this.cursor
    ) return;
    this.startAttempt(index, "switching");
  }

  selectSubtitle(id: string): void {
    if (!this.disposed) this.selectSubtitleImpl?.(id);
  }

  selectQuality(id: string): void {
    if (!this.disposed) this.selectQualityImpl?.(id);
  }

  selectAudio(id: string): void {
    if (!this.disposed) this.selectAudioImpl?.(id);
  }

  resume(): void {
    if (this.disposed) return;
    void this.video.play().then(() => {
      if (this.disposed) return;
      this.publish("playing", "Playing live");
    }).catch(() => {
      if (this.disposed) return;
      this.publish("interaction-required", "Press play to start this channel.");
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.attemptCleanup?.();
    this.attemptCleanup = null;
  }

  private startAttempt(index: number, status: "loading" | "switching"): void {
    if (this.disposed) return;
    this.generation += 1;
    this.attemptCleanup?.();
    this.attemptCleanup = null;
    this.cursor = index;
    this.resetMediaOptions(this.orderedSources[index]);
    const token = this.generation;
    const source = this.orderedSources[index];
    this.publish(
      status,
      status === "switching"
        ? `Trying playback route ${index + 1} of ${this.orderedSources.length}…`
        : `Connecting through route ${index + 1} of ${this.orderedSources.length}…`,
    );
    void this.prepareAndPlay(source, token);
  }

  private async prepareAndPlay(source: StreamSource, token: number): Promise<void> {
    let selected = source;
    let kind = classifySource(selected);
    const probeController = new AbortController();
    this.attemptCleanup = () => {
      probeController.abort();
      this.resetVideo();
    };

    if (kind === "unknown") {
      try {
        const probed = await probeSource(selected, undefined, probeController.signal);
        if (!this.isActive(token)) return;
        selected = {
          ...selected,
          url: probed.url,
          logicalUrl: selected.delivery === "relay"
            ? selected.logicalUrl
            : probed.url,
        };
        kind = probed.kind === "unknown" ? "progressive" : probed.kind;
      } catch (error) {
        const httpStatus = extractHttpStatus(error);
        this.fail(
          token,
          selected,
          kind,
          "network",
          networkFailureMessage("probe", httpStatus, selected.delivery),
          { phase: "probe", httpStatus },
        );
        return;
      }
    }
    if (!this.isActive(token)) return;
    if (kind === "unsupported") {
      this.fail(
        token,
        selected,
        kind,
        "unsupported",
        "This source uses a streaming protocol that CrowFlix cannot play.",
        { phase: "protocol" },
      );
      return;
    }
    this.installPlayer(selected, kind, token);
  }

  private installPlayer(source: StreamSource, kind: PlaybackKind, token: number): void {
    const cleanupTasks: Array<() => void> = [];
    let cleaned = false;
    let startupMilestone = "the provider connection";
    this.attemptCleanup = () => {
      if (cleaned) return;
      cleaned = true;
      cleanupTasks.reverse().forEach((cleanup) => {
        try { cleanup(); } catch { /* best-effort library cleanup */ }
      });
      this.resetVideo();
    };
    const startupTimer = setTimeout(
      () => this.fail(
        token,
        source,
        kind,
        "startup-timeout",
        `The source reached ${startupMilestone}, but playable media did not arrive within 35 seconds.`,
        { phase: "startup" },
      ),
      STARTUP_TIMEOUT_MS,
    );
    cleanupTasks.push(() => clearTimeout(startupTimer));

    let hasPlayed = false;
    let deliberatelyPaused = false;
    let lastTime = -1;
    let mediaRecoveryUsed = false;
    let networkRecoveryUsed = false;
    let hls: Hls | null = null;
    let dashPlayer: MediaPlayerClass | null = null;

    const stallWatchdog = new ProgressWatchdog(
      STALL_TIMEOUT_MS,
      () => this.fail(
        token,
        source,
        kind,
        "stall-timeout",
        "The live stream stopped delivering playable media for 25 seconds.",
        { phase: "stall" },
      ),
    );
    const attemptPlay = () => {
      if (!this.isActive(token)) return;
      void this.video.play().catch((error: unknown) => {
        if (!this.isActive(token)) return;
        const errorName = error && typeof error === "object" && "name" in error
          ? String(error.name)
          : "";
        if (errorName === "NotAllowedError") {
          clearTimeout(startupTimer);
          this.publish("interaction-required", "Press play to start this channel.");
        }
      });
    };
    const onPlaying = () => {
      if (!this.isActive(token)) return;
      if (!hasPlayed || deliberatelyPaused) stallWatchdog.start();
      else stallWatchdog.ensure();
      hasPlayed = true;
      deliberatelyPaused = false;
      clearTimeout(startupTimer);
      recordSourceSuccess(this.channel.key, source, this.health);
      this.publish("playing", "Playing live");
    };
    const onTimeUpdate = () => {
      if (!this.isActive(token)) return;
      if (Math.abs(this.video.currentTime - lastTime) > 0.2) {
        lastTime = this.video.currentTime;
        stallWatchdog.progress();
      }
    };
    const onPause = () => {
      if (!this.isActive(token) || this.video.ended) return;
      deliberatelyPaused = true;
      stallWatchdog.stop();
    };
    const onMediaError = () => {
      if (!this.isActive(token)) return;
      if (kind === "hls" && hls && !mediaRecoveryUsed) {
        mediaRecoveryUsed = true;
        this.publish("loading", "Recovering this source…");
        hls.recoverMediaError();
        return;
      }
      const failure = describeMediaElementFailure(
        this.video.error?.code,
        hasPlayed,
        source,
      );
      this.fail(
        token,
        source,
        kind,
        failure.reason,
        failure.message,
        failure,
      );
    };
    const addVideoListener = <K extends keyof HTMLMediaElementEventMap>(
      event: K,
      listener: (event: HTMLMediaElementEventMap[K]) => void,
    ) => {
      this.video.addEventListener(event, listener);
      cleanupTasks.push(() => this.video.removeEventListener(event, listener));
    };
    addVideoListener("playing", onPlaying);
    addVideoListener("timeupdate", onTimeUpdate);
    addVideoListener("waiting", () => stallWatchdog.ensure());
    addVideoListener("stalled", () => stallWatchdog.ensure());
    addVideoListener("pause", onPause);
    addVideoListener("canplay", attemptPlay);
    addVideoListener("error", onMediaError);
    addVideoListener("ended", onMediaError);
    cleanupTasks.push(() => stallWatchdog.stop());

    const installNativeTextControls = () => {
      const textTracks = this.video.textTracks;
      if (!textTracks) return;
      const refresh = () => {
        if (!this.isActive(token)) return;
        const tracks = selectableTextTracks(textTracks);
        this.subtitleOptions = [
          {
            id: "off",
            label: "Off",
            active: !tracks.some(({ track }) => track.mode === "showing"),
          },
          ...tracks.map(({ track, index }) => ({
            id: `native-subtitle-${index}`,
            label: track.label || displayLanguage(track.language) || `Subtitles ${index + 1}`,
            detail: displayLanguage(track.language) || undefined,
            active: track.mode === "showing",
          })),
        ];
        this.publishCurrent();
      };
      this.selectSubtitleImpl = (id) => {
        const selected = id === "off" ? -1 : Number(id.replace("native-subtitle-", ""));
        selectableTextTracks(textTracks).forEach(({ track, index }) => {
          track.mode = index === selected ? "showing" : "disabled";
        });
        refresh();
      };
      textTracks.addEventListener?.("addtrack", refresh);
      textTracks.addEventListener?.("removetrack", refresh);
      textTracks.addEventListener?.("change", refresh);
      cleanupTasks.push(() => {
        textTracks.removeEventListener?.("addtrack", refresh);
        textTracks.removeEventListener?.("removetrack", refresh);
        textTracks.removeEventListener?.("change", refresh);
      });
      refresh();
    };

    if (kind === "hls") {
      const useNativeHls = () => {
        if (
          sourceNeedsHeaders(source)
          || !this.video.canPlayType("application/vnd.apple.mpegurl")
        ) return false;
        installNativeTextControls();
        this.video.src = source.url;
        this.video.load();
        return true;
      };
      void import("hls.js").then(({ default: HlsRuntime }) => {
        if (!this.isActive(token)) return;
        if (!HlsRuntime.isSupported()) {
          if (!useNativeHls()) {
            this.fail(
              token,
              source,
              kind,
              "unsupported",
              "This HLS source needs playback support that is unavailable on this device.",
              { phase: "protocol" },
            );
          }
          return;
        }
        hls = new HlsRuntime({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 30,
          manifestLoadPolicy: {
            default: {
              maxTimeToFirstByteMs: MANIFEST_FIRST_BYTE_TIMEOUT_MS,
              maxLoadTimeMs: MANIFEST_LOAD_TIMEOUT_MS,
              timeoutRetry: null,
              errorRetry: null,
            },
          },
          playlistLoadPolicy: {
            default: {
              maxTimeToFirstByteMs: MANIFEST_FIRST_BYTE_TIMEOUT_MS,
              maxLoadTimeMs: MANIFEST_LOAD_TIMEOUT_MS,
              timeoutRetry: null,
              errorRetry: null,
            },
          },
          loader: createTauriHlsLoader(source),
        });
        let selectedQuality = "auto";
        const refreshHlsOptions = () => {
          if (!this.isActive(token) || !hls) return;
          const nativeTextTracks = this.video.textTracks
            ? selectableTextTracks(this.video.textTracks)
            : [];
          const nativeTrackIdentities = new Set(nativeTextTracks.map(({ track }) =>
            textTrackIdentity(track.label, track.language)));
          this.qualityOptions = [
            {
              id: "auto",
              label: "Auto",
              detail: "Adapts to your connection",
              active: selectedQuality === "auto",
            },
            ...hls.levels.map((level, index) => ({
              id: `hls-quality-${index}`,
              label: qualityLabel(level.height, level.name, level.bitrate),
              detail: qualityDetail(level.width, level.height, level.bitrate),
              active: selectedQuality === `hls-quality-${index}`,
            })),
          ];
          this.subtitleOptions = [
            {
              id: "off",
              label: "Off",
              active: (!hls.subtitleDisplay || hls.subtitleTrack < 0)
                && !nativeTextTracks.some(({ track }) => track.mode === "showing"),
            },
            ...nativeTextTracks.map(({ track, index }) => ({
              id: `hls-texttrack-${index}`,
              label: track.label || displayLanguage(track.language) || `Captions ${index + 1}`,
              detail: [displayLanguage(track.language), track.kind === "captions" ? "Closed captions" : "Subtitles"].filter(Boolean).join(" · ") || undefined,
              active: track.mode === "showing",
            })),
            ...hls.subtitleTracks.map((track, index) => ({ track, index }))
              .filter(({ track }) => !nativeTrackIdentities.has(textTrackIdentity(track.name, track.lang)))
              .map(({ track, index }) => ({
              id: `hls-subtitle-${index}`,
              label: track.name || displayLanguage(track.lang) || `Subtitles ${index + 1}`,
              detail: displayLanguage(track.lang) || undefined,
              active: hls?.subtitleDisplay === true && hls.subtitleTrack === index,
            })),
          ];
          this.audioOptions = hls.audioTracks.length
            ? hls.audioTracks.map((track, index) => ({
              id: `hls-audio-${index}`,
              label: track.name || displayLanguage(track.lang) || `Audio ${index + 1}`,
              detail: [displayLanguage(track.lang), track.channels].filter(Boolean).join(" · ") || undefined,
              active: hls?.audioTrack === index,
            }))
            : [{ id: "default", label: "Default audio", active: true }];
          this.publishCurrent();
        };
        this.selectQualityImpl = (id) => {
          if (!hls || (id !== "auto" && !/^hls-quality-\d+$/.test(id))) return;
          selectedQuality = id;
          hls.currentLevel = id === "auto" ? -1 : Number(id.replace("hls-quality-", ""));
          refreshHlsOptions();
        };
        this.selectSubtitleImpl = (id) => {
          if (!hls || (id !== "off" && !/^hls-(?:subtitle|texttrack)-\d+$/.test(id))) return;
          const textTracks = this.video.textTracks
            ? selectableTextTracks(this.video.textTracks)
            : [];
          if (id === "off") {
            hls.subtitleDisplay = false;
            hls.subtitleTrack = -1;
            textTracks.forEach(({ track }) => { track.mode = "disabled"; });
          } else if (id.startsWith("hls-texttrack-")) {
            const selected = Number(id.replace("hls-texttrack-", ""));
            textTracks.forEach(({ track, index }) => {
              track.mode = index === selected ? "showing" : "disabled";
            });
            hls.subtitleDisplay = true;
            const selectedTrack = this.video.textTracks[selected];
            const hlsIndex = hls.subtitleTracks.findIndex((track) =>
              textTrackIdentity(track.name, track.lang) === textTrackIdentity(selectedTrack?.label, selectedTrack?.language));
            if (hlsIndex >= 0) hls.subtitleTrack = hlsIndex;
          } else {
            textTracks.forEach(({ track }) => { track.mode = "disabled"; });
            hls.subtitleDisplay = true;
            hls.subtitleTrack = Number(id.replace("hls-subtitle-", ""));
          }
          refreshHlsOptions();
        };
        const textTracks = this.video.textTracks;
        textTracks?.addEventListener?.("addtrack", refreshHlsOptions);
        textTracks?.addEventListener?.("removetrack", refreshHlsOptions);
        textTracks?.addEventListener?.("change", refreshHlsOptions);
        cleanupTasks.push(() => {
          textTracks?.removeEventListener?.("addtrack", refreshHlsOptions);
          textTracks?.removeEventListener?.("removetrack", refreshHlsOptions);
          textTracks?.removeEventListener?.("change", refreshHlsOptions);
        });
        this.selectAudioImpl = (id) => {
          if (!hls || !/^hls-audio-\d+$/.test(id)) return;
          hls.audioTrack = Number(id.replace("hls-audio-", ""));
          refreshHlsOptions();
        };
        hls.on(HlsRuntime.Events.MEDIA_ATTACHED, () => {
          startupMilestone = "the browser media engine";
          if (this.isActive(token)) hls?.loadSource(source.url);
        });
        hls.on(HlsRuntime.Events.MANIFEST_PARSED, () => {
          startupMilestone = "a parsed stream manifest";
          refreshHlsOptions();
          attemptPlay();
        });
        hls.on(HlsRuntime.Events.LEVELS_UPDATED, refreshHlsOptions);
        hls.on(HlsRuntime.Events.LEVEL_SWITCHED, refreshHlsOptions);
        hls.on(HlsRuntime.Events.AUDIO_TRACKS_UPDATED, refreshHlsOptions);
        hls.on(HlsRuntime.Events.AUDIO_TRACK_SWITCHED, refreshHlsOptions);
        hls.on(HlsRuntime.Events.SUBTITLE_TRACKS_UPDATED, refreshHlsOptions);
        hls.on(HlsRuntime.Events.SUBTITLE_TRACK_SWITCH, refreshHlsOptions);
        hls.on(HlsRuntime.Events.FRAG_LOADED, () => {
          startupMilestone = "downloaded media segments";
        });
        hls.on(HlsRuntime.Events.FRAG_DECRYPTED, () => {
          startupMilestone = "decrypted media segments";
        });
        hls.on(HlsRuntime.Events.FRAG_PARSED, () => {
          startupMilestone = "parsed audio/video segments";
        });
        hls.on(HlsRuntime.Events.BUFFER_CODECS, () => {
          startupMilestone = "detected browser codecs";
        });
        hls.on(HlsRuntime.Events.BUFFER_APPENDED, () => {
          startupMilestone = "buffered browser media";
        });
        hls.on(HlsRuntime.Events.ERROR, (_event, data) => {
          if (!this.isActive(token) || !data.fatal) return;
          if (
            data.type === HlsRuntime.ErrorTypes.NETWORK_ERROR
            && !isManifestNetworkFailure(data.details)
            && !networkRecoveryUsed
          ) {
            networkRecoveryUsed = true;
            this.publish("loading", "Retrying this source…");
            hls?.startLoad();
            return;
          }
          if (data.type === HlsRuntime.ErrorTypes.MEDIA_ERROR && !mediaRecoveryUsed) {
            mediaRecoveryUsed = true;
            this.publish("loading", "Recovering this source…");
            hls?.recoverMediaError();
            return;
          }
          const failure = describeHlsFailure(data, hasPlayed, source);
          this.fail(token, source, kind, failure.reason, failure.message, failure);
        });
        hls.attachMedia(this.video);
        cleanupTasks.push(() => {
          hls?.stopLoad();
          hls?.detachMedia();
          hls?.destroy();
          hls = null;
        });
      }).catch(() => {
        if (!this.isActive(token) || useNativeHls()) return;
        this.fail(
          token,
          source,
          kind,
          "unsupported",
          "The HLS player could not be loaded on this browser.",
          { phase: "protocol" },
        );
      });
    } else if (kind === "dash") {
      void import("dashjs").then((dashModule) => {
        if (!this.isActive(token)) return;
        try {
          dashPlayer = dashModule.MediaPlayer().create();
          installNativeDashTransport(dashPlayer, source);
          dashPlayer.setConfig({
            streaming: {
              lowLatencyEnabled: false,
              manifestRequestTimeout: 8_000,
              fragmentRequestTimeout: 35_000,
              retryAttempts: { MPD: 0, MediaSegment: 2, InitializationSegment: 2 },
            },
          });
          let selectedQuality = "auto";
          const refreshDashOptions = () => {
            if (!this.isActive(token) || !dashPlayer) return;
            const representations = dashPlayer.getRepresentationsByType("video");
            const subtitleTracks = dashPlayer.getTracksFor("text");
            const audioTracks = dashPlayer.getTracksFor("audio");
            const currentSubtitle = dashPlayer.getCurrentTrackFor("text");
            const currentAudio = dashPlayer.getCurrentTrackFor("audio");
            this.qualityOptions = [
              {
                id: "auto",
                label: "Auto",
                detail: "Adapts to your connection",
                active: selectedQuality === "auto",
              },
              ...representations
                .map((representation) => dashQualityOption(representation, selectedQuality))
                .sort((left, right) => right.sort - left.sort)
                .map(({ sort: _sort, ...option }) => option),
            ];
            this.subtitleOptions = [
              { id: "off", label: "Off", active: !dashPlayer.isTextEnabled() },
              ...subtitleTracks.map((track, index) => dashTrackOption(
                track,
                `dash-subtitle-${index}`,
                dashPlayer?.isTextEnabled() === true && sameDashTrack(track, currentSubtitle),
                "Subtitles",
              )),
            ];
            this.audioOptions = audioTracks.length
              ? audioTracks.map((track, index) => dashTrackOption(
                track,
                `dash-audio-${index}`,
                sameDashTrack(track, currentAudio),
                "Audio",
              ))
              : [{ id: "default", label: "Default audio", active: true }];
            this.publishCurrent();
          };
          this.selectQualityImpl = (id) => {
            if (!dashPlayer) return;
            if (id === "auto") {
              selectedQuality = "auto";
              dashPlayer.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
            } else if (id.startsWith("dash-quality-")) {
              const representationId = id.slice("dash-quality-".length);
              if (!dashPlayer.getRepresentationsByType("video").some((item) => item.id === representationId)) return;
              selectedQuality = id;
              dashPlayer.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
              dashPlayer.setRepresentationForTypeById("video", representationId, true);
            }
            refreshDashOptions();
          };
          this.selectSubtitleImpl = (id) => {
            if (!dashPlayer) return;
            if (id === "off") {
              dashPlayer.enableText(false);
              dashPlayer.setTextTrack(-1);
            } else if (/^dash-subtitle-\d+$/.test(id)) {
              const index = Number(id.replace("dash-subtitle-", ""));
              const track = dashPlayer.getTracksFor("text")[index];
              if (!track) return;
              dashPlayer.enableText(true);
              dashPlayer.setCurrentTrack(track);
              dashPlayer.setTextTrack(index);
            }
            refreshDashOptions();
          };
          this.selectAudioImpl = (id) => {
            if (!dashPlayer || !/^dash-audio-\d+$/.test(id)) return;
            const track = dashPlayer.getTracksFor("audio")[Number(id.replace("dash-audio-", ""))];
            if (!track) return;
            dashPlayer.setCurrentTrack(track);
            refreshDashOptions();
          };
          const onDashError = (data: unknown) => {
            const failure = describeDashFailure(data, hasPlayed, source);
            this.fail(token, source, kind, failure.reason, failure.message, failure);
          };
          dashPlayer.on(dashModule.MediaPlayer.events.ERROR, onDashError);
          dashPlayer.on(dashModule.MediaPlayer.events.STREAM_INITIALIZED, refreshDashOptions);
          dashPlayer.on(dashModule.MediaPlayer.events.TEXT_TRACKS_ADDED, refreshDashOptions);
          dashPlayer.on(dashModule.MediaPlayer.events.TRACK_CHANGE_RENDERED, refreshDashOptions);
          dashPlayer.on(dashModule.MediaPlayer.events.QUALITY_CHANGE_RENDERED, refreshDashOptions);
          cleanupTasks.push(() => dashPlayer?.off(dashModule.MediaPlayer.events.ERROR, onDashError));
          cleanupTasks.push(() => {
            dashPlayer?.off(dashModule.MediaPlayer.events.STREAM_INITIALIZED, refreshDashOptions);
            dashPlayer?.off(dashModule.MediaPlayer.events.TEXT_TRACKS_ADDED, refreshDashOptions);
            dashPlayer?.off(dashModule.MediaPlayer.events.TRACK_CHANGE_RENDERED, refreshDashOptions);
            dashPlayer?.off(dashModule.MediaPlayer.events.QUALITY_CHANGE_RENDERED, refreshDashOptions);
          });
          cleanupTasks.push(() => {
            dashPlayer?.destroy();
            dashPlayer = null;
          });
          dashPlayer.initialize(this.video, source.logicalUrl || source.url, false);
        } catch {
          this.fail(
            token,
            source,
            kind,
            "unsupported",
            "DASH playback could not be initialized on this browser.",
            { phase: "protocol" },
          );
        }
      }).catch(() => {
        this.fail(
          token,
          source,
          kind,
          "unsupported",
          "The DASH player could not be loaded on this browser.",
          { phase: "protocol" },
        );
      });
    } else {
      if (sourceNeedsHeaders(source)) {
        this.fail(
          token,
          source,
          kind,
          "unsupported",
          "This direct media source requires request headers that the video element cannot attach.",
          { phase: "protocol" },
        );
        return;
      }
      installNativeTextControls();
      this.video.src = source.url;
      this.video.load();
    }

  }

  private fail(
    token: number,
    source: StreamSource,
    kind: PlaybackKind,
    reason: PlaybackFailureReason,
    message: string,
    details: Pick<FailureDetails, "phase" | "httpStatus"> = { phase: "media" },
  ): void {
    if (!this.isActive(token)) return;
    this.generation += 1;
    this.diagnostics = [
      ...this.diagnostics,
      {
        sourceId: sourceIdentifier(source, this.cursor),
        sourceNumber: this.cursor + 1,
        transport: kind,
        endpoint: sanitizeStreamUrl(source.logicalUrl || source.url),
        reason,
        phase: details.phase,
        ...(details.httpStatus ? { httpStatus: details.httpStatus } : {}),
        ...(source.delivery ? { delivery: source.delivery } : {}),
        at: new Date().toISOString(),
      },
    ].slice(-8);
    if (reason !== "aborted" && reason !== "autoplay") {
      recordSourceFailure(source, this.health);
    }
    this.attemptCleanup?.();
    this.attemptCleanup = null;
    this.reorderRemainingSources();

    if (shouldFallback(reason) && this.cursor + 1 < this.orderedSources.length) {
      this.publish("switching", `${message} Trying the next playback route…`);
      queueMicrotask(() => this.startAttempt(this.cursor + 1, "switching"));
      return;
    }
    this.publish("failed", message);
  }

  private publish(status: PlaybackStatus, message: string): void {
    this.lastStatus = status;
    this.lastMessage = message;
    const source = this.orderedSources[this.cursor] || null;
    this.update({
      status,
      message,
      source,
      sourceNumber: source ? this.cursor + 1 : 0,
      sourceTotal: this.orderedSources.length,
      canNext: this.cursor + 1 < this.orderedSources.length,
      sourceOptions: this.orderedSources.map((option, index) => ({
        index,
        sourceId: sourceIdentifier(option, index),
        label: option.provenances?.join(" + ")
          || option.provenance
          || option.title
          || option.label
          || `Source ${index + 1}`,
        detail: [
          option.delivery === "relay" ? "Relay" : "Direct",
          option.quality || null,
          classifySource(option).toUpperCase(),
        ].filter(Boolean).join(" · "),
        active: index === this.cursor,
      })),
      subtitleOptions: this.subtitleOptions,
      qualityOptions: this.qualityOptions,
      audioOptions: this.audioOptions,
      diagnostics: this.diagnostics,
    });
  }

  private publishCurrent(): void {
    if (!this.disposed) this.publish(this.lastStatus, this.lastMessage);
  }

  private resetMediaOptions(source?: StreamSource): void {
    this.subtitleOptions = [{ id: "off", label: "Off", active: true }];
    this.qualityOptions = [{
      id: "auto",
      label: "Auto",
      detail: source?.quality ? `Source feed · ${source.quality}` : "Source default",
      active: true,
    }];
    this.audioOptions = [{ id: "default", label: "Default audio", active: true }];
    this.selectSubtitleImpl = null;
    this.selectQualityImpl = null;
    this.selectAudioImpl = null;
  }

  private isActive(token: number): boolean {
    return !this.disposed && token === this.generation;
  }

  private refreshSourceOrder(): void {
    const preferred = readRecord<string>(PREFERRED_STORAGE_KEY)[this.channel.key];
    const healthOrdered = orderPlaybackSources(
      this.channel.sources,
      this.health,
      preferred,
    );
    this.orderedSources = orderSourcesByPreflight(
      healthOrdered,
      readSourcePreflights(),
    );
  }

  private reorderRemainingSources(): void {
    const attempted = this.orderedSources.slice(0, this.cursor + 1);
    const attemptedIds = new Set(attempted.map((source) => sourceIdentifier(source)));
    const preferred = readRecord<string>(PREFERRED_STORAGE_KEY)[this.channel.key];
    const healthOrdered = orderPlaybackSources(
      this.channel.sources,
      this.health,
      preferred,
    );
    const readinessOrdered = orderSourcesByPreflight(
      healthOrdered,
      readSourcePreflights(),
    );
    this.orderedSources = [
      ...attempted,
      ...readinessOrdered.filter(
        (source) => !attemptedIds.has(sourceIdentifier(source)),
      ),
    ];
  }

  private resetVideo(): void {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}

/** Read the local, privacy-preserving route health snapshot used for ordering. */
export function readPlaybackHealth(): Record<string, SourceHealth> {
  const output: Record<string, SourceHealth> = Object.create(null) as Record<string, SourceHealth>;
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(HEALTH_STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return output;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return output;
  for (const [id, candidate] of Object.entries(parsed as Record<string, unknown>)) {
    if (!id || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    const failures = Number(value.failures);
    const cooldownUntil = Number(value.cooldownUntil);
    const lastSuccessAt = value.lastSuccessAt === undefined
      ? undefined
      : Number(value.lastSuccessAt);
    if (
      !Number.isInteger(failures)
      || failures < 0
      || failures > 8
      || !Number.isFinite(cooldownUntil)
      || cooldownUntil < 0
      || (lastSuccessAt !== undefined && (!Number.isFinite(lastSuccessAt) || lastSuccessAt < 0))
    ) continue;
    output[id] = {
      failures,
      cooldownUntil,
      ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
    };
  }
  return output;
}

function sourceNeedsHeaders(source: StreamSource): boolean {
  return Boolean(source.requiresHeaders || source.referrer || source.userAgent);
}

function readRecord<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as Record<string, T> : {};
  } catch {
    return {};
  }
}

function writeRecord<T>(key: string, value: Record<string, T>): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ }
}

function announceHealthChange(): void {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(SOURCE_HEALTH_CHANGED_EVENT));
    }
  } catch { /* the local health hint remains optional */ }
}

function recordSourceFailure(
  source: StreamSource,
  health: Record<string, SourceHealth>,
): void {
  const id = sourceIdentifier(source);
  const failures = Math.min((health[id]?.failures || 0) + 1, 8);
  health[id] = {
    ...health[id],
    failures,
    cooldownUntil: Date.now() + Math.min(30 * 60_000, 30_000 * (2 ** (failures - 1))),
  };
  writeRecord(HEALTH_STORAGE_KEY, health);
  announceHealthChange();
}

function recordSourceSuccess(
  channelKey: string,
  source: StreamSource,
  health: Record<string, SourceHealth>,
): void {
  const id = sourceIdentifier(source);
  health[id] = { failures: 0, cooldownUntil: 0, lastSuccessAt: Date.now() };
  writeRecord(HEALTH_STORAGE_KEY, health);
  announceHealthChange();
  const preferred = readRecord<string>(PREFERRED_STORAGE_KEY);
  preferred[channelKey] = id;
  writeRecord(PREFERRED_STORAGE_KEY, preferred);
}
