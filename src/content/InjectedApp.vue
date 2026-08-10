<script setup lang="ts">
import {
  Check,
  CircleCheck,
  CircleMinus,
  Copy,
  ExternalLink,
  FileArchive,
  FileText,
  Files,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  Info,
  ShieldCheck,
  Sparkles,
  Tags,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  Video as VideoIcon,
  X,
} from "@lucide/vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import HelperPanel from "../components/HelperPanel.vue";
import {
  consumePendingAnalysisAction,
  getCachedAnalysis,
  getCachedDemand,
  getCachedListing,
  getHistory,
  markMediaDownloaded,
  onHistoryChanged,
  productIdFromUrl,
  saveCachedAnalysis,
  saveCachedDemand,
  saveCachedListing,
  setPendingAnalysisAction,
  wasMediaDownloaded,
  type HistoryEntry,
} from "../lib/analysisCache";
import { getAdapterByHost } from "../marketplaces";
import {
  getStoredLocale,
  languageForAi,
  LOCALES,
  onStoredLocaleChanged,
  setStoredLocale,
  t,
  type LocaleCode,
} from "../lib/i18n";
import {
  getFloatingPanelEnabled,
  onFloatingPanelChanged,
  setFloatingPanelEnabled,
} from "../lib/settings";
import { getStoredInstallId } from "../lib/api/backend";
import type { RequestMessage, ResponseMessage } from "../lib/messages";
import type {
  DemandResult,
  FeatureQuotas,
  ListingContext,
  ListingPreset,
  ListingResult,
  QuotaFeature,
  ReviewStats,
  ReviewVerdict,
} from "../lib/messages";

const DEFAULT_QUOTAS: FeatureQuotas = {
  analysis: { used: 0, limit: 10 },
  listing: { used: 0, limit: 3 },
  demand: { used: 0, limit: 2 },
};

const OFFICIAL_SITE_URL = "https://helptools.org";

type Status = {
  pro: boolean;
  quotas: FeatureQuotas;
  resetAt: number | null;
  proExpiresAt: number | null;
  status: string | null;
  customerPortalUrl: string | null;
  email: string | null;
  deviceName: string | null;
  online: boolean;
};
type PanelMessage = { kind: "ok" | "err"; text: string } | null;
type ContentCommand = {
  type:
    | "UI_DOWNLOAD_MEDIA"
    | "UI_ANALYZE_REVIEWS"
    | "UI_ANALYZE_REVIEWS_FORCE"
    | "UI_GENERATE_LISTING"
    | "UI_ANALYZE_DEMAND"
    | "UI_OPEN_CACHED_ANALYSIS";
};

// The adapter for the current site; null only if the content script somehow
// runs off a supported marketplace (it's matched to those hosts in the manifest).
const adapter = getAdapterByHost();
const marketplace = adapter?.id ?? "unknown";
const open = ref(false);
const downloading = ref(false);
const analyzing = ref(false);
const mediaDownloaded = ref(false);
const error = ref<string | null>(null);
const panelMessage = ref<PanelMessage>(null);
const status = ref<Status>({
  pro: false,
  quotas: { ...DEFAULT_QUOTAS },
  resetAt: null,
  proExpiresAt: null,
  status: null,
  customerPortalUrl: null,
  email: null,
  deviceName: null,
  online: true,
});
const locale = ref<LocaleCode>("en");
const floatingEnabled = ref(true);
const history = ref<HistoryEntry[]>([]);
// The product currently open — drives the "done" stepper state in HelperPanel.
// Updated on SPA navigation (AliExpress don't reload between products).
const currentProductId = ref<string>(productIdFromUrl(location.href));

const tr = (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) =>
  t(locale.value, key, params);

// Result modal
const showResult = ref(false);
const isUpgrade = ref(false);
const resultTitle = ref("");
const resultText = ref("");
const resultIssues = ref<string[]>([]);
const resultPros = ref<string[]>([]);
const resultCons = ref<string[]>([]);
const resultVerdict = ref<ReviewVerdict>("no_data");
const resultStats = ref<ReviewStats | null>(null);

// Media download result modal (separate from the analysis modal).
const showDownload = ref(false);
const dlPhotos = ref(0);
const dlVideos = ref(0);
const dlTotal = ref(0);
const dlZipName = ref("");

// AI listing generator (PRO feature): result modal + copy-button feedback.
const generatingListing = ref(false);
const showListing = ref(false);
const listing = ref<ListingResult | null>(null);
const copiedKey = ref<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

// Demand research: result modal.
const analyzingDemand = ref(false);
const showDemand = ref(false);
const demand = ref<DemandResult | null>(null);

// SPA navigation watcher (AliExpress don't reload between products).
let lastUrl = "";
let urlWatcher: number | null = null;

// Listing config modal: choose target platform (preset), output language and
// optional extra rules before generating; PRO can save a custom preset.
const LAST_PRESET_KEY = "lz_last_preset_v1";
const showListingConfig = ref(false);
const presets = ref<ListingPreset[]>([]);
const loadingPresets = ref(false);
const selectedPresetId = ref("universal");
const listingLang = ref<LocaleCode>("en");
const extraInstructions = ref("");
const showSavePreset = ref(false);
const newPresetName = ref("");
const savingPreset = ref(false);
const selectedIsCustom = computed(
  () => presets.value.find((p) => p.id === selectedPresetId.value)?.custom ?? false,
);

const verdictUi = computed(() => {
  if (resultVerdict.value === "excellent") {
    return {
      label: "Looks good",
      card: "tw-border-emerald-200 tw-bg-emerald-50",
      icon: "tw-bg-emerald-600 tw-text-white",
      accent: "tw-text-emerald-700",
    };
  }
  if (resultVerdict.value === "poor") {
    return {
      label: "High risk",
      card: "tw-border-red-200 tw-bg-red-50",
      icon: "tw-bg-red-600 tw-text-white",
      accent: "tw-text-red-700",
    };
  }
  if (resultVerdict.value === "mixed") {
    return {
      label: "Mixed signal",
      card: "tw-border-amber-200 tw-bg-amber-50",
      icon: "tw-bg-amber-500 tw-text-white",
      accent: "tw-text-amber-700",
    };
  }
  return {
    label: "Not enough data",
    card: "tw-border-slate-200 tw-bg-slate-50",
    icon: "tw-bg-slate-600 tw-text-white",
    accent: "tw-text-slate-700",
  };
});

function resetResult(): void {
  isUpgrade.value = false;
  resultPros.value = [];
  resultCons.value = [];
  resultIssues.value = [];
  resultVerdict.value = "no_data";
  resultStats.value = null;
}

const verdictTitle = computed(() => {
  if (resultVerdict.value === "excellent") return tr("excellent");
  if (resultVerdict.value === "poor") return tr("poor");
  if (resultVerdict.value === "mixed") return tr("mixed");
  return tr("noData");
});

const modalTitle = computed(() =>
  resultStats.value ? verdictTitle.value : resultTitle.value,
);

function currentProductTitle(): string {
  // Prefer the marketplace adapter's own selector (Amazon: #productTitle) — a
  // generic <h1> grab picks up the wrong heading on Amazon. Fall back to the
  // page title (strip the "Amazon.com: … : Electronics" chrome) then the URL.
  const fromAdapter = adapter?.productTitle?.()?.trim();
  const heading = document.querySelector("h1")?.textContent?.trim();
  const docTitle = document.title
    .replace(/^Amazon\.[a-z.]+\s*:\s*/i, "")
    .replace(/\s*:\s*[^:]*$/, "")
    .replace(/\s*\|\s*.*$/, "")
    .trim();
  return fromAdapter || heading || docTitle || location.href;
}

