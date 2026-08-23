import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  Broadcast,
  CalendarDots,
  CaretDown,
  CaretLeft,
  CaretRight,
  ClosedCaptioning,
  CornersIn,
  CornersOut,
  CheckCircle,
  Clock,
  CloudArrowUp,
  DotsThreeVertical,
  Gauge,
  GlobeHemisphereWest,
  Heart,
  House,
  Info,
  ListBullets,
  MagnifyingGlass,
  MapPin,
  Pause,
  PictureInPicture,
  Play,
  Plus,
  SpeakerHigh,
  SpeakerSlash,
  SpinnerGap,
  Television,
  Translate,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  canonicalCountryCode,
  channelMatchesCity,
  channelMatchesCountry,
  channelMatchesRegion,
  channelMatchesSubdivision,
  channelMatchesTimezone,
} from "./broadcastArea";
import { mergeChannelsByKey } from "./catalogMerge";
import {
  channelMatchesMetadataFilters,
  channelProviders,
  sourceHostname,
  sourceProtocol,
  sourceProvenances,
} from "./catalogMetadata";
import {
  assertImportFileSize,
  MAX_PLAYLIST_IMPORT_BYTES,
  MAX_XMLTV_IMPORT_BYTES,
} from "./importLimits";
import { classifySource, migrateStoredChannelKeys } from "./playback/logic";
import {
  readPlaybackHealth,
  SOURCE_HEALTH_CHANGED_EVENT,
  usePlaybackController,
  type PlaybackController,
} from "./playback/usePlaybackController";
import { sourceIdentifier, type SourceHealth, type StreamSource } from "./playback/types";
import {
  readSourcePreflights,
  SOURCE_PREFLIGHT_CHANGED_EVENT,
  type SourcePreflight,
} from "./playback/preflight";
import {
  availabilityLabel,
  availabilityRank,
  channelAvailability,
  rankChannelsByAvailability,
  summarizeAvailability,
  type ChannelAvailability,
} from "./playback/availability";
import {
  isEnglishChannel,
  isHomeEntertainmentChannel,
  preferredAudienceCountryOrder,
  prioritizeEnglishAustraliaUnitedStates,
} from "./audiencePreferences";
import WebDestinationsView from "./WebDestinationsView";
import {
  loadWebDestinations,
  mergeWebDestinations,
  normalizeExternalHttpUrl,
  saveWebDestinations,
  upsertWebDestination,
  type WebDestination,
} from "./webDestinations";
import { appendZapDigit, resolveZapNumber, zapTarget } from "./zap";
import { loadWebCatalog } from "./webCatalog";
import { MAIN_FEED_OPTION_ID } from "./webCatalog";
import {
  loadRelayGuide,
  relayFetchText,
  RelayRequestError,
  toWebPlayableSources,
} from "./relayClient";
import TurnstileGuideGate from "./TurnstileGuideGate";
import { GUIDE_PAGE_SIZE, paginateGuideChannels } from "./guideNavigation";
import "./App.css";

const MASCOT_IMAGE = "/assets/brand/crow-mascot.png";
const BRAND_ICON = "/assets/brand/crow-head.png";
const PAGE_SIZE = 48;

type View = "home" | "live" | "guide" | "web" | "favourites" | "about";
type BrowseMode =
  | "categories"
  | "countries"
  | "languages"
  | "regions"
  | "subdivisions"
  | "cities"
  | "timezones"
  | "owners"
  | "networks"
  | "feeds"
  | "providers";

const PlaybackAvailabilityContext = createContext<Record<string, ChannelAvailability>>({});

type Channel = {
  key: string;
  id: string;
  feed?: string | null;
  name: string;
  altNames?: string[];
  owners?: string[];
  logo?: string | null;
  categories: string[];
  country?: string | null;
  languages: string[];
  broadcastArea: string[];
  timezones?: string[];
  sources: StreamSource[];
  url?: string;
  referrer?: string | null;
  userAgent?: string | null;
  quality?: string | null;
  label?: string | null;
  format?: string | null;
  network?: string | null;
  website?: string | null;
  launched?: string | null;
  replacedBy?: string | null;
  isNsfw?: boolean;
  provenance?: string[];
  isMain: boolean;
};

type NamedOption = { id: string; name: string; description?: string | null; count: number };
type CountryOption = { code: string; name: string; flag: string; languages: string[]; count: number };
type RegionOption = { code: string; name: string; countries: string[]; count: number };
type Catalog = {
  channels: Channel[];
  categories: NamedOption[];
  countries: CountryOption[];
  languages: NamedOption[];
  regions: RegionOption[];
  subdivisions: NamedOption[];
  cities: NamedOption[];
  timezones: NamedOption[];
  owners: NamedOption[];
  networks: NamedOption[];
  feeds: NamedOption[];
  providers: NamedOption[];
  updatedAt: string;
  source: string;
};
type Programme = {
  channelId: string;
  title: string;
  description?: string | null;
  category?: string | null;
  start: string;
  stop: string;
};
type GuideResult = {
  programmes: Programme[];
  source: string;
  matchedChannels: number;
  updatedAt: string;
};

declare global {
  interface Window { __TAURI_INTERNALS__?: unknown }
}

const demoDefinitions = [
  ["Crow News", "news", "AU"], ["World Report", "news", "UK"], ["Pulse 24", "news", "US"],
  ["Cinema One", "movies", "AU"], ["Midnight Movies", "movies", "US"], ["Classic Screen", "classic", "UK"],
  ["Arena Live", "sports", "AU"], ["World Football", "sports", "UK"], ["Velocity", "auto", "DE"],
  ["Wild Earth", "documentary", "CA"], ["Deep Space", "science", "US"], ["Culture House", "culture", "FR"],
  ["Neon Sessions", "music", "JP"], ["Stage Live", "entertainment", "US"], ["Family Central", "family", "NZ"],
  ["Junior Planet", "kids", "AU"], ["World Kitchen", "cooking", "IT"], ["Open Roads", "travel", "NO"],
] as const;

const demoChannels: Channel[] = Array.from({ length: 72 }, (_, index) => {
  const [base, category, country] = demoDefinitions[index % demoDefinitions.length];
  return {
    key: `preview-${index}`, id: `Preview${index}.${country.toLowerCase()}`, name: index < demoDefinitions.length ? base : `${base} ${Math.floor(index / demoDefinitions.length) + 1}`,
    logo: null, categories: [category], country, languages: ["English"], broadcastArea: [`c/${country}`], sources: [],
    feed: null, format: index % 3 === 0 ? "1080p" : "720p", network: "CrowFlix Preview", website: null, provenance: ["CrowFlix Preview"], isMain: true,
  };
});

function makeDemoProgrammes(channels: Channel[]): Programme[] {
  const titles = ["Morning Brief", "Wild Frontiers", "Live at the Arena", "After Dark", "World Kitchen", "Signal Unknown", "The Big Match", "Northern Lights"];
  const base = new Date();
  base.setMinutes(0, 0, 0);
  return channels.flatMap((channel, channelIndex) => Array.from({ length: 7 }, (_, index) => ({
    channelId: channel.id,
    title: titles[(channelIndex + index) % titles.length],
    description: `Live now on ${channel.name}.`,
    category: titleCase(channel.categories[0]),
    start: new Date(base.getTime() + (index - 2) * 60 * 60 * 1000).toISOString(),
    stop: new Date(base.getTime() + (index - 1) * 60 * 60 * 1000).toISOString(),
  })));
}

const demoCatalog: Catalog = {
  channels: demoChannels,
  categories: [...new Set(demoChannels.flatMap((channel) => channel.categories))].map((id) => ({ id, name: titleCase(id), count: demoChannels.filter((channel) => channel.categories.includes(id)).length })),
  countries: ["AU", "US", "UK", "CA", "DE", "FR", "JP", "NZ", "IT", "NO"].map((code) => ({ code, name: countryName(code), flag: "", languages: ["eng"], count: demoChannels.filter((channel) => channel.country === code).length })),
  languages: [{ id: "English", name: "English", count: demoChannels.length }],
  regions: [{ code: "WORLD", name: "Worldwide", countries: ["AU", "US", "UK", "CA", "DE", "FR", "JP", "NZ", "IT", "NO"], count: demoChannels.length }],
  subdivisions: [], cities: [], timezones: [],
  owners: [],
  networks: [{ id: "CrowFlix Preview", name: "CrowFlix Preview", count: demoChannels.length }],
  feeds: [{ id: MAIN_FEED_OPTION_ID, name: "Main feed", count: demoChannels.length }],
  providers: [{ id: "CrowFlix Preview", name: "CrowFlix Preview", count: demoChannels.length }],
  updatedAt: new Date().toISOString(), source: "CrowFlix browser preview",
};

const emptyCatalog: Catalog = {
  channels: [],
  categories: [],
  countries: [],
  languages: [],
  regions: [],
  subdivisions: [],
  cities: [],
  timezones: [],
  owners: [],
  networks: [],
  feeds: [],
  providers: [],
  updatedAt: "",
  source: "IPTV-org catalogue unavailable",
};

function titleCase(value?: string | null) {
  if (!value) return "Other";
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function countryName(code?: string | null) {
  if (!code) return "Unclassified";
  const canonical = canonicalCountryCode(code);
  const displayCode = canonical === "UK" ? "GB" : canonical;
  try { return new Intl.DisplayNames(undefined, { type: "region" }).of(displayCode) || canonical; }
  catch { return canonical; }
}

const DEFAULT_GUIDE_COUNTRY = "AU";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentProgramme(programmes: Programme[], channelId: string, clock: Date) {
  const now = clock.getTime();
  return programmes.find((item) => item.channelId === channelId && new Date(item.start).getTime() <= now && new Date(item.stop).getTime() > now);
}

function nextProgramme(programmes: Programme[], channelId: string, clock: Date) {
  const now = clock.getTime();
  return programmes.filter((item) => item.channelId === channelId && new Date(item.start).getTime() > now).sort((a, b) => a.start.localeCompare(b.start))[0];
}

function mergeProgrammes(
  primary: readonly Programme[],
  supplemental: readonly Programme[],
): Programme[] {
  const merged = new Map<string, Programme>();
  for (const programme of [...primary, ...supplemental]) {
    merged.set(
      `${programme.channelId}\u0000${programme.start}\u0000${programme.stop}`,
      programme,
    );
  }
  return [...merged.values()].sort((left, right) =>
    left.start.localeCompare(right.start)
    || left.channelId.localeCompare(right.channelId));
}

function uniqueChannelIds(channels: Channel[]) {
  return [...new Set(channels.map((channel) => channel.id))];
}

function uniqueGuideChannels(channels: Channel[]) {
  const byId = new Map<string, Set<string>>();
  for (const channel of channels) {
    const names = byId.get(channel.id) || new Set<string>();
    names.add(channel.name.replace(/\s+—\s+.+$/, ""));
    for (const name of channel.altNames || []) names.add(name);
    byId.set(channel.id, names);
  }
  return [...byId.entries()].map(([id, names]) => ({
    id,
    names: [...names].slice(0, 12),
  }));
}

function formatTime(value: Date) {
  return value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function channelSources(channel: Channel): StreamSource[] {
  if (channel.sources?.length) return channel.sources;
  if (!channel.url) return [];
  return [{
    id: `${channel.key}-legacy`,
    url: channel.url,
    referrer: channel.referrer,
    userAgent: channel.userAgent,
    quality: channel.quality,
    label: channel.label,
    requiresHeaders: Boolean(channel.referrer || channel.userAgent),
  }];
}

function preferredSource(channel: Channel): StreamSource | undefined {
  return channelSources(channel)[0];
}

function channelQuality(channel: Channel): string {
  return preferredSource(channel)?.quality || channel.format || "LIVE";
}

function stored<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
}

function useModalFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusable = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) || [])];
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [dialogRef, onClose]);
}

