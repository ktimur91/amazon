import type {
  ActivityEventInput,
  DemandResult,
  ListingResult,
  Marketplace,
  ReviewStats,
  ReviewVerdict,
} from "./messages";
import type { LocaleCode } from "./i18n";

/// Site/group label from a product URL, e.g. "amazon.com", "amazon.co.uk".
function siteFromUrl(input: string): string | undefined {
  try {
    return new URL(input).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/// Mirror an activity event to the account history. Relayed to the background
/// (content-script fetches to the API are blocked by CORS on prod); best-effort,
/// so a failure never affects the UX.
function mirrorEvent(event: ActivityEventInput): void {
  // Clamp lengths so the backend never rejects (400) an event — long
  // marketplace URLs/titles were silently dropping events from the dashboard.
  const safe: ActivityEventInput = {
    ...event,
    ...(event.productRef ? { productRef: event.productRef.slice(0, 2000) } : {}),
    ...(event.title ? { title: event.title.slice(0, 500) } : {}),
    ...(event.imageUrl ? { imageUrl: event.imageUrl.slice(0, 2000) } : {}),
  };
  void chrome.runtime.sendMessage({ type: "POST_EVENT", event: safe }).catch(() => {});
}

// One unified, typed history: every action (media download / review analysis /
// AI listing) on a product is its own re-viewable entry. Keyed by
// product+type+language so the SAME product keeps separate analysis/listing
// versions per language (and re-doing one updates that one in place).
const HISTORY_KEY = "lz_history_v2";
const PENDING_ACTION_KEY = "lz_analysis_pending_action_v1";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HISTORY = 80;

export type HistoryType = "download" | "analysis" | "listing" | "demand";

export interface AnalysisPayload {
  summary: string;
  issues: string[];
  pros: string[];
  cons: string[];
  verdict: ReviewVerdict;
  stats: ReviewStats | null;
  count?: number;
}

export interface DownloadPayload {
  photos: number;
  videos: number;
}

export interface HistoryEntry {
  key: string; // productId :: type :: locale("" for download)
  productId: string;
  url: string;
  productTitle: string;
  imageUrl?: string;
  marketplace: Marketplace;
  type: HistoryType;
  locale?: LocaleCode; // present for analysis / listing
  createdAt: number;
  analysis?: AnalysisPayload;
  listing?: ListingResult;
  download?: DownloadPayload;
  demand?: DemandResult;
}

export function productIdFromUrl(input: string): string {
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return input.split(/[?#]/)[0].replace(/\/$/, "");
  }
}

function entryKey(
  productId: string,
  type: HistoryType,
  locale?: LocaleCode,
  variant?: string, // listing: the preset id (so WB·RU and FB·RU are separate)
): string {
  if (type === "download") return `${productId}::download`;
  return `${productId}::${type}::${locale ?? ""}::${variant ?? ""}`;
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<HistoryEntry>;
  return (
    typeof e.key === "string" &&
    typeof e.productId === "string" &&
    typeof e.url === "string" &&
    typeof e.type === "string" &&
    typeof e.createdAt === "number"
  );
}

function freshOnly(items: HistoryEntry[], now = Date.now()): HistoryEntry[] {
  return items
    .filter((item) => now - item.createdAt <= TTL_MS)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_HISTORY);
}

async function rawHistory(): Promise<HistoryEntry[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const value = stored[HISTORY_KEY];
  return Array.isArray(value) ? value.filter(isHistoryEntry) : [];
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const raw = await rawHistory();
  const fresh = freshOnly(raw);
  if (fresh.length !== raw.length) {
    await chrome.storage.local.set({ [HISTORY_KEY]: fresh });
  }
  return fresh;
}

// Upsert by key (newest wins) and persist.
async function upsert(entry: HistoryEntry): Promise<HistoryEntry> {
  const history = await getHistory();
  const next = freshOnly([
    entry,
    ...history.filter((e) => e.key !== entry.key),
  ]);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return entry;
}

interface BaseInput {
  url: string;
  productTitle: string;
  imageUrl?: string;
  marketplace: Marketplace;
}

export async function saveCachedAnalysis(
  input: BaseInput & { locale: LocaleCode } & AnalysisPayload,
): Promise<HistoryEntry> {
  const productId = productIdFromUrl(input.url);
  const entry: HistoryEntry = {
    key: entryKey(productId, "analysis", input.locale),
    productId,
    url: input.url,
    productTitle: input.productTitle,
    ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
    marketplace: input.marketplace,
    type: "analysis",
    locale: input.locale,
    createdAt: Date.now(),
    analysis: {
      summary: input.summary,
      issues: [...input.issues],
      pros: [...input.pros],
      cons: [...input.cons],
      verdict: input.verdict,
      stats: input.stats ? { ...input.stats } : null,
      ...(typeof input.count === "number" ? { count: input.count } : {}),
    },
  };
  await upsert(entry);
  mirrorEvent({
    type: "analysis",
    group: siteFromUrl(entry.url),
    language: entry.locale,
    productRef: entry.productId,
    title: entry.productTitle,
    imageUrl: entry.imageUrl,
    payload: entry.analysis,
  });
  return entry;
}

export async function saveCachedListing(
  input: BaseInput & { locale: LocaleCode; listing: ListingResult },
): Promise<HistoryEntry> {
  const productId = productIdFromUrl(input.url);
  const entry: HistoryEntry = {
    key: entryKey(productId, "listing", input.locale, input.listing.presetId ?? "universal"),
    productId,
    url: input.url,
    productTitle: input.productTitle,
    ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
    marketplace: input.marketplace,
    type: "listing",
    locale: input.locale,
    createdAt: Date.now(),
    listing: input.listing,
  };
  await upsert(entry);
  mirrorEvent({
    type: "listing",
    group: siteFromUrl(entry.url),
    language: entry.locale,
    productRef: entry.productId,
    title: entry.productTitle,
    imageUrl: entry.imageUrl,
    payload: entry.listing,
  });
  return entry;
}

export async function saveCachedDemand(
  input: BaseInput & { locale: LocaleCode; demand: DemandResult },
): Promise<HistoryEntry> {
  const productId = productIdFromUrl(input.url);
  const entry: HistoryEntry = {
    key: entryKey(productId, "demand", input.locale),
    productId,
    url: input.url,
    productTitle: input.productTitle,
    ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
    marketplace: input.marketplace,
    type: "demand",
    locale: input.locale,
    createdAt: Date.now(),
    demand: input.demand,
  };
  await upsert(entry);
  mirrorEvent({
    type: "demand",
    group: siteFromUrl(entry.url),
    language: entry.locale,
    productRef: entry.productId,
    title: entry.productTitle,
    imageUrl: entry.imageUrl,
    payload: entry.demand,
  });
  return entry;
}

export async function markMediaDownloaded(
  url: string,
  title?: string,
  imageUrl?: string,
  counts?: DownloadPayload,
  marketplace: Marketplace = "unknown",
): Promise<void> {
  const productId = productIdFromUrl(url);
  const entry: HistoryEntry = {
    key: entryKey(productId, "download"),
    productId,
    url,
    productTitle: title ?? "",
    ...(imageUrl ? { imageUrl } : {}),
    marketplace,
    type: "download",
    createdAt: Date.now(),
    download: counts ?? { photos: 0, videos: 0 },
  };
  await upsert(entry);
  mirrorEvent({
    type: "download",
    group: siteFromUrl(url),
    productRef: productId,
    title,
    imageUrl,
    payload: entry.download,
  });
}

// Per-language lookups: a cached analysis/listing is only reused when it matches
// BOTH the product AND the current UI language (the language bug fix).
export async function getCachedAnalysis(
  url: string,
  locale: LocaleCode,
): Promise<HistoryEntry | null> {
  const key = entryKey(productIdFromUrl(url), "analysis", locale);
  return (await getHistory()).find((e) => e.key === key) ?? null;
}

export async function getCachedListing(
  url: string,
  presetId: string,
  locale: LocaleCode,
): Promise<HistoryEntry | null> {
  const key = entryKey(productIdFromUrl(url), "listing", locale, presetId);
  return (await getHistory()).find((e) => e.key === key) ?? null;
}

export async function getCachedDemand(
  url: string,
  locale: LocaleCode,
): Promise<HistoryEntry | null> {
  const key = entryKey(productIdFromUrl(url), "demand", locale);
  return (await getHistory()).find((e) => e.key === key) ?? null;
}

export async function wasMediaDownloaded(url: string): Promise<boolean> {
  const key = entryKey(productIdFromUrl(url), "download");
  return (await getHistory()).some((e) => e.key === key);
}

export function onHistoryChanged(cb: () => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[HISTORY_KEY]) cb();
  });
}

// --- Pending cross-tab action (open/rerun on the product's own page) ---------

export type PendingAnalysisAction = {
  productId: string;
  action: "open" | "analyze";
  createdAt: number;
};

export async function setPendingAnalysisAction(
  action: PendingAnalysisAction,
): Promise<void> {
  await chrome.storage.local.set({ [PENDING_ACTION_KEY]: action });
}

export async function consumePendingAnalysisAction(
  productId: string,
): Promise<PendingAnalysisAction | null> {
  const stored = await chrome.storage.local.get(PENDING_ACTION_KEY);
  const action = stored[PENDING_ACTION_KEY] as PendingAnalysisAction | undefined;
  if (
    !action ||
    action.productId !== productId ||
    Date.now() - action.createdAt > 60_000
  ) {
    return null;
  }
  await chrome.storage.local.remove(PENDING_ACTION_KEY);
  return action;
}