// Filesystem-safe ZIP base name from the product title — stable across
// re-downloads (no timestamp), so the browser flags a duplicate. Keeps unicode
// letters; strips only the characters that are illegal in filenames.
function slugifyTitle(title: string): string {
  return title
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/// Best-effort main product image URL for history thumbnails. We never store the
/// file — just the link — so the dashboard/panel can show what the product is.
/// Amazon has NO og:image and a generic <img> scan grabs the nav sprite, so we
/// take the adapter's own gallery first (the real product image), then
/// #landingImage, then og:image, then a filtered large content image.
function currentProductImage(): string | undefined {
  const ok = (s?: string | null): string | undefined =>
    s && /^https?:\/\//.test(s) ? s : undefined;

  const fromAdapter = adapter?.parseMedia?.().find((m) => m.type === "image")?.url;
  if (ok(fromAdapter)) return fromAdapter;

  const landing = document.querySelector<HTMLImageElement>("#landingImage");
  const landingSrc = ok(landing?.currentSrc || landing?.src);
  if (landingSrc) return landingSrc;

  const og = document
    .querySelector<HTMLMetaElement>('meta[property="og:image"], meta[name="og:image"]')
    ?.content?.trim();
  if (ok(og)) return og;

  // Last resort: a large content image that isn't an Amazon sprite/nav/icon.
  const candidate = Array.from(document.querySelectorAll<HTMLImageElement>("img")).find((img) => {
    const s = img.currentSrc || img.src;
    return (
      ok(s) &&
      !/sprite|nav-sprite|\/gno\/|\/icons?\//i.test(s) &&
      img.naturalWidth >= 200 &&
      img.naturalHeight >= 200
    );
  });
  return ok(candidate?.currentSrc || candidate?.src);
}

function showCachedAnalysis(entry: HistoryEntry): void {
  const a = entry.analysis;
  if (!a) return;
  resetResult();
  resultVerdict.value = a.verdict;
  resultStats.value = a.stats;
  resultTitle.value = verdictTitle.value;
  resultText.value = a.summary;
  resultIssues.value = a.issues;
  resultPros.value = a.pros;
  resultCons.value = a.cons;
  panelMessage.value = { kind: "ok", text: tr("cachedAnalysisNotice") };
  showResult.value = true;
}

function send<T extends ResponseMessage = ResponseMessage>(
  msg: RequestMessage,
): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r: T) => resolve(r));
  });
}

async function refreshStatus(): Promise<void> {
  locale.value = await getStoredLocale();
  floatingEnabled.value = await getFloatingPanelEnabled();
  const r = await send({ type: "QUOTA_GET" });
  if (r.ok && "quotas" in r) {
    status.value = {
      pro: r.pro,
      quotas: r.quotas,
      resetAt: r.resetAt,
      proExpiresAt: r.proExpiresAt,
      status: r.status,
      customerPortalUrl: r.customerPortalUrl,
      email: r.email,
      deviceName: r.deviceName,
      online: r.online,
    };
  }
}

// Re-sync entitlement every time the panel is opened so a subscription change
// (cancel/expire/renew) is reflected without needing a full page reload.
function togglePanel(): void {
  open.value = !open.value;
  if (open.value) void refreshStatus();
}

function quotaExhausted(feature: QuotaFeature): boolean {
  const q = status.value.quotas[feature];
  return !status.value.pro && q.used >= q.limit;
}

async function onDownloadMedia(): Promise<void> {
  error.value = null;
  panelMessage.value = null;
  if (downloading.value) return;
  // Media download is always free and unlimited; the daily quota only gates
  // review analysis (see onAnalyzeReviews).
  downloading.value = true;
  try {
    const items = adapter ? adapter.parseMedia() : [];
    // Name the ZIP after the product title (stable → the browser flags a
    // re-download as a duplicate); fall back to the URL slug.
    const slug =
      slugifyTitle(currentProductTitle()) ||
      (adapter ? adapter.productSlug(location.href) : "product");
    const r = await send({ type: "DOWNLOAD_MEDIA", items, productSlug: slug });
    if (!r.ok) throw new Error(("error" in r && r.error) || "Download failed");
    // Prefer the counts the background reports — for AliExpress it reads the gallery from the
    // item-API gallery, not the DOM `items` collected here (which include junk).
    const photos =
      "photos" in r && typeof r.photos === "number"
        ? r.photos
        : items.filter((m) => m.type === "image").length;
    const videos =
      "videos" in r && typeof r.videos === "number"
        ? r.videos
        : items.filter((m) => m.type === "video").length;
    await markMediaDownloaded(
      location.href,
      currentProductTitle(),
      currentProductImage(),
      { photos, videos },
      marketplace,
    );
    mediaDownloaded.value = true;
    dlPhotos.value = photos;
    dlVideos.value = videos;
    dlTotal.value = photos + videos;
    dlZipName.value = "zipName" in r ? r.zipName : "";
    showDownload.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    downloading.value = false;
    await refreshStatus();
  }
}

async function onAnalyzeReviews(
  options: { force?: boolean } = {},
): Promise<void> {
  error.value = null;
  panelMessage.value = null;
  resetResult();
  if (analyzing.value) return;
  if (!options.force) {
    const cached = await getCachedAnalysis(location.href, locale.value);
    if (cached) {
      showCachedAnalysis(cached);
      return;
    }
  }
  if (quotaExhausted("analysis")) return showUpgrade("analysis");
  analyzing.value = true;
  try {
    const r = await send({
      type: "FETCH_AND_ANALYZE",
      url: location.href,
      language: languageForAi(locale.value),
      locale: locale.value,
    });
    if (!r.ok) throw new Error(("error" in r && r.error) || "Analyze failed");

    resultVerdict.value = "verdict" in r && r.verdict ? r.verdict : "no_data";
    resultStats.value = "stats" in r && r.stats ? r.stats : null;
    resultTitle.value = verdictTitle.value;
    resultText.value = "summary" in r ? r.summary : "Review analysis finished.";
    resultIssues.value = "issues" in r ? (r.issues as string[]) : [];
    resultPros.value = "pros" in r && r.pros ? (r.pros as string[]) : [];
    resultCons.value = "cons" in r && r.cons ? (r.cons as string[]) : [];
    await saveCachedAnalysis({
      url: location.href,
      productTitle: currentProductTitle(),
      imageUrl: currentProductImage(),
      marketplace,
      locale: locale.value,
      summary: resultText.value,
      issues: [...resultIssues.value],
      pros: [...resultPros.value],
      cons: [...resultCons.value],
      verdict: resultVerdict.value,
      stats: resultStats.value ? { ...resultStats.value } : null,
      count: "count" in r ? r.count : undefined,
    }).catch((cacheError: unknown) => {
      console.warn("[LZ-Helper] failed to save analysis cache", cacheError);
    });
    showResult.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    analyzing.value = false;
    await refreshStatus();
  }
}

// Demand research: a cached snapshot is reused per product + panel language;
// otherwise scrape the page signals and run the backend snapshot.
async function onAnalyzeDemand(): Promise<void> {
  error.value = null;
  panelMessage.value = null;
  if (analyzingDemand.value) return;
  const cached = await getCachedDemand(location.href, locale.value);
  if (cached?.demand) {
    demand.value = cached.demand;
    showDemand.value = true;
    open.value = false;
    return;
  }
  if (quotaExhausted("demand")) return showUpgrade("demand");
  analyzingDemand.value = true;
  try {
    const r = await send({
      type: "FETCH_DEMAND",
      url: location.href,
      productTitle: currentProductTitle(),
      language: languageForAi(locale.value),
    });
    if (!r.ok) {
      const msg = ("error" in r && r.error) || "Demand failed";
      if (msg === "QUOTA_EXCEEDED") return showUpgrade("demand");
      throw new Error(msg);
    }
    if ("demand" in r) {
      demand.value = r.demand;
      await saveCachedDemand({
        url: location.href,
        productTitle: currentProductTitle(),
        imageUrl: currentProductImage(),
        marketplace,
        locale: locale.value,
        demand: r.demand,
      }).catch(() => {});
      showDemand.value = true;
      open.value = false;
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    analyzingDemand.value = false;
    await refreshStatus();
  }
}

// Best-effort, marketplace-agnostic product context for the listing generator.
// Generic selectors only — if they don't match, the AI still works from the
// title. We deliberately skip price (too easy to scrape wrong).
async function collectProductContext(): Promise<ListingContext> {
  const ctx: ListingContext = {};
  const crumbs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[class*="breadcrumb" i] a, nav[aria-label*="readcrumb" i] a',
    ),
  )
    .map((a) => (a.textContent || "").trim())
    .filter((t) => t && t.length < 40);
  if (crumbs.length) ctx.category = crumbs.slice(-4).join(" > ");

  const attrs: string[] = [];
  document
    .querySelectorAll<HTMLElement>(
      '[class*="specification" i] li, [class*="attribute" i] li, [class*="spec" i] tr',
    )
    .forEach((el) => {
      const t = (el.innerText || "").trim().replace(/\s+/g, " ");
      if (t.length >= 3 && t.length <= 120) attrs.push(t);
    });
  if (attrs.length) ctx.attributes = [...new Set(attrs)].slice(0, 15);

  const cached = await getCachedAnalysis(location.href, locale.value);
  const a = cached?.analysis;
  if (a?.summary) {
    ctx.reviewSummary = [a.summary, ...(a.pros ?? []).slice(0, 3)]
      .join(" ")
      .slice(0, 600);
  }
  return ctx;
}