export default function App() {
  const isDesktop = Boolean(window.__TAURI_INTERNALS__);
  const [initialWebLibrary] = useState(() =>
    loadWebDestinations(localStorage)
  );
  const [view, setView] = useState<View>("home");
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState("Connecting to IPTV-org…");
  const [query, setQuery] = useState("");
  const [browseMode, setBrowseMode] = useState<BrowseMode>("categories");
  const [category, setCategory] = useState("all");
  const [country, setCountry] = useState("all");
  const [language, setLanguage] = useState("all");
  const [region, setRegion] = useState("all");
  const [subdivision, setSubdivision] = useState("all");
  const [city, setCity] = useState("all");
  const [timezone, setTimezone] = useState("all");
  const [owner, setOwner] = useState("all");
  const [network, setNetwork] = useState("all");
  const [feed, setFeed] = useState("all");
  const [provider, setProvider] = useState("all");
  const [guideCountry, setGuideCountry] = useState(DEFAULT_GUIDE_COUNTRY);
  const [programmes, setProgrammes] = useState<Programme[]>([]);
  const [guideStatus, setGuideStatus] = useState("Preparing the live guide…");
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideNeedsVerification, setGuideNeedsVerification] = useState(false);
  const [guideVerificationError, setGuideVerificationError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Channel | null>(null);
  const [detailsChannel, setDetailsChannel] = useState<Channel | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [epgUrl, setEpgUrl] = useState("");
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState(new Date());
  const [favourites, setFavourites] = useState<string[]>(() => stored("crowflix:favourites", []));
  const [recent, setRecent] = useState<string[]>(() => stored("crowflix:recent", []));
  const [webDestinations, setWebDestinations] = useState<WebDestination[]>(
    initialWebLibrary.items,
  );
  const webDestinationsRef = useRef<WebDestination[]>(
    initialWebLibrary.items,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const guideCache = useRef(new Map<string, GuideResult>());
  const personalGuide = useRef<GuideResult | null>(null);
  const skipInitialWebSave = useRef(true);
  const previousChannelKey = useRef<string | null>(null);
  const zapBuffer = useRef("");
  const zapNumberTimer = useRef<number | undefined>(undefined);
  const zapNoticeTimer = useRef<number | undefined>(undefined);
  const [zapNotice, setZapNotice] = useState("");
  const [playbackHealth, setPlaybackHealth] = useState<Record<string, SourceHealth>>(
    () => readPlaybackHealth(),
  );
  const [sourcePreflights, setSourcePreflights] = useState<Record<string, SourcePreflight>>(
    () => readSourcePreflights(),
  );
  useEffect(() => {
    const refreshHealth = () => setPlaybackHealth(readPlaybackHealth());
    window.addEventListener(SOURCE_HEALTH_CHANGED_EVENT, refreshHealth);
    return () => window.removeEventListener(SOURCE_HEALTH_CHANGED_EVENT, refreshHealth);
  }, []);
  useEffect(() => {
    let refreshTimer: number | undefined;
    const refreshPreflights = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(
        () => setSourcePreflights(readSourcePreflights()),
        150,
      );
    };
    window.addEventListener(SOURCE_PREFLIGHT_CHANGED_EVENT, refreshPreflights);
    return () => {
      window.removeEventListener(SOURCE_PREFLIGHT_CHANGED_EVENT, refreshPreflights);
      window.clearTimeout(refreshTimer);
    };
  }, []);
  const playbackTarget = useMemo(
    () => playing
      ? {
        ...playing,
        sources: isDesktop
          ? channelSources(playing)
          : channelSources(playing).flatMap(toWebPlayableSources),
      }
      : null,
    [playing, isDesktop],
  );
  const playback = usePlaybackController(playbackTarget, videoRef);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3500);
  }, []);
  const closeSourceDialog = useCallback(() => setSourceOpen(false), []);
  const closeChannelDetails = useCallback(() => setDetailsChannel(null), []);

  const loadCatalog = useCallback(async (force = false) => {
    setLoading(true);
    setLoadingMessage(force ? "Refreshing the worldwide catalogue…" : "Loading channels, feeds, logos and regions…");
    try {
      const result = isDesktop
        ? await invoke<Catalog>("load_catalog", { force })
        : await loadWebCatalog(force);
      setCatalog(result);
      setCatalogError(null);
      setGuideCountry((current) => {
        const currentCode = canonicalCountryCode(current);
        const remainsAvailable = result.countries.some(
          (item) => canonicalCountryCode(item.code) === currentCode,
        );
        return remainsAvailable
          ? currentCode
          : canonicalCountryCode(result.countries[0]?.code) || "AU";
      });
      if (force) showToast(`${result.channels.length.toLocaleString()} channels ready · ${result.source}`);
    } catch (error) {
      if (!isDesktop) {
        // The web build has no demo pretence: show the labelled preview set
        // only when the real catalogue cannot be reached at all.
        setCatalog(demoCatalog);
        setProgrammes(makeDemoProgrammes(demoChannels));
        setGuideStatus("CrowFlix preview guide · live now and up next");
        setCatalogError(null);
        showToast("Live catalogue unreachable — showing the CrowFlix preview set");
        return;
      }
      const message = errorMessage(error);
      setCatalogError(message);
      showToast(message);
    } finally { setLoading(false); }
  }, [isDesktop, showToast]);

  useEffect(() => { void loadCatalog(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { localStorage.setItem("crowflix:favourites", JSON.stringify(favourites)); }, [favourites]);
  useEffect(() => { localStorage.setItem("crowflix:recent", JSON.stringify(recent)); }, [recent]);
  useEffect(() => {
    if (skipInitialWebSave.current) {
      skipInitialWebSave.current = false;
      if (!initialWebLibrary.migrated) return;
    }
    const error = saveWebDestinations(localStorage, webDestinations);
    if (error) showToast(`Web Library could not be saved: ${error}`);
  }, [showToast, webDestinations]);
  useEffect(() => {
    webDestinationsRef.current = webDestinations;
  }, [webDestinations]);
  useEffect(() => {
    if (initialWebLibrary.error) {
      showToast(`CrowFlix recovered the Web Library defaults: ${initialWebLibrary.error}`);
    }
  }, [initialWebLibrary.error, showToast]);
  useEffect(() => { const timer = window.setInterval(() => setClock(new Date()), 30_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!catalog.channels.length) return;
    const availableKeys = catalog.channels.map((channel) => channel.key);
    const migrate = (items: string[]) => {
      const next = migrateStoredChannelKeys(items, availableKeys);
      return next.length === items.length && next.every((key, index) => key === items[index])
        ? items
        : next;
    };
    setFavourites(migrate);
    setRecent(migrate);
  }, [catalog.channels]);

  const applyGuideResult = useCallback((result: GuideResult) => {
    const personal = personalGuide.current;
    const includePersonal = personal && personal.source !== result.source;
    const combined = mergeProgrammes(
      result.programmes,
      includePersonal ? personal.programmes : [],
    );
    const source = includePersonal
      ? `${result.source} + ${personal.source}`
      : result.source;
    setProgrammes(combined);
    setGuideStatus(
      `${source} · ${new Set(combined.map((programme) => programme.channelId)).size.toLocaleString()} channels matched`,
    );
  }, []);

  const loadGuide = useCallback(async (
    code: string,
    force = false,
    turnstileToken?: string,
  ) => {
    const targetCountry = canonicalCountryCode(code);
    const countryChannels = catalog.channels.filter(
      (channel) => channelMatchesCountry(
        channel,
        targetCountry,
        catalog.regions,
      ),
    );
    if (!countryChannels.length) {
      setProgrammes([]);
      setGuideNeedsVerification(false);
      setGuideVerificationError(null);
      setGuideStatus(`No channels are available for ${countryName(targetCountry)}`);
      return;
    }
    const cached = guideCache.current.get(targetCountry);
    if (cached && !force) {
      setGuideNeedsVerification(false);
      setGuideVerificationError(null);
      applyGuideResult(cached);
      return;
    }
    const personal = personalGuide.current;
    const countryChannelIds = new Set(countryChannels.map((channel) => channel.id));
    if (
      personal
      && !force
      && personal.programmes.some((programme) => countryChannelIds.has(programme.channelId))
    ) {
      setGuideNeedsVerification(false);
      setGuideVerificationError(null);
      applyGuideResult(personal);
      return;
    }
    if (!isDesktop) {
      if (catalog.source.includes("preview")) {
        const result: GuideResult = { programmes: makeDemoProgrammes(countryChannels), source: "CrowFlix preview guide", matchedChannels: countryChannels.length, updatedAt: new Date().toISOString() };
        setGuideNeedsVerification(false);
        setGuideVerificationError(null);
        guideCache.current.set(targetCountry, result);
        applyGuideResult(result);
        return;
      }
      if (!turnstileToken) {
        setGuideNeedsVerification(true);
        setGuideVerificationError(null);
        setGuideStatus("Complete Cloudflare verification to load live programme data.");
        return;
      }
      setGuideNeedsVerification(false);
      setGuideVerificationError(null);
      setGuideLoading(true);
      setGuideStatus(`Matching ${countryName(targetCountry)} channels through the CrowFlix relay…`);
      try {
        const result = await loadRelayGuide(
          targetCountry,
          uniqueGuideChannels(countryChannels),
          turnstileToken,
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
        guideCache.current.set(targetCountry, result);
        applyGuideResult(result);
      } catch (error) {
        setProgrammes(personalGuide.current?.programmes || []);
        const message = error instanceof Error ? error.message : String(error);
        setGuideStatus(message);
        if (error instanceof RelayRequestError && error.status === 403) {
          setGuideNeedsVerification(true);
          setGuideVerificationError(message);
        }
      } finally { setGuideLoading(false); }
      return;
    }
    setGuideLoading(true);
    setGuideStatus(`Matching ${countryName(targetCountry)} channels to IPTV-org programme sources…`);
    try {
      const result = await invoke<GuideResult>("load_auto_epg", { country: targetCountry, channelIds: uniqueChannelIds(countryChannels) });
      guideCache.current.set(targetCountry, result);
      applyGuideResult(result);
    } catch (error) {
      setProgrammes(personalGuide.current?.programmes || []);
      setGuideStatus(error instanceof Error ? error.message : String(error));
    } finally { setGuideLoading(false); }
  }, [applyGuideResult, catalog.channels, catalog.regions, catalog.source, isDesktop]);

  useEffect(() => {
    if (view === "guide" && catalog.channels.length) void loadGuide(guideCountry);
  }, [catalog.channels, guideCountry, loadGuide, view]);
  useEffect(() => {
    if (view !== "guide" || !catalog.channels.length) return;
    const timer = window.setInterval(() => { void loadGuide(guideCountry, true); }, 4 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [catalog.channels.length, guideCountry, loadGuide, view]);

  const play = useCallback((channel: Channel) => {
    setPlaying((current) => {
      if (current && current.key !== channel.key) {
        previousChannelKey.current = current.key;
      }
      return channel;
    });
    setRecent((items) => [channel.key, ...items.filter((key) => key !== channel.key)].slice(0, 24));
  }, []);

  const toggleFavourite = useCallback((channel: Channel) => {
    setFavourites((items) => items.includes(channel.key) ? items.filter((key) => key !== channel.key) : [...items, channel.key]);
  }, []);

  const openWebsite = useCallback(async (url: string, _title = "website") => {
    try {
      const normalized = normalizeExternalHttpUrl(url);
      if (!window.__TAURI_INTERNALS__) {
        window.open(normalized, "_blank", "noopener,noreferrer");
        return;
      }
      await invoke("open_web_destination", { url: normalized });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  }, [showToast]);

  const saveWebDestination = useCallback((
    item: WebDestination,
    previousId?: string,
  ) => {
    const next = upsertWebDestination(
      webDestinationsRef.current,
      item,
      previousId,
    );
    webDestinationsRef.current = next;
    setWebDestinations(next);
    showToast(previousId ? "Website updated" : "Website added to CrowFlix");
  }, [showToast]);

  const deleteWebDestination = useCallback((item: WebDestination) => {
    const next = webDestinationsRef.current.filter(
      (entry) => entry.id !== item.id,
    );
    webDestinationsRef.current = next;
    setWebDestinations(next);
    showToast(`${item.title} removed from the Web Library`);
  }, [showToast]);

  const importWebDestinations = useCallback((
    imported: WebDestination[],
    filename: string,
  ) => {
    const current = webDestinationsRef.current;
    const merged = mergeWebDestinations(current, imported);
    const added = merged.length - current.length;
    webDestinationsRef.current = merged;
    setWebDestinations(merged);
    showToast(added
      ? `${added.toLocaleString()} website destinations added from ${filename}`
      : `No new website destinations were found in ${filename}`);
  }, [showToast]);

  const importPlaylistUrl = async () => {
    if (!sourceUrl.trim()) return;
    setLoading(true); setLoadingMessage("Adding your playlist…");
    try {
      if (isDesktop) {
        const custom = await invoke<Channel[]>("load_playlist", { source: sourceUrl.trim() });
        setCatalog((current) => ({ ...current, channels: mergeChannelsByKey(current.channels, custom), source: `${current.source} + custom playlist` }));
        showToast(`${custom.length.toLocaleString()} personal channels added`);
      } else {
        const personal = await import("./personalSources");
        const source = personal.normalizePersonalSourceUrl(sourceUrl.trim());
        const content = await relayFetchText(source, MAX_PLAYLIST_IMPORT_BYTES);
        const custom = personal.parsePersonalPlaylist(content, new URL(source).hostname);
        setCatalog((current) => personal.mergePersonalPlaylistIntoCatalog(current, custom));
        showToast(`${custom.length.toLocaleString()} personal channels added`);
      }
      setSourceUrl("");
      setSourceOpen(false);
      setView("live");
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  const importPlaylistFile = async (file: File) => {
    setLoading(true);
    setLoadingMessage("Reading your playlist on this device…");
    try {
      assertImportFileSize(
        file,
        "playlist",
        MAX_PLAYLIST_IMPORT_BYTES,
      );
      const content = await file.text();
      if (isDesktop) {
        const custom = await invoke<Channel[]>("parse_playlist_text", { text: content });
        setCatalog((current) => ({ ...current, channels: mergeChannelsByKey(current.channels, custom), source: `${current.source} + ${file.name}` }));
        showToast(`${custom.length.toLocaleString()} personal channels added`);
      } else {
        const personal = await import("./personalSources");
        const custom = personal.parsePersonalPlaylist(content, file.name);
        setCatalog((current) => personal.mergePersonalPlaylistIntoCatalog(current, custom));
        showToast(`${custom.length.toLocaleString()} personal channels added`);
      }
      setSourceOpen(false);
      setView("live");
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  const importEpgUrl = async () => {
    if (!epgUrl.trim()) return;
    setGuideLoading(true);
    try {
      let result: GuideResult;
      if (isDesktop) {
        result = await invoke<GuideResult>("load_epg", { source: epgUrl.trim(), channelIds: uniqueChannelIds(catalog.channels) });
      } else {
        const personal = await import("./personalSources");
        const source = personal.normalizePersonalSourceUrl(epgUrl.trim());
        const content = await relayFetchText(source, MAX_XMLTV_IMPORT_BYTES);
        result = personal.parsePersonalXmltv(content, catalog.channels, new URL(source).hostname);
      }
      personalGuide.current = result;
      guideCache.current.set(guideCountry, result);
      setGuideNeedsVerification(false);
      setGuideVerificationError(null);
      applyGuideResult(result);
      setEpgUrl("");
      setSourceOpen(false);
      setView("guide");
      showToast(`Personal guide loaded · ${result.matchedChannels.toLocaleString()} channels matched`);
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
    finally { setGuideLoading(false); }
  };

  const importEpgFile = async (file: File) => {
    setGuideLoading(true);
    try {
      assertImportFileSize(
        file,
        "programme guide",
        MAX_XMLTV_IMPORT_BYTES,
      );
      let result: GuideResult;
      if (isDesktop) {
        result = await invoke<GuideResult>("parse_epg_text", { text: await file.text(), channelIds: uniqueChannelIds(catalog.channels) });
      } else {
        const personal = await import("./personalSources");
        result = await personal.parsePersonalXmltvFile(file, catalog.channels);
      }
      personalGuide.current = result;
      guideCache.current.set(guideCountry, result);
      setGuideNeedsVerification(false);
      setGuideVerificationError(null);
      applyGuideResult(result);
      setSourceOpen(false);
      setView("guide");
      showToast(`Personal guide loaded · ${result.matchedChannels.toLocaleString()} channels matched`);
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
    finally { setGuideLoading(false); }
  };

  const healthNow = clock.getTime();
  const rankedCatalogChannels = useMemo(
    () => prioritizeEnglishAustraliaUnitedStates(rankChannelsByAvailability(
      catalog.channels,
      playbackHealth,
      healthNow,
      sourcePreflights,
    )),
    [catalog.channels, healthNow, playbackHealth, sourcePreflights],
  );
  const availabilityByChannel = useMemo(
    () => Object.fromEntries(catalog.channels.map((channel) => [
      channel.key,
      channelAvailability(channel, playbackHealth, healthNow, sourcePreflights),
    ])),
    [catalog.channels, healthNow, playbackHealth, sourcePreflights],
  );
  const availabilitySummary = useMemo(
    () => summarizeAvailability(
      catalog.channels,
      playbackHealth,
      healthNow,
      sourcePreflights,
    ),
    [catalog.channels, healthNow, playbackHealth, sourcePreflights],
  );

  const filteredChannels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = catalog.channels.filter((channel) => {
      if (
        country !== "all"
        && !channelMatchesCountry(channel, country, catalog.regions)
      ) return false;
      if (category !== "all" && !channel.categories.includes(category)) return false;
      if (language !== "all" && !channel.languages.includes(language)) return false;
      if (
        region !== "all"
        && !channelMatchesRegion(channel, region, catalog.regions)
      ) return false;
      if (
        subdivision !== "all"
        && !channelMatchesSubdivision(channel, subdivision)
      ) return false;
      if (city !== "all" && !channelMatchesCity(channel, city)) return false;
      if (
        timezone !== "all"
        && !channelMatchesTimezone(channel, timezone)
      ) return false;
      if (!channelMatchesMetadataFilters(channel, { owner, network, feed, provider })) return false;
      if (needle && !`${channel.name} ${(channel.altNames || []).join(" ")} ${(channel.owners || []).join(" ")} ${(channel.provenance || []).join(" ")} ${channel.network || ""} ${channel.categories.join(" ")} ${channel.languages.join(" ")} ${(channel.timezones || []).join(" ")} ${channel.broadcastArea.join(" ")} ${countryName(channel.country)}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    return prioritizeEnglishAustraliaUnitedStates(rankChannelsByAvailability(
      matching,
      playbackHealth,
      healthNow,
      sourcePreflights,
    ));
  }, [catalog.channels, catalog.regions, category, city, country, feed, healthNow, language, network, owner, playbackHealth, provider, query, region, sourcePreflights, subdivision, timezone]);

  const favouriteChannels = useMemo(() => favourites.map((key) => catalog.channels.find((channel) => channel.key === key)).filter(Boolean) as Channel[], [catalog.channels, favourites]);
  const recentChannels = useMemo(() => recent.map((key) => catalog.channels.find((channel) => channel.key === key)).filter(Boolean) as Channel[], [catalog.channels, recent]);
  const australianEnglishChannels = useMemo(
    () => rankedCatalogChannels.filter((channel) =>
      channelMatchesCountry(channel, "AU", catalog.regions)
      && isEnglishChannel(channel)),
    [catalog.regions, rankedCatalogChannels],
  );
  const americanEnglishChannels = useMemo(
    () => rankedCatalogChannels.filter((channel) =>
      channelMatchesCountry(channel, "US", catalog.regions)
      && isEnglishChannel(channel)),
    [catalog.regions, rankedCatalogChannels],
  );
  const englishChannels = useMemo(
    () => rankedCatalogChannels.filter(isEnglishChannel),
    [rankedCatalogChannels],
  );
  const australianEnglishEntertainment = useMemo(
    () => australianEnglishChannels.filter(isHomeEntertainmentChannel),
    [australianEnglishChannels],
  );
  const americanEnglishEntertainment = useMemo(
    () => americanEnglishChannels.filter(isHomeEntertainmentChannel),
    [americanEnglishChannels],
  );
  const englishEntertainment = useMemo(
    () => englishChannels.filter(isHomeEntertainmentChannel),
    [englishChannels],
  );
  const sourceCount = useMemo(
    () => catalog.channels.reduce((total, channel) => total + channelSources(channel).length, 0),
    [catalog.channels],
  );
  const heroCandidates = australianEnglishEntertainment.length
    ? australianEnglishEntertainment
    : americanEnglishEntertainment.length
      ? americanEnglishEntertainment
      : englishEntertainment;
  const hero = heroCandidates.find((channel) => currentProgramme(programmes, channel.id, clock)) || heroCandidates[0] || rankedCatalogChannels[0];
  const heroNow = hero ? currentProgramme(programmes, hero.id, clock) : undefined;
  const heroNext = hero ? nextProgramme(programmes, hero.id, clock) : undefined;

  const zapKeys = useMemo(
    () => (filteredChannels.length ? filteredChannels : catalog.channels).map((channel) => channel.key),
    [filteredChannels, catalog.channels],
  );
  const announceZap = useCallback((message: string) => {
    setZapNotice(message);
    window.clearTimeout(zapNoticeTimer.current);
    zapNoticeTimer.current = window.setTimeout(() => setZapNotice(""), 1800);
  }, []);
  const zapTo = useCallback((channel: Channel, label?: string) => {
    play(channel);
    announceZap(label || channel.name);
  }, [play, announceZap]);
  const zapStep = useCallback((direction: 1 | -1) => {
    const targetKey = zapTarget(zapKeys, playing?.key ?? null, direction);
    const channel = targetKey ? catalog.channels.find((item) => item.key === targetKey) : undefined;
    if (!channel || !targetKey) return;
    zapTo(channel, `CH ${zapKeys.indexOf(targetKey) + 1} · ${channel.name}`);
  }, [zapKeys, playing?.key, catalog.channels, zapTo]);
  const commitZapNumber = useCallback(() => {
    const buffer = zapBuffer.current;
    zapBuffer.current = "";
    if (!buffer) return;
    const index = resolveZapNumber(buffer, zapKeys.length);
    if (index === null) { announceZap(`No channel ${buffer}`); return; }
    const channel = catalog.channels.find((item) => item.key === zapKeys[index]);
    if (channel) zapTo(channel, `CH ${index + 1} · ${channel.name}`);
  }, [zapKeys, catalog.channels, zapTo, announceZap]);

  useEffect(() => {
    if (!playing) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        zapBuffer.current = appendZapDigit(zapBuffer.current, event.key);
        announceZap(`CH ${zapBuffer.current}…`);
        window.clearTimeout(zapNumberTimer.current);
        zapNumberTimer.current = window.setTimeout(commitZapNumber, 1100);
        return;
      }
      if (event.key === "Enter" && zapBuffer.current) {
        event.preventDefault();
        window.clearTimeout(zapNumberTimer.current);
        commitZapNumber();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "PageUp") { event.preventDefault(); zapStep(1); return; }
      if (event.key === "ArrowDown" || event.key === "PageDown") { event.preventDefault(); zapStep(-1); return; }
      if ((event.key === "Backspace" || event.key.toLowerCase() === "l") && previousChannelKey.current) {
        event.preventDefault();
        const channel = catalog.channels.find((item) => item.key === previousChannelKey.current);
        if (channel) zapTo(channel, `BACK · ${channel.name}`);
        return;
      }
      if (event.key === "Escape") {
        if (
          event.defaultPrevented
          || document.fullscreenElement
          || document.pictureInPictureElement
          || document.querySelector('[data-player-overlay-open="true"]')
        ) return;
        event.preventDefault();
        setPlaying(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      zapBuffer.current = "";
      window.clearTimeout(zapNumberTimer.current);
    };
  }, [playing, zapStep, commitZapNumber, zapTo, announceZap, catalog.channels]);

  const changeView = (next: View) => { setView(next); window.scrollTo({ top: 0, behavior: "smooth" }); };

  return (
    <PlaybackAvailabilityContext.Provider value={availabilityByChannel}>
    <div className="app-shell">
      <Header view={view} onView={changeView} query={query} onQuery={(value) => { setQuery(value); if (value && view !== "web") setView("live"); }} onSource={() => setSourceOpen(true)} canAddSource />
      {loading && <LoadingOverlay message={loadingMessage} />}
      {catalogError && <CatalogErrorBanner message={catalogError} hasCatalog={catalog.channels.length > 0} loading={loading} onRetry={() => void loadCatalog(catalog.channels.length > 0)} />}
      <main>
        {view === "home" && <HomeView channels={rankedCatalogChannels} australianEnglish={australianEnglishEntertainment} americanEnglish={americanEnglishEntertainment} english={englishEntertainment} programmes={programmes} clock={clock} hero={hero} heroNow={heroNow} heroNext={heroNext} recent={recentChannels} favourites={favourites} onPlay={play} onFavourite={toggleFavourite} onGuide={() => setView("guide")} onInfo={setDetailsChannel} />}
        {view === "live" && <LiveView catalog={catalog} channels={filteredChannels} mode={browseMode} setMode={setBrowseMode} category={category} setCategory={setCategory} country={country} setCountry={setCountry} language={language} setLanguage={setLanguage} region={region} setRegion={setRegion} subdivision={subdivision} setSubdivision={setSubdivision} city={city} setCity={setCity} timezone={timezone} setTimezone={setTimezone} owner={owner} setOwner={setOwner} network={network} setNetwork={setNetwork} feed={feed} setFeed={setFeed} provider={provider} setProvider={setProvider} favourites={favourites} programmes={programmes} clock={clock} onPlay={play} onFavourite={toggleFavourite} onInfo={setDetailsChannel} />}
        {view === "guide" && <GuideView catalog={catalog} country={guideCountry} setCountry={setGuideCountry} programmes={programmes} clock={clock} status={guideStatus} loading={guideLoading} requiresVerification={!isDesktop && guideNeedsVerification} verificationError={guideVerificationError} onVerified={(token) => void loadGuide(guideCountry, true, token)} onVerificationError={(message) => { setGuideVerificationError(message || null); if (message) setGuideStatus(message); }} onRefresh={() => void loadGuide(guideCountry, true)} onPlay={play} />}
        {view === "web" && <WebDestinationsView items={webDestinations} query={query} onOpen={(item) => void openWebsite(item.url, item.title)} onSave={saveWebDestination} onDelete={deleteWebDestination} onImport={importWebDestinations} onMessage={showToast} />}
        {view === "favourites" && <FavouritesView channels={favouriteChannels} favourites={favourites} programmes={programmes} clock={clock} onPlay={play} onFavourite={toggleFavourite} onInfo={setDetailsChannel} onBrowse={() => setView("live")} />}
        {view === "about" && <AboutView onOpen={(url, title) => void openWebsite(url, title)} />}
      </main>
      {view === "web"
        ? <footer className="status-bar"><span><GlobeHemisphereWest weight="fill" /> {webDestinations.length.toLocaleString()} CrowFlix free and website destinations</span><span>Saved on this device · JSON backup available</span></footer>
        : view === "about"
          ? <footer className="status-bar"><span><Info weight="fill" /> CrowFlix 0.5.1</span><span>Copyright © 2026 Crow · AGPL-3.0-only</span></footer>
        : <footer className="status-bar"><span><Broadcast weight="fill" /> {catalog.channels.length.toLocaleString()} catalogued · {availabilitySummary.verified.toLocaleString()} live · {availabilitySummary.ready.toLocaleString()} ready · {sourceCount.toLocaleString()} sources</span><span>{catalog.source}</span><button onClick={() => void loadCatalog(true)}><ArrowsClockwise /> Refresh catalogue</button></footer>}
      {playing && <Player channel={playing} channels={rankedCatalogChannels} programmes={programmes} clock={clock} now={currentProgramme(programmes, playing.id, clock)} next={nextProgramme(programmes, playing.id, clock)} playback={playback} videoRef={videoRef} zapNotice={zapNotice} onOpenWebsite={(url, title) => void openWebsite(url, title)} onSelectChannel={(channel) => zapTo(channel, channel.name)} onStepChannel={zapStep} onClose={() => setPlaying(null)} />}
      {detailsChannel && <ChannelDetails channel={detailsChannel} now={currentProgramme(programmes, detailsChannel.id, clock)} next={nextProgramme(programmes, detailsChannel.id, clock)} favourite={favourites.includes(detailsChannel.key)} onPlay={(channel) => { closeChannelDetails(); play(channel); }} onFavourite={toggleFavourite} onOpenWebsite={(url, title) => void openWebsite(url, title)} onClose={closeChannelDetails} />}
      {sourceOpen && <SourceDialog sourceUrl={sourceUrl} setSourceUrl={setSourceUrl} epgUrl={epgUrl} setEpgUrl={setEpgUrl} loading={loading || guideLoading} onClose={closeSourceDialog} onPlaylistUrl={() => void importPlaylistUrl()} onPlaylistFile={(file) => void importPlaylistFile(file)} onEpgUrl={() => void importEpgUrl()} onEpgFile={(file) => void importEpgFile(file)} />}
      {toast && <div className="toast"><CheckCircle weight="fill" />{toast}</div>}
    </div>
    </PlaybackAvailabilityContext.Provider>
  );
}

function Header({ view, onView, query, onQuery, onSource, canAddSource }: { view: View; onView: (view: View) => void; query: string; onQuery: (value: string) => void; onSource: () => void; canAddSource: boolean }) {
  const nav: Array<[View, string, React.ReactNode]> = [["home", "Home", <House />], ["live", "Live TV", <Broadcast />], ["guide", "Guide", <CalendarDots />], ["web", "CrowFlix Free", <GlobeHemisphereWest />], ["favourites", "My List", <Heart />], ["about", "About", <Info />]];
  return <header className="topbar">
    <button className="brand" onClick={() => onView("home")}><img src={BRAND_ICON} alt="" /><span>CROW<strong>FLIX</strong></span></button>
    <nav>{nav.map(([id, label, icon]) => <button key={id} className={view === id ? "active" : ""} onClick={() => onView(id)}>{icon}<span>{label}</span></button>)}</nav>
    <div className="header-actions"><label className="search"><MagnifyingGlass /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={view === "web" ? "Search websites" : "Search the world"} />{query && <button aria-label="Clear search" onClick={() => onQuery("")}><X /></button>}</label>{canAddSource && <button className="source-button" onClick={onSource}><Plus /><span>Add source</span></button>}</div>
  </header>;
}

function CatalogErrorBanner({ message, hasCatalog, loading, onRetry }: { message: string; hasCatalog: boolean; loading: boolean; onRetry: () => void }) {
  return <section className="catalog-error-banner" role="alert" aria-live="assertive">
    <WarningCircle weight="fill" />
    <div>
      <strong>{hasCatalog ? "Catalogue refresh failed" : "Live catalogue could not be loaded"}</strong>
      <span>{message}{hasCatalog ? " The previously loaded channels remain available." : ""}</span>
    </div>
    <button onClick={onRetry} disabled={loading}>{loading ? <SpinnerGap className="spin" /> : <ArrowsClockwise />} Retry</button>
  </section>;
}

function HomeView({ channels, australianEnglish, americanEnglish, english, programmes, clock, hero, heroNow, heroNext, recent, favourites, onPlay, onFavourite, onGuide, onInfo }: { channels: Channel[]; australianEnglish: Channel[]; americanEnglish: Channel[]; english: Channel[]; programmes: Programme[]; clock: Date; hero?: Channel; heroNow?: Programme; heroNext?: Programme; recent: Channel[]; favourites: string[]; onPlay: (channel: Channel) => void; onFavourite: (channel: Channel) => void; onGuide: () => void; onInfo: (channel: Channel) => void }) {
  const availabilityByChannel = useContext(PlaybackAvailabilityContext);
  const rail = (category: string) => channels.filter((channel) => channel.categories.includes(category)).slice(0, 24);
  if (!hero) {
    return <div className="home-view">
      <section className="hero">
        <img className="hero-art" src={MASCOT_IMAGE} alt="CrowFlix cybernetic crow mascot" />
        <div className="hero-vignette" />
        <div className="hero-copy">
          <span className="overline"><WarningCircle weight="fill" /> Catalogue unavailable</span>
          <h1>No live channels loaded</h1>
          <p>CrowFlix has not substituted preview channels. Retry the catalogue connection above or add a personal source.</p>
        </div>
      </section>
    </div>;
  }
  const heroAvailability = availabilityByChannel[hero.key] || "unverified";
  return <div className="home-view">
    <section className="hero">
      <img className="hero-art" src={MASCOT_IMAGE} alt="CrowFlix cybernetic crow mascot" />
      <div className="hero-vignette" />
      <div className="hero-copy">
        <span className="overline"><Broadcast weight="fill" /> Australia, United States & English first · {heroAvailability === "verified" ? "Verified live" : availabilityLabel(heroAvailability)}</span>
        <h1>{heroNow?.title || hero.name}</h1>
        <div className="hero-meta"><strong>{hero.name}</strong><span>{channelQuality(hero)}</span><span>{countryName(hero.country)}</span><span>{titleCase(hero.categories[0])}</span></div>
        <p>{heroNow?.description || `Watch ${hero.name} live from the worldwide CrowFlix channel catalogue.`}</p>
        {heroNext && <div className="up-next"><Clock /><span><small>UP NEXT · {formatTime(new Date(heroNext.start))}</small><strong>{heroNext.title}</strong></span></div>}
        <div className="hero-actions"><button className="primary" onClick={() => onPlay(hero)}><Play weight="fill" /> Watch live</button><button className="secondary" onClick={onGuide}><CalendarDots /> Open guide</button><button className="secondary" onClick={() => onInfo(hero)}><Info /> Channel details</button><button className="icon-button" aria-label="Toggle featured channel favourite" onClick={() => onFavourite(hero)}><Heart weight={favourites.includes(hero.key) ? "fill" : "regular"} /></button></div>
      </div>
    </section>
    <div className="home-content">
      {recent.length > 0 && <ChannelRail title="Continue watching" channels={recent} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />}
      <ChannelRail title="Australian entertainment" channels={australianEnglish.slice(0, 24)} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />
      <ChannelRail title="American TV & Movies" channels={americanEnglish.slice(0, 24)} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />
      <ChannelRail title="English-language television" channels={english.slice(0, 24)} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />
      <ChannelRail title="Movies to watch" channels={rail("movies")} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />
      <ChannelRail title="TV shows & entertainment" channels={[...rail("entertainment"), ...rail("series"), ...rail("classic")].slice(0, 24)} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />
      <ChannelRail title="Animation & family" channels={[...rail("animation"), ...rail("kids"), ...rail("family")].slice(0, 24)} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />
      <ChannelRail title="Documentaries and discovery" channels={[...rail("documentary"), ...rail("science")].slice(0, 24)} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />
      <ChannelRail title="Music and entertainment" channels={[...rail("music"), ...rail("entertainment")].slice(0, 24)} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />
    </div>
  </div>;
}

function ChannelRail({ title, channels, programmes, clock, favourites, onPlay, onFavourite, onInfo }: { title: string; channels: Channel[]; programmes: Programme[]; clock: Date; favourites: string[]; onPlay: (channel: Channel) => void; onFavourite: (channel: Channel) => void; onInfo: (channel: Channel) => void }) {
  const railRef = useRef<HTMLDivElement>(null);
  if (!channels.length) return null;
  return <section className="rail-section"><div className="section-heading"><h2>{title}</h2><span>{channels.length.toLocaleString()} channels</span></div><div className="rail-wrap"><button className="rail-arrow left" aria-label={`Scroll ${title} left`} onClick={() => railRef.current?.scrollBy({ left: -900, behavior: "smooth" })}><CaretLeft /></button><div className="channel-rail" ref={railRef}>{channels.map((channel) => <ChannelCard key={channel.key} channel={channel} programme={currentProgramme(programmes, channel.id, clock)} favourite={favourites.includes(channel.key)} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />)}</div><button className="rail-arrow right" aria-label={`Scroll ${title} right`} onClick={() => railRef.current?.scrollBy({ left: 900, behavior: "smooth" })}><CaretRight /></button></div></section>;
}

function ChannelCard({ channel, programme, favourite, onPlay, onFavourite, onInfo }: { channel: Channel; programme?: Programme; favourite: boolean; onPlay: (channel: Channel) => void; onFavourite: (channel: Channel) => void; onInfo: (channel: Channel) => void }) {
  const availability = useContext(PlaybackAvailabilityContext)[channel.key] || "unverified";
  return <article className="channel-card"><button className="card-main" onClick={() => onPlay(channel)}><div className="card-image">{channel.logo ? <img src={channel.logo} alt="" onError={(event) => { event.currentTarget.src = BRAND_ICON; event.currentTarget.className = "fallback-logo"; }} /> : <img className="fallback-logo" src={BRAND_ICON} alt="" />}<span className={`live-badge availability-${availability}`}>{availabilityLabel(availability)}</span><span className="quality-badge">{channelQuality(channel)}</span><span className="play-overlay"><Play weight="fill" /></span></div><div className="card-copy"><strong>{programme?.title || channel.name}</strong><span>{channel.name}</span><small>{countryName(channel.country)} · {titleCase(channel.categories[0])}</small></div></button><button className="details-button" onClick={() => onInfo(channel)} aria-label={`Show ${channel.name} details`}><Info /></button><button className="heart-button" onClick={() => onFavourite(channel)} aria-label={`Toggle ${channel.name} favourite`}><Heart weight={favourite ? "fill" : "regular"} /></button></article>;
}

type LiveViewProps = {
  catalog: Catalog; channels: Channel[]; mode: BrowseMode;
  setMode: (mode: BrowseMode) => void;
  category: string; setCategory: (value: string) => void;
  country: string; setCountry: (value: string) => void;
  language: string; setLanguage: (value: string) => void;
  region: string; setRegion: (value: string) => void;
  subdivision: string; setSubdivision: (value: string) => void;
  city: string; setCity: (value: string) => void;
  timezone: string; setTimezone: (value: string) => void;
  owner: string; setOwner: (value: string) => void;
  network: string; setNetwork: (value: string) => void;
  feed: string; setFeed: (value: string) => void;
  provider: string; setProvider: (value: string) => void;
  favourites: string[]; programmes: Programme[]; clock: Date;
  onPlay: (channel: Channel) => void;
  onFavourite: (channel: Channel) => void;
  onInfo: (channel: Channel) => void;
};

function LiveView({ catalog, channels, mode, setMode, category, setCategory, country, setCountry, language, setLanguage, region, setRegion, subdivision, setSubdivision, city, setCity, timezone, setTimezone, owner, setOwner, network, setNetwork, feed, setFeed, provider, setProvider, favourites, programmes, clock, onPlay, onFavourite, onInfo }: LiveViewProps) {
  const [catalogOrder, setCatalogOrder] = useState<"preferred" | "alphabetical">("preferred");
  const [page, setPage] = useState(1);
  const visibleChannels = useMemo(() => catalogOrder === "preferred"
    ? channels
    : [...channels].sort((left, right) => left.name.localeCompare(right.name)),
  [catalogOrder, channels]);
  const pageCount = Math.max(1, Math.ceil(visibleChannels.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageChannels = visibleChannels.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );
  const matchingSources = visibleChannels.reduce((total, channel) => total + channelSources(channel).length, 0);
  useEffect(() => setPage(1), [catalogOrder, category, city, country, feed, language, network, owner, provider, region, subdivision, timezone, visibleChannels.length]);
  const optionsByMode: Record<BrowseMode, NamedOption[]> = {
    categories: catalog.categories,
    countries: catalog.countries.map((item) => ({ id: item.code, name: `${item.flag} ${item.name}`, count: item.count })),
    languages: catalog.languages,
    regions: catalog.regions.map((item) => ({ id: item.code, name: item.name, count: item.count })),
    subdivisions: catalog.subdivisions,
    cities: catalog.cities,
    timezones: catalog.timezones,
    owners: catalog.owners,
    networks: catalog.networks,
    feeds: catalog.feeds,
    providers: catalog.providers,
  };
  const selectedByMode: Record<BrowseMode, string> = {
    categories: category,
    countries: country,
    languages: language,
    regions: region,
    subdivisions: subdivision,
    cities: city,
    timezones: timezone,
    owners: owner,
    networks: network,
    feeds: feed,
    providers: provider,
  };
  const modeOptions = optionsByMode[mode];
  const selected = selectedByMode[mode];
  const select = (value: string) => {
    if (mode === "categories") setCategory(value);
    if (mode === "countries") setCountry(value);
    if (mode === "languages") setLanguage(value);
    if (mode === "regions") setRegion(value);
    if (mode === "subdivisions") setSubdivision(value);
    if (mode === "cities") setCity(value);
    if (mode === "timezones") setTimezone(value);
    if (mode === "owners") setOwner(value);
    if (mode === "networks") setNetwork(value);
    if (mode === "feeds") setFeed(value);
    if (mode === "providers") setProvider(value);
  };
  const clearAll = () => {
    setCategory("all"); setCountry("all"); setLanguage("all"); setRegion("all");
    setSubdivision("all"); setCity("all"); setTimezone("all");
    setOwner("all"); setNetwork("all"); setFeed("all"); setProvider("all");
  };
  const browseModes: Array<[BrowseMode, React.ReactNode, string]> = [
    ["categories", <ListBullets />, "Categories"],
    ["countries", <GlobeHemisphereWest />, "Countries"],
    ["languages", <Translate />, "Languages"],
    ["regions", <MapPin />, "Regions"],
    ["subdivisions", <MapPin />, "States / provinces"],
    ["cities", <House />, "Cities"],
    ["timezones", <Clock />, "Timezones"],
    ["owners", <House />, "Owners"],
    ["networks", <Broadcast />, "Networks"],
    ["feeds", <Television />, "Feeds"],
    ["providers", <CloudArrowUp />, "Source providers"],
  ];
  const activeFilterLabels = [
    category !== "all" ? titleCase(category) : null,
    country !== "all" ? countryName(country) : null,
    language !== "all" ? language : null,
    region !== "all" ? catalog.regions.find((item) => item.code === region)?.name || region : null,
    subdivision !== "all" ? catalog.subdivisions.find((item) => item.id === subdivision)?.name || subdivision : null,
    city !== "all" ? catalog.cities.find((item) => item.id === city)?.name || city : null,
    timezone !== "all" ? timezone : null,
    owner !== "all" ? owner : null,
    network !== "all" ? network : null,
    feed !== "all" ? catalog.feeds.find((item) => item.id === feed)?.name || feed : null,
    provider !== "all" ? provider : null,
  ].filter((label): label is string => Boolean(label));
  return <div className="browse-page">
    <div className="page-hero"><div><span className="overline"><Television /> Worldwide live television · Australia, United States & English first</span><h1>Browse Live TV</h1><p>The complete matching catalogue stays visible. Australian and American English channels lead by default; every country and language remains searchable, filterable, and reachable.</p></div><div className="catalog-number"><strong>{visibleChannels.length.toLocaleString()}</strong><span>catalogued · {matchingSources.toLocaleString()} sources</span></div></div>
    <div className="browse-layout"><aside className="browse-sidebar"><h3>Explore by</h3>{browseModes.map(([id, icon, label]) => <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}>{icon}<span>{label}</span><CaretRight /></button>)}<div className="active-filters"><span>Active filters</span>{activeFilterLabels.map((label, index) => <b key={`${label}-${index}`}>{label}</b>)}<button onClick={clearAll}>Clear all</button></div></aside>
      <section className="browse-results"><div className="filter-strip"><button className={selected === "all" ? "active" : ""} onClick={() => select("all")}>All</button>{modeOptions.map((item) => <button key={item.id} className={selected === item.id ? "active" : ""} onClick={() => select(item.id)}><span>{item.name}</span><small>{item.count.toLocaleString()}</small></button>)}</div><div className="result-heading"><div><h2>{selected === "all" ? `All ${titleCase(mode)}` : modeOptions.find((item) => item.id === selected)?.name}</h2><span>Showing {visibleChannels.length ? (safePage - 1) * PAGE_SIZE + 1 : 0}–{Math.min(safePage * PAGE_SIZE, visibleChannels.length)} of {visibleChannels.length.toLocaleString()}</span></div><div className="availability-switch"><button className={catalogOrder === "preferred" ? "active" : ""} onClick={() => setCatalogOrder("preferred")}>Australia / US / English first</button><button className={catalogOrder === "alphabetical" ? "active" : ""} onClick={() => setCatalogOrder("alphabetical")}>A–Z</button></div></div>{visibleChannels.length ? <><div className="channel-grid">{pageChannels.map((channel) => <ChannelCard key={channel.key} channel={channel} programme={currentProgramme(programmes, channel.id, clock)} favourite={favourites.includes(channel.key)} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />)}</div><Pagination page={safePage} pageCount={pageCount} onPage={setPage} /></> : <EmptyState title="No matching channels" copy="Clear a filter or search for something else." />}</section></div>
  </div>;
}

function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  return <div className="pagination"><button disabled={page <= 1} onClick={() => onPage(page - 1)}><CaretLeft /> Previous</button><span>Page <strong>{page.toLocaleString()}</strong> of {pageCount.toLocaleString()}</span><button disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next <CaretRight /></button></div>;
}

function GuideView({ catalog, country, setCountry, programmes, clock, status, loading, requiresVerification, verificationError, onVerified, onVerificationError, onRefresh, onPlay }: { catalog: Catalog; country: string; setCountry: (value: string) => void; programmes: Programme[]; clock: Date; status: string; loading: boolean; requiresVerification: boolean; verificationError: string | null; onVerified: (token: string) => void; onVerificationError: (message: string) => void; onRefresh: () => void; onPlay: (channel: Channel) => void }) {
  const availabilityByChannel = useContext(PlaybackAvailabilityContext);
  const [page, setPage] = useState(1);
  const countryChannels = catalog.channels.filter(
    (channel) => channelMatchesCountry(channel, country, catalog.regions),
  );
  const byChannel = useMemo(() => { const map = new Map<string, Programme[]>(); programmes.forEach((item) => map.set(item.channelId, [...(map.get(item.channelId) || []), item])); return map; }, [programmes]);
  const sortedChannels = prioritizeEnglishAustraliaUnitedStates([...countryChannels].sort((a, b) =>
    Number(byChannel.has(b.id)) - Number(byChannel.has(a.id))
    || availabilityRank(availabilityByChannel[a.key] || "unverified")
      - availabilityRank(availabilityByChannel[b.key] || "unverified")
    || a.name.localeCompare(b.name)));
  const guideCountries = useMemo(
    () => [...catalog.countries].sort((left, right) =>
      preferredAudienceCountryOrder(left.code, right.code)),
    [catalog.countries],
  );
  const guidePage = paginateGuideChannels(sortedChannels, page);
  const guidePageCount = guidePage.pageCount;
  const safePage = guidePage.page;
  const channels = guidePage.channels;
  const listedCountryChannels = countryChannels.filter((channel) => byChannel.has(channel.id)).length;
  useEffect(() => setPage(1), [country]);
  const start = new Date(clock); start.setMinutes(Math.floor(start.getMinutes() / 30) * 30, 0, 0);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const times = Array.from({ length: 9 }, (_, index) => new Date(start.getTime() + index * 30 * 60 * 1000));
  return <div className="guide-page"><div className="page-hero guide-title"><div><span className="overline"><CalendarDots /> Live programme guide · English first</span><h1>What’s on now</h1><p>{clock.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })} · Australia is the default; United States is pinned next.</p></div><div className="guide-controls"><label><span>Guide country · English first</span><select value={canonicalCountryCode(country)} onChange={(event) => setCountry(canonicalCountryCode(event.target.value))}>{guideCountries.map((item) => <option key={item.code} value={canonicalCountryCode(item.code)}>{item.flag} {item.name} ({item.count.toLocaleString()})</option>)}</select></label><button onClick={onRefresh} disabled={loading}><ArrowsClockwise className={loading ? "spin" : ""} /> Refresh</button></div></div>{requiresVerification && <TurnstileGuideGate error={verificationError} onVerified={onVerified} onError={onVerificationError} />}<div className="guide-status"><span className="signal-dot" /><strong>{loading ? "Updating live programme data…" : status}</strong><span>{listedCountryChannels.toLocaleString()} with listings · {countryChannels.length.toLocaleString()} channels total</span></div><div className="guide-shell"><div className="guide-times"><div>Channel</div>{times.map((time) => <span key={time.toISOString()}>{formatTime(time)}</span>)}</div><div className="guide-now-line" style={{ left: `calc(260px + ${((clock.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * 100}% * (1 - 260px / 100%))` }}><b>NOW</b></div>{channels.map((channel) => { const items = (byChannel.get(channel.id) || []).filter((item) => new Date(item.stop) > start && new Date(item.start) < end); return <div className="guide-row" key={channel.key}><button className="guide-channel" onClick={() => onPlay(channel)}>{channel.logo ? <img src={channel.logo} alt="" /> : <img src={BRAND_ICON} alt="" />}<span><strong>{channel.name}</strong><small>{titleCase(channel.categories[0])}</small></span></button><div className="programme-track">{items.length ? items.map((item) => { const itemStart = Math.max(start.getTime(), new Date(item.start).getTime()); const itemEnd = Math.min(end.getTime(), new Date(item.stop).getTime()); const left = ((itemStart - start.getTime()) / (end.getTime() - start.getTime())) * 100; const width = ((itemEnd - itemStart) / (end.getTime() - start.getTime())) * 100; const live = new Date(item.start) <= clock && new Date(item.stop) > clock; return <button key={`${item.channelId}-${item.start}`} className={live ? "live" : ""} style={{ left: `${left}%`, width: `${width}%` }} onClick={() => onPlay(channel)}><strong>{item.title}</strong><small>{formatTime(new Date(item.start))}–{formatTime(new Date(item.stop))}</small></button>; }) : <button className="no-listing" onClick={() => onPlay(channel)}><strong>Live broadcast</strong><small>Programme details unavailable</small></button>}</div></div>; })}</div>{guidePage.total > GUIDE_PAGE_SIZE && <div className="guide-pagination"><span>Showing {guidePage.start}–{guidePage.end} of {guidePage.total.toLocaleString()}</span><Pagination page={safePage} pageCount={guidePageCount} onPage={setPage} /></div>}{!loading && !programmes.length && !requiresVerification && <EmptyState title="No programme listings matched" copy="The channels remain available to watch live while CrowFlix refreshes guide sources." />}</div>;
}

function FavouritesView({ channels, favourites, programmes, clock, onPlay, onFavourite, onInfo, onBrowse }: { channels: Channel[]; favourites: string[]; programmes: Programme[]; clock: Date; onPlay: (channel: Channel) => void; onFavourite: (channel: Channel) => void; onInfo: (channel: Channel) => void; onBrowse: () => void }) {
  return <div className="browse-page"><div className="page-hero"><div><span className="overline"><Heart weight="fill" /> Your CrowFlix library</span><h1>My List</h1><p>Your saved live channels, ready whenever you are.</p></div><div className="catalog-number"><strong>{channels.length}</strong><span>saved channels</span></div></div>{channels.length ? <div className="channel-grid standalone-grid">{channels.map((channel) => <ChannelCard key={channel.key} channel={channel} programme={currentProgramme(programmes, channel.id, clock)} favourite={favourites.includes(channel.key)} onPlay={onPlay} onFavourite={onFavourite} onInfo={onInfo} />)}</div> : <EmptyState title="Your list is waiting" copy="Save channels from Home or Live TV and they will appear here." action="Browse live TV" onAction={onBrowse} />}</div>;
}

function AboutView({ onOpen }: { onOpen: (url: string, title: string) => void }) {
  const links = [
    ["Source code", "https://github.com/CrowLoki/Crow-Flix-Website"],
    ["Software licence", "https://github.com/CrowLoki/Crow-Flix-Website/blob/main/LICENSE"],
    ["Licensing details", "https://github.com/CrowLoki/Crow-Flix-Website/blob/main/LICENSING.md"],
    ["Third-party notices", "https://github.com/CrowLoki/Crow-Flix-Website/blob/main/THIRD_PARTY_NOTICES.md"],
    ["Free Collection policy", "https://github.com/CrowLoki/Crow-Flix-Website/blob/main/docs/OFFICIAL-FREE-COLLECTION.md"],
    ["Privacy", "https://github.com/CrowLoki/Crow-Flix-Website/blob/main/PRIVACY.md"],
    ["Security", "https://github.com/CrowLoki/Crow-Flix-Website/blob/main/SECURITY.md"],
  ] as const;

  return <section className="about-view">
    <div className="about-intro">
      <img src={MASCOT_IMAGE} alt="CrowFlix cybernetic crow mascot" />
      <div>
        <span className="overline"><Info weight="fill" /> About CrowFlix</span>
        <h1>CrowFlix <strong>0.5.1</strong></h1>
        <p>A cinematic browser IPTV player, programme guide, and user-managed web library built with React, TypeScript, Vite, and a Cloudflare relay.</p>
      </div>
    </div>
    <div className="about-grid">
      <article>
        <h2>Free software</h2>
        <p>Copyright © 2026 Crow. CrowFlix source code and documentation are licensed under the GNU Affero General Public License version 3 only.</p>
        <p>This program comes with absolutely no warranty. See the licence for the complete terms and your rights to obtain, study, modify, and share the source.</p>
      </article>
      <article>
        <h2>Brand and external services</h2>
        <p>The Crow name, mascot, icons, custom fonts, and cursor artwork have separate brand terms and are not licensed under the AGPL.</p>
        <p>CrowFlix does not host television channels or media. Catalogue, guide, stream, artwork, and website providers are independent services with their own availability and terms.</p>
      </article>
    </div>
    <div className="about-links">
      {links.map(([label, url]) => <button key={url} onClick={() => onOpen(url, label)}><ArrowSquareOut />{label}</button>)}
    </div>
  </section>;
}

function DetailItem({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return <div className="detail-item"><span>{label}</span><strong>{value}</strong></div>;
}

function ChannelDetails({ channel, now, next, favourite, onPlay, onFavourite, onOpenWebsite, onClose }: {
  channel: Channel;
  now?: Programme;
  next?: Programme;
  favourite: boolean;
  onPlay: (channel: Channel) => void;
  onFavourite: (channel: Channel) => void;
  onOpenWebsite: (url: string, title: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocusTrap(dialogRef, onClose);
  const availability = useContext(PlaybackAvailabilityContext)[channel.key] || "unverified";
  const sources = channelSources(channel);
  const providers = channelProviders(channel);
  let website = "";
  try { website = channel.website ? normalizeExternalHttpUrl(channel.website) : ""; }
  catch { website = ""; }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} className="channel-details" role="dialog" aria-modal="true" aria-labelledby="channel-details-title">
      <button type="button" className="dialog-close" aria-label="Close channel details" onClick={onClose}><X /></button>
      <div className="channel-details-hero">
        <div className="channel-details-logo">{channel.logo ? <img src={channel.logo} alt="" onError={(event) => { event.currentTarget.src = BRAND_ICON; }} /> : <img src={BRAND_ICON} alt="" />}</div>
        <div>
          <span className="overline"><Broadcast weight="fill" /> {availabilityLabel(availability)} · {countryName(channel.country)}</span>
          <h2 id="channel-details-title">{now?.title || channel.name}</h2>
          <p>{channel.name}{now?.description ? ` · ${now.description}` : ""}</p>
          {next && <div className="detail-next"><Clock /><span><small>UP NEXT · {formatTime(new Date(next.start))}</small><strong>{next.title}</strong></span></div>}
        </div>
      </div>
      <div className="channel-details-grid">
        <DetailItem label="Channel ID" value={channel.id} />
        <DetailItem label="Feed" value={`${channel.feed || "Main feed"}${channel.isMain ? " · primary" : ""}`} />
        <DetailItem label="Network" value={channel.network} />
        <DetailItem label="Owners" value={(channel.owners || []).join(" · ")} />
        <DetailItem label="Alternate names" value={(channel.altNames || []).join(" · ")} />
        <DetailItem label="Categories" value={channel.categories.map(titleCase).join(" · ")} />
        <DetailItem label="Languages" value={channel.languages.join(" · ")} />
        <DetailItem label="Broadcast areas" value={channel.broadcastArea.join(" · ")} />
        <DetailItem label="Timezones" value={(channel.timezones || []).join(" · ")} />
        <DetailItem label="Format" value={channel.format || channelQuality(channel)} />
        <DetailItem label="Launched" value={channel.launched} />
        <DetailItem label="Replacement" value={channel.replacedBy} />
        <DetailItem label="Source providers" value={providers.join(" · ")} />
      </div>
      <section className="channel-source-list" aria-label={`${channel.name} playback source metadata`}>
        <div><h3>Playback sources</h3><span>{sources.length.toLocaleString()} preserved routes before browser delivery fallbacks</span></div>
        {sources.map((source, index) => <article key={sourceIdentifier(source, index)}>
          <span><strong>{sourceProvenances(source).join(" + ") || source.title || source.label || `Source ${index + 1}`}</strong><small>{sourceHostname(source)}</small></span>
          <div>{source.quality && <b>{source.quality}</b>}{source.label && <b>{source.label}</b>}<b>{(source.transport || source.transportHint || "unknown").toUpperCase()}</b><b>{sourceProtocol(source)}</b>{source.requiresHeaders && <b>Provider headers</b>}</div>
        </article>)}
      </section>
      <div className="channel-details-actions">
        <button className="primary" onClick={() => onPlay(channel)}><Play weight="fill" /> Watch live</button>
        <button className="secondary" onClick={() => onFavourite(channel)}><Heart weight={favourite ? "fill" : "regular"} /> {favourite ? "Remove from My List" : "Add to My List"}</button>
        {website && <button className="secondary" onClick={() => onOpenWebsite(website, channel.name)}><ArrowSquareOut /> Channel website</button>}
      </div>
    </section>
  </div>;
}

type PlayerMenuPage = "subtitles" | "quality" | "audio" | "speed" | "source" | null;

const PLAYER_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function Player({
  channel,
  channels,
  programmes,
  clock,
  now,
  next,
  playback,
  videoRef,
  zapNotice,
  onOpenWebsite,
  onSelectChannel,
  onStepChannel,
  onClose,
}: {
  channel: Channel;
  channels: Channel[];
  programmes: Programme[];
  clock: Date;
  now?: Programme;
  next?: Programme;
  playback: PlaybackController;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  zapNotice: string;
  onOpenWebsite: (url: string, title: string) => void;
  onSelectChannel: (channel: Channel) => void;
  onStepChannel: (direction: 1 | -1) => void;
  onClose: () => void;
}) {
  const playerRef = useRef<HTMLDivElement | null>(null);
  const availabilityByChannel = useContext(PlaybackAvailabilityContext);
  const source = playback.source;
  const externalOnly = channelSources(channel).length > 0
    && channelSources(channel).every((candidate) => classifySource(candidate) === "unsupported");
  const latestDiagnostic = playback.diagnostics[playback.diagnostics.length - 1];
  const busy = playback.status === "loading" || playback.status === "switching";
  const [chromeVisible, setChromeVisible] = useState(true);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuPage, setMenuPage] = useState<PlayerMenuPage>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideQuery, setGuideQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const chromeTimer = useRef<number | undefined>(undefined);
  const overlayOpen = sourcesOpen || settingsOpen || guideOpen;
  const interactive = overlayOpen || paused || busy || playback.status === "failed" || playback.status === "interaction-required";
  const hasFiniteDuration = Number.isFinite(duration) && duration > 0;
  const activeSubtitle = playback.subtitleOptions.find((option) => option.active)?.label || "Off";
  const activeQuality = playback.qualityOptions.find((option) => option.active)?.label || "Auto";
  const activeAudio = playback.audioOptions.find((option) => option.active)?.label || "Default";

  const guideProgrammeByChannel = useMemo(() => {
    const active = new Map<string, Programme>();
    const time = clock.getTime();
    for (const programme of programmes) {
      if (
        !active.has(programme.channelId)
        && new Date(programme.start).getTime() <= time
        && new Date(programme.stop).getTime() > time
      ) active.set(programme.channelId, programme);
    }
    return active;
  }, [clock, programmes]);
  const guideChannels = useMemo(() => {
    const term = guideQuery.trim().toLocaleLowerCase();
    if (term) {
      return channels.filter((candidate) => [
        candidate.name,
        ...(candidate.altNames || []),
        candidate.network || "",
        ...(candidate.owners || []),
        countryName(candidate.country),
      ].some((value) => value.toLocaleLowerCase().includes(term))).slice(0, 40);
    }
    if (!channels.length) return [];
    const start = Math.max(0, channels.findIndex((candidate) => candidate.key === channel.key));
    return Array.from(
      { length: Math.min(30, channels.length) },
      (_, offset) => channels[(start + offset) % channels.length],
    );
  }, [channel.key, channels, guideQuery]);

  const wake = useCallback(() => {
    setChromeVisible(true);
    window.clearTimeout(chromeTimer.current);
    chromeTimer.current = window.setTimeout(() => setChromeVisible(false), 3200);
  }, []);
  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, [videoRef]);
  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }, [videoRef]);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else if (playerRef.current?.requestFullscreen) void playerRef.current.requestFullscreen().catch(() => undefined);
  }, []);
  const togglePictureInPicture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !document.pictureInPictureEnabled || !video.requestPictureInPicture) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
    else void video.requestPictureInPicture().catch(() => undefined);
  }, [videoRef]);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setMenuPage(null);
  }, []);

  useEffect(() => {
    wake();
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake);
      window.clearTimeout(chromeTimer.current);
    };
  }, [wake]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const syncPlayback = () => setPaused(video.paused);
    const syncVolume = () => { setMuted(video.muted); setVolume(video.volume); };
    const syncTime = () => { setCurrentTime(video.currentTime || 0); setDuration(video.duration || 0); };
    const syncRate = () => setPlaybackRate(video.playbackRate || 1);
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === playerRef.current);
    const onEnterPictureInPicture = () => setPictureInPicture(true);
    const onLeavePictureInPicture = () => setPictureInPicture(false);
    syncPlayback();
    syncVolume();
    syncTime();
    syncRate();
    syncFullscreen();
    video.addEventListener("play", syncPlayback);
    video.addEventListener("playing", syncPlayback);
    video.addEventListener("pause", syncPlayback);
    video.addEventListener("volumechange", syncVolume);
    video.addEventListener("timeupdate", syncTime);
    video.addEventListener("durationchange", syncTime);
    video.addEventListener("loadedmetadata", syncTime);
    video.addEventListener("ratechange", syncRate);
    video.addEventListener("enterpictureinpicture", onEnterPictureInPicture);
    video.addEventListener("leavepictureinpicture", onLeavePictureInPicture);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => {
      video.removeEventListener("play", syncPlayback);
      video.removeEventListener("playing", syncPlayback);
      video.removeEventListener("pause", syncPlayback);
      video.removeEventListener("volumechange", syncVolume);
      video.removeEventListener("timeupdate", syncTime);
      video.removeEventListener("durationchange", syncTime);
      video.removeEventListener("loadedmetadata", syncTime);
      video.removeEventListener("ratechange", syncRate);
      video.removeEventListener("enterpictureinpicture", onEnterPictureInPicture);
      video.removeEventListener("leavepictureinpicture", onLeavePictureInPicture);
      document.removeEventListener("fullscreenchange", syncFullscreen);
    };
  }, [channel.key, videoRef]);
  useEffect(() => {
    const onPlayerKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) || target.isContentEditable)) return;
      if (event.key === "Escape" && overlayOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSourcesOpen(false);
        closeSettings();
        setGuideOpen(false);
        return;
      }
      const key = event.key.toLocaleLowerCase();
      if (event.code === "Space" || key === "k") togglePlayback();
      else if (key === "m") toggleMute();
      else if (key === "f") toggleFullscreen();
      else if (key === "g") { setGuideOpen((open) => !open); setSourcesOpen(false); closeSettings(); }
      else if (key === "c" && playback.subtitleOptions.length > 1) {
        playback.selectSubtitle(activeSubtitle === "Off" ? playback.subtitleOptions[1].id : "off");
      } else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onPlayerKeyDown, true);
    return () => window.removeEventListener("keydown", onPlayerKeyDown, true);
  }, [activeSubtitle, closeSettings, overlayOpen, playback, toggleFullscreen, toggleMute, togglePlayback]);
  useEffect(() => {
    setSourcesOpen(false);
    closeSettings();
    setGuideOpen(false);
    setGuideQuery("");
  }, [channel.key, closeSettings]);
  useEffect(() => {
    if (interactive || zapNotice) {
      setChromeVisible(true);
      window.clearTimeout(chromeTimer.current);
    } else {
      wake();
    }
  }, [interactive, zapNotice, wake]);

  let channelWebsite = "";
  try {
    channelWebsite = channel.website ? normalizeExternalHttpUrl(channel.website) : "";
  } catch {
    channelWebsite = "";
  }

  const menuTitle = menuPage === "subtitles" ? "Subtitles"
    : menuPage === "quality" ? "Streaming quality"
    : menuPage === "audio" ? "Audio language"
    : menuPage === "speed" ? "Playback speed"
    : "Playback source";
  const unavailableCopy = menuPage === "subtitles" && playback.subtitleOptions.length === 1
    ? "This channel is not supplying a subtitle track."
    : menuPage === "quality" && playback.qualityOptions.length === 1
      ? "This source is supplying one fixed stream quality."
      : menuPage === "audio" && playback.audioOptions.length === 1
        ? "This source is supplying one audio track."
        : "";

  return <div
    ref={playerRef}
    className={chromeVisible ? "player" : "player chrome-hidden"}
    data-player-overlay-open={overlayOpen ? "true" : undefined}
  >
    <div className="player-ambient" />
    <video ref={videoRef} autoPlay playsInline poster={MASCOT_IMAGE} onClick={togglePlayback} onDoubleClick={toggleFullscreen} />
    <div className="player-shade" />
    <div className="player-top">
      <button onClick={onClose}><CaretLeft /> Back to CrowFlix</button>
      <button
        className="player-source-state"
        aria-live="polite"
        aria-expanded={sourcesOpen}
        aria-controls="playback-source-options"
        disabled={playback.sourceOptions.length === 0}
        title="Choose a playback source"
        onClick={() => { setSourcesOpen((open) => !open); closeSettings(); setGuideOpen(false); }}
      >
        {playback.sourceTotal > 0 && <span>Route {playback.sourceNumber}/{playback.sourceTotal}</span>}
        <i className={playback.status === "playing" ? "online" : ""} />
        {playback.status === "playing" ? "Live" : titleCase(playback.status)}
      </button>
      {playback.canNext && <button className="player-next-source" onClick={playback.next} title="Try the next playback route">Next route <CaretRight /></button>}
      <button
        className="player-brand"
        aria-expanded={guideOpen}
        aria-controls="player-mini-guide"
        title="Open the channel guide"
        onClick={() => { setGuideOpen((open) => !open); setSourcesOpen(false); closeSettings(); }}
      ><img src={BRAND_ICON} alt="" /><span>CROW<strong>FLIX</strong></span><CaretDown /></button>
    </div>
    {sourcesOpen && playback.sourceOptions.length > 0 && <section id="playback-source-options" className="source-chooser" aria-label="Playback sources">
      <div><strong>Playback sources</strong><span>Choose any preserved feed or delivery route.</span></div>
      <div className="source-options">{playback.sourceOptions.map((option) => <button key={`${option.sourceId}-${option.index}`} className={option.active ? "active" : ""} onClick={() => { playback.selectSource(option.index); setSourcesOpen(false); }}><span><strong>{option.label}</strong><small>{option.detail}</small></span><b>{option.active ? "NOW" : `TRY ${option.index + 1}`}</b></button>)}</div>
    </section>}
    {guideOpen && <section id="player-mini-guide" className="player-mini-guide" aria-label="Channel guide">
      <div className="mini-guide-head">
        <span><Broadcast weight="fill" /><strong>Live channel guide</strong></span>
        <button aria-label="Close channel guide" onClick={() => setGuideOpen(false)}><X /></button>
      </div>
      <div className="mini-guide-zap">
        <button onClick={() => onStepChannel(-1)}><CaretLeft /> Previous channel</button>
        <button onClick={() => onStepChannel(1)}>Next channel <CaretRight /></button>
      </div>
      <label className="mini-guide-search"><MagnifyingGlass /><input autoFocus value={guideQuery} onChange={(event) => setGuideQuery(event.target.value)} placeholder="Search channels, networks or countries" />{guideQuery && <button aria-label="Clear channel search" onClick={() => setGuideQuery("")}><X /></button>}</label>
      <div className="mini-guide-list">
        {guideChannels.map((candidate) => {
          const programme = guideProgrammeByChannel.get(candidate.id);
          const availability = availabilityByChannel[candidate.key] || "unverified";
          return <button key={candidate.key} className={candidate.key === channel.key ? "active" : ""} onClick={() => { setGuideOpen(false); onSelectChannel(candidate); }}>
            <img src={candidate.logo || BRAND_ICON} alt="" onError={(event) => { event.currentTarget.src = BRAND_ICON; }} />
            <span><strong>{candidate.name}</strong><small>{programme?.title || "Live broadcast"}</small></span>
            <b className={`availability-${availability}`}>{candidate.key === channel.key ? "NOW" : availabilityLabel(availability)}</b>
          </button>;
        })}
        {!guideChannels.length && <p>No channels match that search.</p>}
      </div>
    </section>}
    {zapNotice && <div className="zap-osd" role="status">{zapNotice}</div>}
    <div className="player-info">
      <span className="overline"><Broadcast weight="fill" /> Live · {countryName(channel.country)}</span>
      <h1>{now?.title || channel.name}</h1>
      <h2>{channel.name}</h2>
      {now?.description && <p>{now.description}</p>}
      <div className="player-tags">
        <span>{source?.quality || channelQuality(channel)}</span>
        {channel.categories.map((item) => <span key={item}>{titleCase(item)}</span>)}
        {(source?.label || source?.title) && <span>{source.label || source.title}</span>}
        {source?.provenance && <span>{source.provenance}</span>}
      </div>
      {channelWebsite && <button className="player-website" onClick={() => onOpenWebsite(channelWebsite, channel.name)}><ArrowSquareOut weight="bold" /> Open {new URL(channelWebsite).hostname.replace(/^www\./i, "")}</button>}
      {next && <div className="up-next"><Clock /><span><small>UP NEXT · {formatTime(new Date(next.start))}</small><strong>{next.title}</strong></span></div>}
    </div>
    <div className="player-controls" onPointerDown={(event) => event.stopPropagation()}>
      {hasFiniteDuration
        ? <input className="player-progress" type="range" min="0" max={duration} step="0.1" value={Math.min(currentTime, duration)} aria-label="Playback position" onChange={(event) => { if (videoRef.current) videoRef.current.currentTime = Number(event.target.value); }} />
        : <div className="player-live-progress"><span /></div>}
      <div className="player-control-row">
        <button aria-label={paused ? "Play" : "Pause"} title={paused ? "Play (Space)" : "Pause (Space)"} onClick={togglePlayback}>{paused ? <Play weight="fill" /> : <Pause weight="fill" />}</button>
        <button aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute (M)" : "Mute (M)"} onClick={toggleMute}>{muted || volume === 0 ? <SpeakerSlash /> : <SpeakerHigh />}</button>
        <input className="player-volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} aria-label="Volume" onChange={(event) => { const video = videoRef.current; if (!video) return; video.volume = Number(event.target.value); video.muted = false; }} />
        <span className="player-time">{hasFiniteDuration ? `${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}` : "LIVE"}</span>
        <span className="player-control-spacer" />
        <button aria-label="Open channel guide" title="Channel guide (G)" className={guideOpen ? "active" : ""} onClick={() => { setGuideOpen((open) => !open); closeSettings(); setSourcesOpen(false); }}><CalendarDots /></button>
        <button aria-label="Subtitles" title="Subtitles (C)" className={activeSubtitle !== "Off" ? "active" : ""} onClick={() => { setSettingsOpen(true); setMenuPage("subtitles"); setGuideOpen(false); setSourcesOpen(false); }}><ClosedCaptioning weight={activeSubtitle !== "Off" ? "fill" : "regular"} /></button>
        <button aria-label={pictureInPicture ? "Close picture in picture" : "Picture in picture"} title="Picture in picture" className={pictureInPicture ? "active" : ""} onClick={togglePictureInPicture}><PictureInPicture /></button>
        <button aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"} onClick={toggleFullscreen}>{fullscreen ? <CornersIn /> : <CornersOut />}</button>
        <button aria-label="Playback settings" title="Playback settings" aria-expanded={settingsOpen} className={settingsOpen ? "active" : ""} onClick={() => { setSettingsOpen((open) => !open); setMenuPage(null); setGuideOpen(false); setSourcesOpen(false); }}><DotsThreeVertical weight="bold" /></button>
      </div>
    </div>
    {settingsOpen && <div className="player-settings" role="dialog" aria-label="Playback settings">
      <div className="player-settings-main">
        <button onClick={() => setMenuPage("subtitles")}><ClosedCaptioning /><span><strong>Subtitles</strong><small>{activeSubtitle}</small></span><CaretLeft /></button>
        <button onClick={() => setMenuPage("quality")}><Gauge /><span><strong>Streaming quality</strong><small>{activeQuality}</small></span><CaretLeft /></button>
        <button onClick={() => setMenuPage("audio")}><SpeakerHigh /><span><strong>Audio language</strong><small>{activeAudio}</small></span><CaretLeft /></button>
        <button onClick={() => setMenuPage("speed")}><Play /><span><strong>Playback speed</strong><small>{playbackRate === 1 ? "Normal" : `${playbackRate}×`}</small></span><CaretLeft /></button>
        <button onClick={() => setMenuPage("source")}><Broadcast /><span><strong>Playback source</strong><small>{playback.sourceTotal ? `Route ${playback.sourceNumber} of ${playback.sourceTotal}` : "Unavailable"}</small></span><CaretLeft /></button>
        <button disabled={!document.pictureInPictureEnabled} onClick={() => { togglePictureInPicture(); closeSettings(); }}><PictureInPicture /><span><strong>Picture in picture</strong><small>{document.pictureInPictureEnabled ? (pictureInPicture ? "Close floating player" : "Open floating player") : "Not available in this browser"}</small></span></button>
      </div>
      {menuPage && <div className="player-settings-submenu">
        <header><button aria-label="Back to playback settings" onClick={() => setMenuPage(null)}><CaretRight /></button><strong>{menuTitle}</strong></header>
        <div>
          {menuPage === "subtitles" && playback.subtitleOptions.map((option) => <button key={option.id} className={option.active ? "active" : ""} onClick={() => playback.selectSubtitle(option.id)}><span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>{option.active && <CheckCircle weight="fill" />}</button>)}
          {menuPage === "quality" && playback.qualityOptions.map((option) => <button key={option.id} className={option.active ? "active" : ""} onClick={() => playback.selectQuality(option.id)}><span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>{option.active && <CheckCircle weight="fill" />}</button>)}
          {menuPage === "audio" && playback.audioOptions.map((option) => <button key={option.id} className={option.active ? "active" : ""} onClick={() => playback.selectAudio(option.id)}><span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>{option.active && <CheckCircle weight="fill" />}</button>)}
          {menuPage === "speed" && PLAYER_SPEEDS.map((speed) => <button key={speed} className={playbackRate === speed ? "active" : ""} onClick={() => { if (videoRef.current) videoRef.current.playbackRate = speed; }}><span><strong>{speed === 1 ? "Normal" : `${speed}×`}</strong></span>{playbackRate === speed && <CheckCircle weight="fill" />}</button>)}
          {menuPage === "source" && playback.sourceOptions.map((option) => <button key={`${option.sourceId}-${option.index}`} className={option.active ? "active" : ""} onClick={() => playback.selectSource(option.index)}><span><strong>{option.label}</strong><small>{option.detail}</small></span>{option.active && <CheckCircle weight="fill" />}</button>)}
          {unavailableCopy && <p>{unavailableCopy}</p>}
        </div>
      </div>}
    </div>}
    {busy && <div className="player-status" aria-live="polite">
      <SpinnerGap className="spin" />
      <strong>{playback.status === "switching" ? "Finding a working source" : "Starting live playback"}</strong>
      <span>{playback.message}</span>
    </div>}
    {playback.status === "interaction-required" && <div className="player-error player-prompt">
      <Play weight="fill" />
      <h2>Ready when you are</h2>
      <p>{playback.message}</p>
      <div className="player-error-actions"><button onClick={playback.resume}><Play weight="fill" /> Play now</button><button className="quiet" onClick={onClose}>Return</button></div>
    </div>}
    {playback.status === "failed" && <div className="player-error">
      <WarningCircle weight="fill" />
      <h2>{externalOnly
        ? "This channel currently uses an external streaming protocol"
        : playback.sourceTotal === 0
        ? "No live source is listed"
        : playback.sourceTotal === 1
          ? "This channel’s source could not play"
          : "No working playback route was found"}</h2>
      <p>{playback.message}</p>
      <div className="player-error-actions">
        <button onClick={playback.retry}><ArrowsClockwise /> Retry</button>
        {playback.canNext && <button onClick={playback.next}><CaretRight /> Next route</button>}
        {channelWebsite && <button className="quiet" onClick={() => onOpenWebsite(channelWebsite, channel.name)}><ArrowSquareOut /> Channel website</button>}
        <button className="quiet" onClick={onClose}>Return</button>
      </div>
      {latestDiagnostic && <details className="player-diagnostics">
        <summary>Playback details</summary>
        <code>{latestDiagnostic.delivery ? `${latestDiagnostic.delivery.toUpperCase()} · ` : ""}{latestDiagnostic.transport.toUpperCase()} · {latestDiagnostic.phase}{latestDiagnostic.httpStatus ? ` · HTTP ${latestDiagnostic.httpStatus}` : ""} · {latestDiagnostic.reason} · {latestDiagnostic.endpoint}</code>
        <small>No credentials, headers, paths, or URL query values are included.</small>
      </details>}
    </div>}
  </div>;
}

function SourceDialog({ sourceUrl, setSourceUrl, epgUrl, setEpgUrl, loading, onClose, onPlaylistUrl, onPlaylistFile, onEpgUrl, onEpgFile }: { sourceUrl: string; setSourceUrl: (value: string) => void; epgUrl: string; setEpgUrl: (value: string) => void; loading: boolean; onClose: () => void; onPlaylistUrl: () => void; onPlaylistFile: (file: File) => void; onEpgUrl: () => void; onEpgFile: (file: File) => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocusTrap(dialogRef, onClose);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} className="source-dialog" role="dialog" aria-modal="true" aria-labelledby="source-dialog-title">
      <button type="button" className="dialog-close" aria-label="Close source dialog" onClick={onClose}><X /></button>
      <span className="overline"><CloudArrowUp /> Optional personal sources</span>
      <h2 id="source-dialog-title">Expand CrowFlix</h2>
      <p>The complete worldwide catalogue and automatic guide are already included. Personal files are read on this device; public source URLs are fetched through the bounded CrowFlix relay for browser compatibility.</p>
      <div className="source-section">
        <label htmlFor="personal-playlist-url">Personal M3U playlist URL</label>
        <div><input id="personal-playlist-url" type="url" inputMode="url" autoComplete="off" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://example.com/playlist.m3u" /><button type="button" onClick={onPlaylistUrl} disabled={loading}>{loading ? <SpinnerGap className="spin" /> : "Add"}</button></div>
        <label className="file-control"><CloudArrowUp /> Choose M3U file<input type="file" accept=".m3u,.m3u8,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) onPlaylistFile(file); }} /></label>
      </div>
      <div className="source-section">
        <label htmlFor="personal-epg-url">Personal XMLTV guide URL</label>
        <div><input id="personal-epg-url" type="url" inputMode="url" autoComplete="off" value={epgUrl} onChange={(event) => setEpgUrl(event.target.value)} placeholder="https://example.com/guide.xml" /><button type="button" onClick={onEpgUrl} disabled={loading}>{loading ? <SpinnerGap className="spin" /> : "Add"}</button></div>
        <label className="file-control"><CalendarDots /> Choose XMLTV file<input type="file" accept=".xml,.xmltv,text/xml" onChange={(event) => { const file = event.target.files?.[0]; if (file) onEpgFile(file); }} /></label>
      </div>
      <small className="source-privacy">Use public HTTP(S) URLs only. Personal imports stay in this browser session and never replace the built-in catalogue.</small>
    </section>
  </div>;
}

function LoadingOverlay({ message }: { message: string }) { return <div className="loading-overlay"><img src={BRAND_ICON} alt="" /><div className="loading-ring" /><h2>{message}</h2><p>Building your live television universe</p></div>; }

function EmptyState({ title, copy, action, onAction }: { title: string; copy: string; action?: string; onAction?: () => void }) { return <div className="empty-state"><img src={BRAND_ICON} alt="" /><h2>{title}</h2><p>{copy}</p>{action && <button className="primary" onClick={onAction}>{action}</button>}</div>; }