async function loadPresets(): Promise<void> {
  loadingPresets.value = true;
  try {
    const r = await send({ type: "LIST_PRESETS" });
    presets.value = r.ok && "presets" in r ? r.presets : [];
  } finally {
    loadingPresets.value = false;
  }
}

// "Create listing" opens the config modal first (platform + language + extra
// rules), not an immediate generation — the seller picks where they're reposting.
async function onGenerateListing(): Promise<void> {
  error.value = null;
  panelMessage.value = null;
  listingLang.value = locale.value;
  extraInstructions.value = "";
  showSavePreset.value = false;
  newPresetName.value = "";
  const stored = await chrome.storage.local.get(LAST_PRESET_KEY);
  selectedPresetId.value =
    typeof stored[LAST_PRESET_KEY] === "string" ? stored[LAST_PRESET_KEY] : "universal";
  showListingConfig.value = true;
  void loadPresets();
}

// The actual generation, triggered from the config modal's "Generate" button.
async function runGenerateListing(): Promise<void> {
  if (generatingListing.value) return;
  const presetId = selectedPresetId.value || "universal";
  const lang = listingLang.value;
  const extra = extraInstructions.value.trim();
  await chrome.storage.local.set({ [LAST_PRESET_KEY]: presetId });

  // Reuse a cached listing for the SAME product + preset + language (unless the
  // user added ad-hoc instructions, which always regenerate).
  if (!extra) {
    const cached = await getCachedListing(location.href, presetId, lang);
    if (cached?.listing) {
      listing.value = cached.listing;
      showListingConfig.value = false;
      showListing.value = true;
      return;
    }
  }
  if (quotaExhausted("listing")) {
    showListingConfig.value = false;
    return showUpgrade("listing");
  }
  generatingListing.value = true;
  try {
    const context = await collectProductContext();
    const r = await send({
      type: "GENERATE_LISTING",
      url: location.href,
      productTitle: currentProductTitle(),
      language: languageForAi(lang),
      presetId,
      extraInstructions: extra || undefined,
      context,
    });
    if (!r.ok) {
      const msg = ("error" in r && r.error) || "Generation failed";
      if (msg === "QUOTA_EXCEEDED") {
        showListingConfig.value = false;
        return showUpgrade("listing");
      }
      throw new Error(msg);
    }
    if ("listing" in r) {
      listing.value = r.listing;
      await saveCachedListing({
        url: location.href,
        productTitle: currentProductTitle(),
        imageUrl: currentProductImage(),
        marketplace,
        locale: lang, // the OUTPUT language, not the panel language
        listing: r.listing,
      }).catch(() => {});
      showListingConfig.value = false;
      showListing.value = true;
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    generatingListing.value = false;
    await refreshStatus();
  }
}

// Save the typed extra rules as a named custom preset (PRO + signed in).
async function saveCurrentPreset(): Promise<void> {
  const name = newPresetName.value.trim();
  if (!name) return;
  if (!status.value.pro) {
    showListingConfig.value = false;
    return showUpgrade();
  }
  savingPreset.value = true;
  try {
    // The preset captures the selected platform + the extra rules (if any).
    const r = await send({
      type: "SAVE_PRESET",
      preset: {
        name,
        basePresetId: selectedPresetId.value,
        instructions: extraInstructions.value.trim() || undefined,
      },
    });
    if (r.ok && "preset" in r) {
      await loadPresets();
      selectedPresetId.value = r.preset.id;
      showSavePreset.value = false;
      newPresetName.value = "";
    } else if (!r.ok && "error" in r) {
      if (r.error === "PRO_REQUIRED") {
        showListingConfig.value = false;
        showUpgrade();
      } else error.value = r.error;
    }
  } finally {
    savingPreset.value = false;
  }
}

async function removePreset(id: string): Promise<void> {
  await send({ type: "DELETE_PRESET", id });
  if (selectedPresetId.value === id) selectedPresetId.value = "universal";
  await loadPresets();
}

// Copy with a clipboard-API path + a hidden-textarea fallback (some pages block
// the async clipboard in injected content). Shows a transient "copied" check.
async function copyText(text: string, key: string): Promise<void> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch {
      ok = false;
    }
  }
  if (!ok) return;
  copiedKey.value = key;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copiedKey.value = null;
  }, 1500);
}

function listingFullText(): string {
  const l = listing.value;
  if (!l) return "";
  const parts = [l.title, "", l.description];
  if (l.bullets.length) parts.push("", ...l.bullets.map((b) => `• ${b}`));
  if (l.tags.length) parts.push("", l.tags.join(", "));
  return parts.join("\n");
}

// --- Demand modal formatting -------------------------------------------------
function fmtInt(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString(locale.value) : "—";
}
function fmtMoney(n: number | null | undefined, currency: string | null): string {
  if (typeof n !== "number") return "—";
  const s = n.toLocaleString(locale.value, { maximumFractionDigits: 2 });
  return currency ? `${s} ${currency}` : s;
}
const demandTone = computed(() => {
  const s = demand.value?.opportunityScore ?? 0;
  if (s >= 66)
    return { stroke: "tw-text-emerald-500", text: "tw-text-emerald-600", bar: "tw-bg-emerald-500", chip: "tw-bg-emerald-50 tw-text-emerald-700" };
  if (s >= 40)
    return { stroke: "tw-text-amber-500", text: "tw-text-amber-600", bar: "tw-bg-amber-500", chip: "tw-bg-amber-50 tw-text-amber-700" };
  return { stroke: "tw-text-slate-400", text: "tw-text-slate-500", bar: "tw-bg-slate-400", chip: "tw-bg-slate-100 tw-text-slate-600" };
});

function showUpgrade(feature?: QuotaFeature): void {
  resetResult();
  isUpgrade.value = true;
  resultTitle.value = tr("freeLimitReached");
  const q = feature ? status.value.quotas[feature] : null;
  resultText.value = tr("freeLimitText", {
    used: q ? q.used : 0,
    limit: q ? q.limit : 0,
    time: status.value.resetAt
      ? new Intl.DateTimeFormat(locale.value, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(status.value.resetAt))
      : "",
  });
  showResult.value = true;
}

async function updateLocale(next: LocaleCode): Promise<void> {
  locale.value = next;
  await setStoredLocale(next);
}

async function updateFloatingEnabled(enabled: boolean): Promise<void> {
  floatingEnabled.value = enabled;
  await setFloatingPanelEnabled(enabled);
}

async function refreshHistory(): Promise<void> {
  history.value = await getHistory();
}

async function refreshDownloaded(): Promise<void> {
  mediaDownloaded.value = await wasMediaDownloaded(location.href);
}

// Re-view a stored history result directly (the payload is cached locally, so no
// navigation is needed). For a media-download entry there is no saved result —
// open the product page so the user can re-download.
function viewHistoryEntry(entry: HistoryEntry): void {
  panelMessage.value = null;
  if (entry.type === "analysis" && entry.analysis) {
    showCachedAnalysis(entry);
    open.value = false;
  } else if (entry.type === "listing" && entry.listing) {
    listing.value = entry.listing;
    showListing.value = true;
    open.value = false;
  } else if (entry.type === "demand" && entry.demand) {
    demand.value = entry.demand;
    showDemand.value = true;
    open.value = false;
  } else {
    window.open(entry.url, "_blank", "noopener");
  }
}

async function openUpgrade(): Promise<void> {
  const installId = await getStoredInstallId();
  const url = new URL("https://helptools.org/extensions/amazon#pricing");
  url.searchParams.set("src", "ext-content");
  if (installId) url.searchParams.set("install", installId);
  window.open(url.toString(), "_blank", "noopener");
}

function commandListener(
  msg: ContentCommand,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: { ok: true } | { ok: false; error: string }) => void,
): boolean | undefined {
  if (
    msg.type !== "UI_DOWNLOAD_MEDIA" &&
    msg.type !== "UI_ANALYZE_REVIEWS" &&
    msg.type !== "UI_ANALYZE_REVIEWS_FORCE" &&
    msg.type !== "UI_GENERATE_LISTING" &&
    msg.type !== "UI_ANALYZE_DEMAND" &&
    msg.type !== "UI_OPEN_CACHED_ANALYSIS"
  ) {
    return undefined;
  }

  void (async () => {
    if (msg.type === "UI_DOWNLOAD_MEDIA") await onDownloadMedia();
    else if (msg.type === "UI_ANALYZE_REVIEWS_FORCE") {
      await onAnalyzeReviews({ force: true });
    } else if (msg.type === "UI_GENERATE_LISTING") {
      await onGenerateListing();
    } else if (msg.type === "UI_ANALYZE_DEMAND") {
      await onAnalyzeDemand();
    } else if (msg.type === "UI_OPEN_CACHED_ANALYSIS") {
      const cached = await getCachedAnalysis(location.href, locale.value);
      if (!cached) throw new Error(tr("noCachedAnalysis"));
      showCachedAnalysis(cached);
    } else await onAnalyzeReviews();
    sendResponse({ ok: true });
  })().catch((err: unknown) => {
    sendResponse({ ok: false, error: (err as Error).message });
  });

  return true;
}

onMounted(() => {
  void (async () => {
    await refreshStatus();
    await refreshHistory();
    await refreshDownloaded();
    const pending = await consumePendingAnalysisAction(
      productIdFromUrl(location.href),
    );
    if (!pending) return;
    if (pending.action === "open") {
      const cached = await getCachedAnalysis(location.href, locale.value);
      if (cached) showCachedAnalysis(cached);
      return;
    }
    await onAnalyzeReviews({ force: true });
  })();
  onStoredLocaleChanged((next) => {
    locale.value = next;
  });
  onFloatingPanelChanged((enabled) => {
    floatingEnabled.value = enabled;
    if (!enabled) open.value = false;
  });
  onHistoryChanged(() => {
    void refreshHistory();
    void refreshDownloaded();
  });
  chrome.runtime.onMessage.addListener(commandListener);

  // AliExpress are SPAs: navigating between products doesn't reload the page
  // (the content script stays mounted), so per-product UI must be re-evaluated
  // on URL change — otherwise the "Download media" button keeps its previous
  // product's "downloaded" state, and stale result modals linger.
  lastUrl = location.href;
  urlWatcher = window.setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    currentProductId.value = productIdFromUrl(location.href);
    showResult.value = false;
    showListing.value = false;
    showDownload.value = false;
    showListingConfig.value = false;
    showDemand.value = false;
    panelMessage.value = null;
    error.value = null;
    void refreshDownloaded();
  }, 700);
});

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(commandListener);
  if (urlWatcher) window.clearInterval(urlWatcher);
});
</script>

<template>
  <!-- Floating Action Button -->
  <div
    v-if="floatingEnabled"
    class="tw-fixed tw-bottom-6 tw-right-6 tw-z-[2147483646] tw-flex tw-flex-col tw-items-end tw-gap-2"
  >
    <transition name="fade">
      <div
        v-if="open || downloading || analyzing || analyzingDemand"
        class="tw-relative tw-w-[404px] tw-max-w-[calc(100vw-2rem)] tw-max-h-[calc(100vh-6rem)] tw-overflow-y-auto tw-origin-bottom-right tw-rounded-[20px] tw-bg-white tw-p-[18px] tw-text-sm tw-shadow-[0_1px_3px_rgba(20,20,40,0.1),0_12px_40px_rgba(20,20,40,0.12)] tw-ring-1 tw-ring-black/5"
      >
        <HelperPanel
          :locale="locale"
          :pro="status.pro"
          :quotas="status.quotas"
          :reset-at="status.resetAt"
          :pro-expires-at="status.proExpiresAt"
          :status="status.status"
          :customer-portal-url="status.customerPortalUrl"
          :email="status.email"
          :device-name="status.deviceName"
          :online="status.online"
          :downloading="downloading"
          :analyzing="analyzing"
          :generating-listing="generatingListing"
          :analyzing-demand="analyzingDemand"
          :downloaded="mediaDownloaded"
          :error="error"
          :message="panelMessage"
          :show-floating-toggle="false"
          :floating-enabled="floatingEnabled"
          :show-history="true"
          :history="history"
          :current-product-id="currentProductId"
          @update:locale="updateLocale"
          @update:floating-enabled="updateFloatingEnabled"
          @upgrade="openUpgrade"
          @refresh-status="refreshStatus"
          @auth-changed="refreshStatus"
          @download-media="onDownloadMedia"
          @analyze-reviews="onAnalyzeReviews"
          @generate-listing="onGenerateListing"
          @analyze-demand="onAnalyzeDemand"
          @view-entry="viewHistoryEntry"
        />
      </div>
    </transition>

    <button
      class="tw-flex tw-h-12 tw-w-12 tw-items-center tw-justify-center tw-rounded-full tw-bg-gradient-to-b tw-from-[#6366f1] tw-to-[#3730a3] tw-text-white tw-shadow-lg hover:tw-scale-105 tw-transition-transform"
      :title="open ? tr('closeHelper') : tr('openHelper')"
      @click="togglePanel"
    >
      <Plus v-if="!open" class="tw-h-6 tw-w-6" :stroke-width="2.2" />
      <X v-else class="tw-h-6 tw-w-6" :stroke-width="2.2" />
    </button>
  </div>

  <!-- Result modal -->
  <div
    v-if="showResult"
    class="tw-fixed tw-inset-0 tw-z-[2147483646] tw-flex tw-items-center tw-justify-center tw-bg-black/60 tw-p-4"
    @click.self="showResult = false"
  >
    <div
      class="tw-max-h-[90vh] tw-w-[min(720px,94vw)] tw-overflow-y-auto tw-rounded-2xl tw-bg-white tw-p-6 tw-text-[16px] tw-shadow-2xl"
    >
      <section
        class="tw-mb-5 tw-flex tw-gap-4 tw-rounded-2xl tw-border tw-p-4"
        :class="verdictUi.card"
      >
        <div
          class="tw-flex tw-h-12 tw-w-12 tw-shrink-0 tw-items-center tw-justify-center tw-rounded-full"
          :class="verdictUi.icon"
        >
          <Check
            v-if="resultVerdict === 'excellent'"
            class="tw-h-7 tw-w-7"
            :stroke-width="2.4"
          />
          <TriangleAlert
            v-else-if="resultVerdict === 'poor'"
            class="tw-h-7 tw-w-7"
            :stroke-width="2.4"
          />
          <CircleMinus
            v-else-if="resultVerdict === 'mixed'"
            class="tw-h-7 tw-w-7"
            :stroke-width="2.4"
          />
          <Info v-else class="tw-h-7 tw-w-7" :stroke-width="2.4" />
        </div>
        <div class="tw-min-w-0">
          <p
            class="tw-mb-1 tw-text-[0.9375rem] tw-font-semibold"
            :class="verdictUi.accent"
          >
            {{ modalTitle }}
          </p>
          <p
            class="tw-whitespace-pre-wrap tw-text-[15px] tw-leading-6 tw-text-slate-600"
          >
            {{ resultText }}
          </p>
          <div
            v-if="resultStats"
            class="tw-mt-3.5 tw-grid tw-grid-cols-2 tw-gap-2 sm:tw-grid-cols-4"
          >
            <div
              class="tw-rounded-xl tw-border tw-border-slate-200 tw-bg-white tw-px-3 tw-py-2"
            >
              <div class="tw-text-[0.6875rem] tw-text-slate-400">{{ tr("total") }}</div>
              <div class="tw-text-[1.0625rem] tw-font-semibold tw-text-slate-900">{{ resultStats.total }}</div>
            </div>
            <div
              class="tw-rounded-xl tw-border tw-border-slate-200 tw-bg-white tw-px-3 tw-py-2"
            >
              <div class="tw-text-[0.6875rem] tw-text-slate-400">{{ tr("avg") }}</div>
              <div class="tw-text-[1.0625rem] tw-font-semibold tw-text-slate-900">{{ resultStats.average }}/5</div>
            </div>
            <div
              class="tw-rounded-xl tw-border tw-border-slate-200 tw-bg-white tw-px-3 tw-py-2"
            >
              <div class="tw-text-[0.6875rem] tw-text-slate-400">{{ tr("positive") }}</div>
              <div class="tw-text-[1.0625rem] tw-font-semibold tw-text-emerald-700">{{ resultStats.positive }}</div>
            </div>
            <div
              class="tw-rounded-xl tw-border tw-border-slate-200 tw-bg-white tw-px-3 tw-py-2"
            >
              <div class="tw-text-[0.6875rem] tw-text-slate-400">{{ tr("negative") }}</div>
              <div
                class="tw-text-[1.0625rem] tw-font-semibold"
                :class="resultStats.negative ? 'tw-text-red-600' : 'tw-text-slate-900'"
              >{{ resultStats.negative }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- Analysis-only: the pros/cons blocks are hidden for the quota/upgrade
           message (which is about the limit, not a product). Both empty states
           share the same centred icon+text layout so they look balanced. -->
      <template v-if="!isUpgrade">
        <div class="tw-grid tw-gap-4 md:tw-grid-cols-2">
          <section
            class="tw-flex tw-flex-col tw-rounded-2xl tw-border tw-p-4"
            :class="resultPros.length ? 'tw-border-emerald-200' : 'tw-border-slate-200'"
          >
            <h3
              class="tw-mb-3 tw-flex tw-items-center tw-gap-1.5 tw-text-[15px] tw-font-semibold tw-text-emerald-700"
            >
              <ThumbsUp class="tw-h-4 tw-w-4" />
              {{ tr("whatLooksGood") }}
            </h3>
            <ul
              v-if="resultPros.length"
              class="tw-list-disc tw-space-y-1.5 tw-pl-5 tw-text-[15px] tw-leading-6 tw-text-slate-700"
            >
              <li v-for="(it, i) in resultPros" :key="`pro-${i}`">{{ it }}</li>
            </ul>
            <div
              v-else
              class="tw-flex tw-flex-1 tw-flex-col tw-items-center tw-justify-center tw-gap-2.5 tw-py-3 tw-text-center"
            >
              <span
                class="tw-flex tw-h-11 tw-w-11 tw-items-center tw-justify-center tw-rounded-full tw-bg-slate-100 tw-text-slate-400"
              >
                <Info class="tw-h-6 tw-w-6" />
              </span>
              <p class="tw-text-[14px] tw-font-medium tw-leading-5 tw-text-slate-600">
                {{ tr("noPositives") }}
              </p>
            </div>
          </section>
          <section
            class="tw-flex tw-flex-col tw-rounded-2xl tw-border tw-p-4"
            :class="
              resultCons.length || resultIssues.length
                ? 'tw-border-red-200'
                : 'tw-border-slate-200'
            "
          >
            <h3
              class="tw-mb-3 tw-flex tw-items-center tw-gap-1.5 tw-text-[15px] tw-font-semibold"
              :class="
                resultCons.length || resultIssues.length
                  ? 'tw-text-red-700'
                  : 'tw-text-slate-400'
              "
            >
              <TriangleAlert
                v-if="resultCons.length || resultIssues.length"
                class="tw-h-4 tw-w-4"
              />
              <ShieldCheck v-else class="tw-h-4 tw-w-4" />
              {{ tr("risks") }}
            </h3>
            <ul
              v-if="resultCons.length || resultIssues.length"
              class="tw-list-disc tw-space-y-1.5 tw-pl-5 tw-text-[15px] tw-leading-6 tw-text-slate-700"
            >
              <li
                v-for="(it, i) in resultCons.length ? resultCons : resultIssues"
                :key="`con-${i}`"
              >
                {{ it }}
              </li>
            </ul>
            <div
              v-else
              class="tw-flex tw-flex-1 tw-flex-col tw-items-center tw-justify-center tw-gap-2.5 tw-py-3 tw-text-center"
            >
              <span
                class="tw-flex tw-h-11 tw-w-11 tw-items-center tw-justify-center tw-rounded-full tw-bg-emerald-100 tw-text-emerald-600"
              >
                <CircleCheck class="tw-h-6 tw-w-6" />
              </span>
              <p class="tw-text-[14px] tw-font-medium tw-leading-5 tw-text-slate-600">
                {{ tr("noNegatives") }}
              </p>
            </div>
          </section>
        </div>

        <section
          v-if="resultIssues.length && resultCons.length"
          class="tw-mt-4 tw-rounded-2xl tw-border tw-border-slate-200 tw-p-4"
        >
          <h3 class="tw-mb-3 tw-text-[15px] tw-font-semibold tw-text-slate-900">
            {{ tr("aiNotes") }}
          </h3>
          <ol
            class="tw-list-decimal tw-space-y-1.5 tw-pl-5 tw-text-[15px] tw-leading-6 tw-text-slate-700"
          >
            <li v-for="(it, i) in resultIssues" :key="`issue-${i}`">{{ it }}</li>
          </ol>
        </section>
      </template>

      <div class="tw-mt-5 tw-flex tw-justify-end tw-gap-2">
        <button
          v-if="isUpgrade"
          class="tw-inline-flex tw-items-center tw-gap-2 tw-rounded-xl tw-bg-indigo-700 tw-px-5 tw-py-2.5 tw-text-[15px] tw-font-medium tw-text-white tw-shadow-sm hover:tw-bg-indigo-800"
          @click="openUpgrade"
        >
          <ExternalLink class="tw-h-4 tw-w-4" />
          {{ tr("getPro") }}
        </button>
        <button
          class="tw-inline-flex tw-items-center tw-gap-2 tw-rounded-xl tw-bg-slate-900 tw-px-5 tw-py-2.5 tw-text-[15px] tw-font-medium tw-text-white hover:tw-bg-slate-700"
          @click="showResult = false"
        >
          <X class="tw-h-4 tw-w-4" />
          {{ tr("close") }}
        </button>
      </div>
    </div>
  </div>

  <!-- Media download result modal -->
  <div
    v-if="showDownload"
    class="tw-fixed tw-inset-0 tw-z-[2147483646] tw-flex tw-items-center tw-justify-center tw-bg-black/50 tw-p-4"
    @click.self="showDownload = false"
  >
    <div
      class="tw-w-[min(520px,94vw)] tw-rounded-2xl tw-bg-white tw-p-6 tw-text-[16px] tw-shadow-2xl"
    >
      <section
        class="tw-mb-4 tw-flex tw-items-center tw-gap-4 tw-rounded-2xl tw-border tw-border-emerald-200 tw-bg-emerald-50 tw-p-4"
      >
        <div
          class="tw-flex tw-h-12 tw-w-12 tw-shrink-0 tw-items-center tw-justify-center tw-rounded-full tw-bg-emerald-600 tw-text-white"
        >
          <CircleCheck class="tw-h-7 tw-w-7" :stroke-width="2.4" />
        </div>
        <div class="tw-min-w-0">
          <p class="tw-text-[0.9375rem] tw-font-semibold tw-text-emerald-700">
            {{ tr("mediaReady") }}
          </p>
          <p class="tw-text-[14px] tw-leading-5 tw-text-slate-600">
            {{ tr("mediaSavedTo") }}
          </p>
        </div>
      </section>

      <div class="tw-mb-4 tw-grid tw-grid-cols-3 tw-gap-2.5">
        <div
          class="tw-rounded-xl tw-border tw-border-slate-200 tw-bg-slate-50 tw-p-3 tw-text-center"
        >
          <div
            class="tw-mx-auto tw-mb-1 tw-flex tw-h-7 tw-w-7 tw-items-center tw-justify-center tw-rounded-lg tw-bg-indigo-50 tw-text-indigo-700"
          >
            <ImageIcon class="tw-h-4 tw-w-4" />
          </div>
          <div class="tw-text-[1.125rem] tw-font-semibold tw-text-slate-900">{{ dlPhotos }}</div>
          <div class="tw-text-[0.6875rem] tw-text-slate-400">{{ tr("photos") }}</div>
        </div>
        <div
          class="tw-rounded-xl tw-border tw-border-slate-200 tw-bg-slate-50 tw-p-3 tw-text-center"
        >
          <div
            class="tw-mx-auto tw-mb-1 tw-flex tw-h-7 tw-w-7 tw-items-center tw-justify-center tw-rounded-lg tw-bg-indigo-50 tw-text-indigo-700"
          >
            <VideoIcon class="tw-h-4 tw-w-4" />
          </div>
          <div class="tw-text-[1.125rem] tw-font-semibold tw-text-slate-900">{{ dlVideos }}</div>
          <div class="tw-text-[0.6875rem] tw-text-slate-400">{{ tr("videos") }}</div>
        </div>
        <div
          class="tw-rounded-xl tw-border tw-border-slate-200 tw-bg-slate-50 tw-p-3 tw-text-center"
        >
          <div
            class="tw-mx-auto tw-mb-1 tw-flex tw-h-7 tw-w-7 tw-items-center tw-justify-center tw-rounded-lg tw-bg-indigo-50 tw-text-indigo-700"
          >
            <Files class="tw-h-4 tw-w-4" />
          </div>
          <div class="tw-text-[1.125rem] tw-font-semibold tw-text-slate-900">{{ dlTotal }}</div>
          <div class="tw-text-[0.6875rem] tw-text-slate-400">{{ tr("total") }}</div>
        </div>
      </div>

      <div
        v-if="dlZipName"
        class="tw-mb-5 tw-flex tw-items-center tw-gap-2.5 tw-rounded-xl tw-border tw-border-slate-200 tw-px-3 tw-py-2.5"
      >
        <FileArchive class="tw-h-5 tw-w-5 tw-shrink-0 tw-text-indigo-700" />
        <span class="tw-min-w-0 tw-flex-1 tw-truncate tw-text-[14px] tw-text-slate-700">{{ dlZipName }}</span>
      </div>

      <div class="tw-flex tw-justify-end">
        <button
          class="tw-inline-flex tw-items-center tw-gap-2 tw-rounded-xl tw-bg-slate-900 tw-px-5 tw-py-2.5 tw-text-[15px] tw-font-medium tw-text-white hover:tw-bg-slate-700"
          @click="showDownload = false"
        >
          <X class="tw-h-4 tw-w-4" />
          {{ tr("close") }}
        </button>
      </div>
    </div>
  </div>

  <!-- Demand snapshot modal -->
  <div
    v-if="showDemand && demand"
    class="tw-fixed tw-inset-0 tw-z-[2147483646] tw-flex tw-items-center tw-justify-center tw-bg-black/50 tw-p-4"
    @click.self="showDemand = false"
  >
    <div
      class="tw-w-[min(540px,94vw)] tw-max-h-[calc(100vh-4rem)] tw-overflow-y-auto tw-rounded-2xl tw-bg-white tw-p-6 tw-text-[15px] tw-shadow-2xl"
    >
      <div class="tw-mb-4 tw-flex tw-items-center tw-justify-between tw-gap-3">
        <h3 class="tw-text-[1.0625rem] tw-font-semibold tw-text-slate-900">{{ tr("demandTitle") }}</h3>
        <button class="tw-text-slate-400 hover:tw-text-slate-600" @click="showDemand = false">
          <X class="tw-h-5 tw-w-5" />
        </button>
      </div>

      <!-- Opportunity score -->
      <section
        class="tw-mb-4 tw-flex tw-items-center tw-gap-4 tw-rounded-2xl tw-border tw-border-slate-200 tw-p-4"
      >
        <div class="tw-relative tw-h-16 tw-w-16 tw-shrink-0">
          <svg viewBox="0 0 36 36" class="tw-h-full tw-w-full -tw-rotate-90">
            <circle cx="18" cy="18" r="16" fill="none" stroke-width="3" stroke="currentColor" class="tw-text-slate-200" />
            <circle
              cx="18"
              cy="18"
              r="16"
              fill="none"
              stroke-width="3"
              stroke-linecap="round"
              stroke="currentColor"
              :class="demandTone.stroke"
              pathLength="100"
              stroke-dasharray="100"
              :stroke-dashoffset="100 - demand.opportunityScore"
            />
          </svg>
          <div
            class="tw-absolute tw-inset-0 tw-flex tw-flex-col tw-items-center tw-justify-center"
            :class="demandTone.text"
          >
            <span class="tw-text-[1.25rem] tw-font-bold tw-leading-none">{{ demand.opportunityScore }}</span>
          </div>
        </div>
        <div class="tw-min-w-0 tw-flex-1">
          <p
            class="tw-flex tw-cursor-help tw-items-center tw-gap-1 tw-text-[0.9375rem] tw-font-semibold tw-text-slate-900"
            v-tippy="tr('demandTipScore')"
          >
            {{ tr("demandOpportunity") }}
            <svg viewBox="0 0 24 24" class="tw-h-3.5 tw-w-3.5 tw-shrink-0 tw-text-slate-300" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          </p>
          <div class="tw-mt-2 tw-space-y-1.5">
            <div class="tw-flex tw-items-center tw-gap-2">
              <span class="tw-flex tw-w-32 tw-shrink-0 tw-cursor-help tw-items-center tw-gap-0.5 tw-whitespace-nowrap tw-text-[0.6875rem] tw-text-slate-400" v-tippy="tr('demandTipDemand')">
                {{ tr("demandDemand") }}
                <svg viewBox="0 0 24 24" class="tw-h-3 tw-w-3 tw-shrink-0 tw-text-slate-300" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
              </span>
              <div class="tw-h-1.5 tw-flex-1 tw-rounded-full tw-bg-slate-100">
                <div class="tw-h-full tw-rounded-full tw-bg-indigo-500" :style="{ width: Math.min(100, (demand.scoreBreakdown.demand / 60) * 100) + '%' }"></div>
              </div>
            </div>
            <div class="tw-flex tw-items-center tw-gap-2">
              <span class="tw-flex tw-w-32 tw-shrink-0 tw-cursor-help tw-items-center tw-gap-0.5 tw-whitespace-nowrap tw-text-[0.6875rem] tw-text-slate-400" v-tippy="tr('demandTipQualityGap')">
                {{ tr("demandQualityGap") }}
                <svg viewBox="0 0 24 24" class="tw-h-3 tw-w-3 tw-shrink-0 tw-text-slate-300" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
              </span>
              <div class="tw-h-1.5 tw-flex-1 tw-rounded-full tw-bg-slate-100">
                <div class="tw-h-full tw-rounded-full tw-bg-amber-500" :style="{ width: Math.min(100, (demand.scoreBreakdown.qualityGap / 40) * 100) + '%' }"></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Numbers (each card has a hover tooltip via title) -->
      <div class="tw-mb-4 tw-grid tw-grid-cols-2 tw-gap-2.5">
        <div class="tw-cursor-help tw-rounded-xl tw-border tw-border-slate-200 tw-bg-slate-50 tw-p-3" v-tippy="tr('demandTipSold')">
          <div class="tw-flex tw-items-center tw-gap-1 tw-text-[0.6875rem] tw-text-slate-400">
            {{ tr("demandSold") }}
            <svg viewBox="0 0 24 24" class="tw-h-3 tw-w-3 tw-shrink-0 tw-text-slate-300" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          </div>
          <div class="tw-text-[1.0625rem] tw-font-semibold tw-text-slate-900">{{ fmtInt(demand.sold) }}</div>
        </div>
        <div class="tw-cursor-help tw-rounded-xl tw-border tw-border-slate-200 tw-bg-slate-50 tw-p-3" v-tippy="tr('demandTipRevenue')">
          <div class="tw-flex tw-items-center tw-gap-1 tw-text-[0.6875rem] tw-text-slate-400">
            {{ tr("demandRevenue") }}
            <svg viewBox="0 0 24 24" class="tw-h-3 tw-w-3 tw-shrink-0 tw-text-slate-300" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          </div>
          <div class="tw-text-[1.0625rem] tw-font-semibold tw-text-slate-900">{{ fmtMoney(demand.revenueEstimate, demand.currency) }}</div>
        </div>
        <div class="tw-cursor-help tw-rounded-xl tw-border tw-border-slate-200 tw-bg-slate-50 tw-p-3" v-tippy="tr('demandTipPrice')">
          <div class="tw-flex tw-items-center tw-gap-1 tw-text-[0.6875rem] tw-text-slate-400">
            {{ tr("demandPrice") }}
            <svg viewBox="0 0 24 24" class="tw-h-3 tw-w-3 tw-shrink-0 tw-text-slate-300" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          </div>
          <div class="tw-text-[1.0625rem] tw-font-semibold tw-text-slate-900">
            {{ fmtMoney(demand.price, demand.currency) }}<span v-if="demand.priceMax">–{{ fmtMoney(demand.priceMax, null) }}</span>
          </div>
        </div>
        <div class="tw-cursor-help tw-rounded-xl tw-border tw-border-slate-200 tw-bg-slate-50 tw-p-3" v-tippy="tr('demandTipRating')">
          <div class="tw-flex tw-items-center tw-gap-1 tw-text-[0.6875rem] tw-text-slate-400">
            {{ tr("demandRating") }}
            <svg viewBox="0 0 24 24" class="tw-h-3 tw-w-3 tw-shrink-0 tw-text-slate-300" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          </div>
          <div class="tw-text-[1.0625rem] tw-font-semibold tw-text-slate-900">
            {{ demand.ratingAvg != null ? demand.ratingAvg.toFixed(2) : "—" }}
            <span class="tw-text-[0.75rem] tw-font-normal tw-text-slate-400">({{ fmtInt(demand.ratingCount) }})</span>
          </div>
        </div>
      </div>

      <!-- AI verdict -->
      <div v-if="demand.verdict" class="tw-mb-1 tw-rounded-xl tw-p-3" :class="demandTone.chip">
        <p class="tw-whitespace-pre-line tw-text-[14px] tw-leading-relaxed">{{ demand.verdict }}</p>
      </div>
      <p class="tw-mb-4 tw-text-[0.6875rem] tw-text-slate-400">{{ tr("demandDisclaimer") }}</p>

      <div class="tw-flex tw-justify-end">
        <button
          class="tw-inline-flex tw-items-center tw-gap-2 tw-rounded-xl tw-bg-slate-900 tw-px-5 tw-py-2.5 tw-text-[15px] tw-font-medium tw-text-white hover:tw-bg-slate-700"
          @click="showDemand = false"
        >
          <X class="tw-h-4 tw-w-4" />
          {{ tr("close") }}
        </button>
      </div>
    </div>
  </div>

  <!-- Listing config modal: pick target platform + language + extra rules -->
  <div
    v-if="showListingConfig"
    class="tw-fixed tw-inset-0 tw-z-[2147483646] tw-flex tw-items-center tw-justify-center tw-bg-black/60 tw-p-4"
    @click.self="showListingConfig = false"
  >
    <div class="tw-w-[min(560px,94vw)] tw-rounded-2xl tw-bg-white tw-p-6 tw-text-[16px] tw-shadow-2xl">
      <div class="tw-mb-4 tw-flex tw-items-center tw-gap-2.5">
        <span class="tw-flex tw-h-9 tw-w-9 tw-shrink-0 tw-items-center tw-justify-center tw-rounded-full tw-bg-indigo-50 tw-text-indigo-700">
          <FileText class="tw-h-5 tw-w-5" />
        </span>
        <h2 class="tw-flex-1 tw-text-[1.0625rem] tw-font-semibold tw-text-slate-900">{{ tr("configTitle") }}</h2>
        <button class="tw-rounded-lg tw-p-1.5 tw-text-slate-400 hover:tw-bg-slate-100 hover:tw-text-slate-700" @click="showListingConfig = false">
          <X class="tw-h-5 tw-w-5" />
        </button>
      </div>

      <!-- Target platform (preset). Hidden on Amazon: the target is always Amazon. -->
      <label v-if="marketplace !== 'amazon'" class="tw-mb-1 tw-block tw-text-[13px] tw-font-medium tw-text-slate-700">{{ tr("platformLabel") }}</label>
      <div v-if="marketplace !== 'amazon'" class="tw-mb-3 tw-flex tw-items-center tw-gap-2">
        <select
          v-model="selectedPresetId"
          class="tw-min-w-0 tw-flex-1 tw-rounded-xl tw-border tw-border-slate-300 tw-px-3 tw-py-2 tw-text-sm tw-text-slate-800 focus:tw-border-indigo-400 focus:tw-outline-none"
        >
          <option v-for="p in presets" :key="p.id" :value="p.id">
            {{ p.platform }}{{ p.custom ? " · " + tr("customPreset") : "" }}
          </option>
        </select>
        <button
          v-if="selectedIsCustom"
          class="tw-shrink-0 tw-rounded-lg tw-border tw-border-slate-200 tw-p-2 tw-text-slate-400 hover:tw-border-red-200 hover:tw-text-red-500"
          :title="tr('deletePreset')"
          @click="removePreset(selectedPresetId)"
        >
          <Trash2 class="tw-h-4 tw-w-4" />
        </button>
      </div>

      <!-- Output language -->
      <label class="tw-mb-1 tw-block tw-text-[13px] tw-font-medium tw-text-slate-700">{{ tr("outputLang") }}</label>
      <select
        v-model="listingLang"
        class="tw-mb-3 tw-w-full tw-rounded-xl tw-border tw-border-slate-300 tw-px-3 tw-py-2 tw-text-sm tw-text-slate-800 focus:tw-border-indigo-400 focus:tw-outline-none"
      >
        <option v-for="l in LOCALES" :key="l.code" :value="l.code">{{ l.label }}</option>
      </select>

      <!-- Extra instructions -->
      <label class="tw-mb-1 tw-block tw-text-[13px] tw-font-medium tw-text-slate-700">{{ tr("extraRules") }}</label>
      <textarea
        v-model="extraInstructions"
        rows="2"
        :placeholder="tr('extraRulesPh')"
        class="tw-mb-2 tw-w-full tw-resize-none tw-rounded-xl tw-border tw-border-slate-300 tw-px-3 tw-py-2 tw-text-sm tw-text-slate-800 focus:tw-border-indigo-400 focus:tw-outline-none"
      ></textarea>

      <!-- Save as custom preset (PRO) -->
      <button
        class="tw-mb-3 tw-inline-flex tw-items-center tw-gap-1.5 tw-text-[13px] tw-font-medium tw-text-indigo-600 hover:tw-text-indigo-800"
        @click="showSavePreset = !showSavePreset"
      >
        <Plus class="tw-h-3.5 tw-w-3.5" />
        {{ tr("saveAsPreset") }}
        <span v-if="!status.pro" class="tw-rounded tw-bg-amber-100 tw-px-1.5 tw-py-0.5 tw-text-[0.625rem] tw-font-bold tw-text-amber-700">PRO</span>
      </button>
      <div v-if="showSavePreset" class="tw-mb-3">
        <div class="tw-flex tw-items-center tw-gap-2">
          <input
            v-model="newPresetName"
            :placeholder="tr('presetName')"
            class="tw-min-w-0 tw-flex-1 tw-rounded-xl tw-border tw-border-slate-300 tw-px-3 tw-py-2 tw-text-sm tw-text-slate-800 focus:tw-border-indigo-400 focus:tw-outline-none"
          />
          <button
            class="tw-shrink-0 tw-rounded-xl tw-bg-indigo-700 tw-px-3 tw-py-2 tw-text-sm tw-font-medium tw-text-white hover:tw-bg-indigo-800 disabled:tw-opacity-50"
            :disabled="savingPreset || !newPresetName.trim()"
            @click="saveCurrentPreset"
          >
            {{ savingPreset ? "…" : tr("save") }}
          </button>
        </div>
        <p class="tw-mt-1.5 tw-text-[12px] tw-leading-4 tw-text-slate-400">{{ tr("savePresetHint") }}</p>
      </div>

      <div class="tw-mt-2 tw-flex tw-justify-end tw-gap-2">
        <button
          class="tw-rounded-xl tw-px-4 tw-py-2.5 tw-text-[15px] tw-font-medium tw-text-slate-600 hover:tw-bg-slate-100"
          @click="showListingConfig = false"
        >
          {{ tr("cancel") }}
        </button>
        <button
          class="tw-inline-flex tw-items-center tw-gap-2 tw-rounded-xl tw-bg-indigo-700 tw-px-5 tw-py-2.5 tw-text-[15px] tw-font-medium tw-text-white tw-shadow-sm hover:tw-bg-indigo-800 disabled:tw-opacity-60"
          :disabled="generatingListing"
          @click="runGenerateListing"
        >
          <LoaderCircle v-if="generatingListing" class="tw-h-4 tw-w-4 tw-animate-spin" />
          <Sparkles v-else class="tw-h-4 tw-w-4" />
          {{ generatingListing ? tr("generatingListing") : tr("generateNow") }}
        </button>
      </div>
    </div>
  </div>

  <!-- AI listing generator result modal -->
  <div
    v-if="showListing && listing"
    class="tw-fixed tw-inset-0 tw-z-[2147483646] tw-flex tw-items-center tw-justify-center tw-bg-black/60 tw-p-4"
    @click.self="showListing = false"
  >
    <div
      class="tw-max-h-[90vh] tw-w-[min(640px,94vw)] tw-overflow-y-auto tw-rounded-2xl tw-bg-white tw-p-6 tw-text-[16px] tw-shadow-2xl"
    >
      <div class="tw-mb-4 tw-flex tw-items-center tw-gap-2.5">
        <span
          class="tw-flex tw-h-9 tw-w-9 tw-shrink-0 tw-items-center tw-justify-center tw-rounded-full tw-bg-indigo-50 tw-text-indigo-700"
        >
          <Sparkles class="tw-h-5 tw-w-5" />
        </span>
        <h2 class="tw-flex-1 tw-text-[1.0625rem] tw-font-semibold tw-text-slate-900">
          {{ tr("aiListing") }}
        </h2>
        <button
          class="tw-inline-flex tw-items-center tw-gap-1.5 tw-rounded-lg tw-border tw-border-indigo-200 tw-bg-indigo-50 tw-px-3 tw-py-1.5 tw-text-[13px] tw-font-semibold tw-text-indigo-700 hover:tw-bg-indigo-100"
          @click="copyText(listingFullText(), 'all')"
        >
          <Check v-if="copiedKey === 'all'" class="tw-h-3.5 tw-w-3.5" />
          <Copy v-else class="tw-h-3.5 tw-w-3.5" />
          {{ copiedKey === "all" ? tr("copied") : tr("copyAll") }}
        </button>
      </div>

      <!-- Title -->
      <div class="tw-mb-3 tw-rounded-2xl tw-border tw-border-slate-200 tw-p-3.5">
        <div class="tw-mb-1.5 tw-flex tw-items-center tw-justify-between">
          <span class="tw-text-[0.6875rem] tw-font-semibold tw-uppercase tw-tracking-wide tw-text-slate-400">{{ tr("listingTitleLabel") }}</span>
          <button class="tw-inline-flex tw-items-center tw-gap-1 tw-text-[12px] tw-font-medium tw-text-indigo-600 hover:tw-text-indigo-800" @click="copyText(listing?.title ?? '', 'title')">
            <Check v-if="copiedKey === 'title'" class="tw-h-3.5 tw-w-3.5" /><Copy v-else class="tw-h-3.5 tw-w-3.5" />
            {{ copiedKey === "title" ? tr("copied") : tr("copy") }}
          </button>
        </div>
        <p class="tw-text-[15px] tw-font-medium tw-leading-6 tw-text-slate-800">{{ listing?.title }}</p>
      </div>

      <!-- Description -->
      <div class="tw-mb-3 tw-rounded-2xl tw-border tw-border-slate-200 tw-p-3.5">
        <div class="tw-mb-1.5 tw-flex tw-items-center tw-justify-between">
          <span class="tw-text-[0.6875rem] tw-font-semibold tw-uppercase tw-tracking-wide tw-text-slate-400">{{ tr("listingDescLabel") }}</span>
          <button class="tw-inline-flex tw-items-center tw-gap-1 tw-text-[12px] tw-font-medium tw-text-indigo-600 hover:tw-text-indigo-800" @click="copyText(listing?.description ?? '', 'desc')">
            <Check v-if="copiedKey === 'desc'" class="tw-h-3.5 tw-w-3.5" /><Copy v-else class="tw-h-3.5 tw-w-3.5" />
            {{ copiedKey === "desc" ? tr("copied") : tr("copy") }}
          </button>
        </div>
        <p class="tw-whitespace-pre-wrap tw-text-[14px] tw-leading-6 tw-text-slate-700">{{ listing?.description }}</p>
      </div>

      <!-- Bullets -->
      <div v-if="listing?.bullets?.length" class="tw-mb-3 tw-rounded-2xl tw-border tw-border-slate-200 tw-p-3.5">
        <div class="tw-mb-1.5 tw-flex tw-items-center tw-justify-between">
          <span class="tw-text-[0.6875rem] tw-font-semibold tw-uppercase tw-tracking-wide tw-text-slate-400">{{ tr("listingBulletsLabel") }}</span>
          <button class="tw-inline-flex tw-items-center tw-gap-1 tw-text-[12px] tw-font-medium tw-text-indigo-600 hover:tw-text-indigo-800" @click="copyText((listing?.bullets ?? []).map((b) => '• ' + b).join('\n'), 'bullets')">
            <Check v-if="copiedKey === 'bullets'" class="tw-h-3.5 tw-w-3.5" /><Copy v-else class="tw-h-3.5 tw-w-3.5" />
            {{ copiedKey === "bullets" ? tr("copied") : tr("copy") }}
          </button>
        </div>
        <ul class="tw-list-disc tw-space-y-1.5 tw-pl-5 tw-text-[14px] tw-leading-6 tw-text-slate-700">
          <li v-for="(b, i) in listing?.bullets ?? []" :key="`bl-${i}`">{{ b }}</li>
        </ul>
      </div>

      <!-- Tags -->
      <div v-if="listing?.tags?.length" class="tw-mb-1 tw-rounded-2xl tw-border tw-border-slate-200 tw-p-3.5">
        <div class="tw-mb-2 tw-flex tw-items-center tw-justify-between">
          <span class="tw-inline-flex tw-items-center tw-gap-1 tw-text-[0.6875rem] tw-font-semibold tw-uppercase tw-tracking-wide tw-text-slate-400"><Tags class="tw-h-3.5 tw-w-3.5" />{{ tr("listingTagsLabel") }}</span>
          <button class="tw-inline-flex tw-items-center tw-gap-1 tw-text-[12px] tw-font-medium tw-text-indigo-600 hover:tw-text-indigo-800" @click="copyText((listing?.tags ?? []).join(', '), 'tags')">
            <Check v-if="copiedKey === 'tags'" class="tw-h-3.5 tw-w-3.5" /><Copy v-else class="tw-h-3.5 tw-w-3.5" />
            {{ copiedKey === "tags" ? tr("copied") : tr("copy") }}
          </button>
        </div>
        <div class="tw-flex tw-flex-wrap tw-gap-1.5">
          <span v-for="(tag, i) in listing?.tags ?? []" :key="`tg-${i}`" class="tw-rounded-md tw-bg-slate-100 tw-px-2 tw-py-0.5 tw-text-[12px] tw-text-slate-600">{{ tag }}</span>
        </div>
      </div>

      <div class="tw-mt-5 tw-flex tw-justify-end">
        <button
          class="tw-inline-flex tw-items-center tw-gap-2 tw-rounded-xl tw-bg-slate-900 tw-px-5 tw-py-2.5 tw-text-[15px] tw-font-medium tw-text-white hover:tw-bg-slate-700"
          @click="showListing = false"
        >
          <X class="tw-h-4 tw-w-4" />
          {{ tr("close") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
