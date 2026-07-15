import JSZip from "jszip";
import type {
  MediaItem,
  RequestMessage,
  ResponseMessage,
  ReviewItem,
  ReviewStats,
  ReviewVerdict,
} from "./lib/messages";
import {
  activate,
  canConsume,
  consume,
  getStatus,
  syncFromBackend,
} from "./lib/license";
import { getAdapterForUrl } from "./marketplaces";
import {
  accountUrl,
  analyzeDemandViaBackend,
  analyzeReviewsViaBackend,
  deletePreset,
  ensureInstallId,
  generateListingViaBackend,
  listPresets,
  postEvent,
  savePreset,
  unlinkAccount,
} from "./lib/api/backend";
import { normalizeLocale, t, type LocaleCode } from "./lib/i18n";

// ---------- Media ZIP ----------

function extFromUrl(url: string, fallback = "bin"): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}

async function fetchAsBlob(url: string): Promise<Blob | null> {
  try {
    const r = await fetch(url, { credentials: "omit", cache: "no-store" });
    if (!r.ok) return null;
    return await r.blob();
  } catch {
    return null;
  }
}

async function buildZip(items: MediaItem[], slug: string): Promise<string> {
  const zip = new JSZip();
  const imgs = zip.folder("images")!;
  const vids = zip.folder("videos")!;
  let imgN = 0;
  let vidN = 0;

  await Promise.all(
    items.map(async (it) => {
      const blob = await fetchAsBlob(it.url);
      if (!blob) return;
      if (it.type === "image") {
        imgN++;
        imgs.file(
          `${String(imgN).padStart(3, "0")}.${extFromUrl(it.url, "jpg")}`,
          blob,
        );
      } else {
        vidN++;
        vids.file(
          `${String(vidN).padStart(3, "0")}.${extFromUrl(it.url, "mp4")}`,
          blob,
        );
      }
    }),
  );

  const archive = await zip.generateAsync({ type: "blob" });
  const dataUrl = await blobToDataUrl(archive);
  // Stable name from the product title (no timestamp). `prompt` on conflict so
  // the browser warns when the same product was already downloaded, instead of
  // silently saving "name (1).zip".
  const filename = `${slug || "product"}.zip`;
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
    conflictAction: "prompt",
  });
  return filename;
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(b);
  });
}

// ---------- AI review summary ----------

function reviewStats(reviews: ReviewItem[]): ReviewStats {
  const total = reviews.length;
  const positive = reviews.filter((r) => r.rating >= 4).length;
  const neutral = reviews.filter((r) => r.rating === 3).length;
  const negative = reviews.filter((r) => r.rating > 0 && r.rating <= 2).length;
  const average = total
    ? Number((reviews.reduce((sum, r) => sum + r.rating, 0) / total).toFixed(2))
    : 0;
  return { total, positive, neutral, negative, average };
}

function classifyReviews(stats: ReviewStats): ReviewVerdict {
  if (stats.total === 0) return "no_data";
  const negativeShare = stats.negative / stats.total;
  const positiveShare = stats.positive / stats.total;
  if (stats.negative === 0 && stats.average >= 4) return "excellent";
  if (negativeShare >= 0.35 || stats.negative > stats.positive) return "poor";
  if (negativeShare >= 0.15 || Math.abs(stats.positive - stats.negative) <= 1) {
    return "mixed";
  }
  if (positiveShare >= 0.7 && stats.average >= 4) return "excellent";
  return "mixed";
}

async function summarizeProductReviews(
  reviews: ReviewItem[],
  language: string,
  localeInput: string | undefined,
  marketplace: "amazon",
  productUrl?: string,
): Promise<{
  summary: string;
  issues: string[];
  pros: string[];
  cons: string[];
  verdict: ReviewVerdict;
  stats: ReviewStats;
}> {
  const locale = normalizeLocale(localeInput);
  const stats = reviewStats(reviews);
  const verdict = classifyReviews(stats);
  if (verdict === "no_data") {
    return {
      summary: t(locale, "fallbackNoData"),
      issues: [],
      pros: [],
      cons: [],
      verdict,
      stats,
    };
  }

  const normalized = reviews
    .filter((r) => r.rating > 0 && r.text.length > 0)
    .sort((a, b) => a.rating - b.rating)
    .slice(0, 120)
    .map((r) => ({
      rating: r.rating,
      text: r.text.replace(/\s+/g, " ").trim(),
    }));

  try {
    const data = await analyzeReviewsViaBackend({
      marketplace,
      reviews: normalized,
      language: language || "en",
      productUrl,
    });
    return {
      summary: (data.summary || fallbackSummary(verdict, stats, locale)).trim(),
      issues: data.issues.slice(0, 3),
      pros: data.pros.slice(0, 3),
      cons: data.cons.slice(0, 3),
      verdict: data.verdict ?? verdict,
      stats,
    };
  } catch {
    return fallbackProductSummary(reviews, verdict, stats, locale);
  }
}

function fallbackSummary(
  verdict: ReviewVerdict,
  stats: ReviewStats,
  locale: LocaleCode,
): string {
  if (verdict === "excellent") {
    return t(locale, "fallbackExcellent", {
      positive: stats.positive,
      total: stats.total,
    });
  }
  if (verdict === "poor") {
    return t(locale, "fallbackPoor", {
      negative: stats.negative,
      total: stats.total,
    });
  }
  if (verdict === "mixed") {
    return t(locale, "fallbackMixed");
  }
  return t(locale, "fallbackNoData");
}

function fallbackProductSummary(
  reviews: ReviewItem[],
  verdict: ReviewVerdict,
  stats: ReviewStats,
  locale: LocaleCode,
): {
  summary: string;
  issues: string[];
  pros: string[];
  cons: string[];
  verdict: ReviewVerdict;
  stats: ReviewStats;
} {
  const pros = [
    t(locale, "fallbackProPositive", {
      positive: stats.positive,
      total: stats.total,
    }),
    t(locale, "fallbackProAverage", { average: stats.average }),
  ];
  if (stats.negative === 0) pros.push(t(locale, "fallbackProNoNegative"));

  const cons =
    stats.negative > 0
      ? [
          t(locale, "fallbackConHasNegative", { negative: stats.negative }),
          verdict === "mixed" ? t(locale, "fallbackConMixed") : "",
        ].filter(Boolean)
      : [t(locale, "fallbackConNoPattern")];

  const issues =
    verdict === "excellent"
      ? [t(locale, "fallbackIssueExcellent")]
      : verdict === "poor"
        ? [t(locale, "fallbackIssuePoor")]
        : [t(locale, "fallbackIssueMixed")];

  return {
    summary: fallbackSummary(verdict, stats, locale),
    issues,
    pros,
    cons,
    verdict,
    stats,
  };
}

// ---------- Message router ----------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[BG] Amazon Helper installed");
  // Cleanup legacy storage from older versions (client-side API key).
  chrome.storage.local.remove("llm_config").catch(() => undefined);
  // Register the install eagerly so an install id exists before the user's
  // first analysis — required for the upgrade/checkout link to link a purchase.
  void ensureInstallId().catch(() => undefined);
});

chrome.runtime.onMessage.addListener(
  (
    msg: RequestMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: ResponseMessage) => void,
  ) => {
    (async () => {
      try {
        switch (msg.type) {
          case "PING":
            sendResponse({ ok: true, ts: Date.now() });
            return;

          case "POST_EVENT":
            // Mirror a download/analysis to the account history from here — the
            // background can reach the API (host_permissions) whereas the
            // content script's fetch is blocked by CORS on prod.
            void postEvent(msg.event);
            sendResponse({ ok: true, ts: Date.now() });
            return;

          case "DOWNLOAD_MEDIA": {
            // Media download is always free and unlimited; only review analysis
            // counts against the free daily quota.
            let items = msg.items;
            // Prefer the marketplace's media API when the adapter exposes one
            // (AliExpress): it returns the exact product gallery + video, whereas
            // the DOM scrape pulls in page junk (recommendations, banners).
            // Falls back to the DOM items the content script already collected.
            const tabId = sender.tab?.id;
            const tabUrl = sender.tab?.url;
            if (tabId && tabUrl) {
              const adapter = getAdapterForUrl(tabUrl);
              if (adapter?.fetchMedia) {
                try {
                  const apiItems = await adapter.fetchMedia(tabId, tabUrl);
                  if (apiItems.length) items = apiItems;
                } catch (e) {
                  console.warn("[BG] fetchMedia failed; using DOM items", e);
                }
              }
            }
            if (!items.length) {
              sendResponse({
                ok: false,
                error: "No media found on this page.",
              });
              return;
            }
            const name = await buildZip(items, msg.productSlug);
            sendResponse({
              ok: true,
              zipName: name,
              photos: items.filter((m) => m.type === "image").length,
              videos: items.filter((m) => m.type === "video").length,
            });
            return;
          }

          case "FETCH_AND_ANALYZE": {
            console.log("[BG] FETCH_AND_ANALYZE", msg.url);
            if (!(await canConsume("analysis"))) {
              sendResponse({ ok: false, error: "QUOTA_EXCEEDED" });
              return;
            }

            const tabId = sender.tab?.id;
            if (!tabId) {
              sendResponse({ ok: false, error: "No tab context." });
              return;
            }

            // Pick the marketplace adapter for this URL; everything store-
            // specific (id extraction, in-page fetch, fallbacks) lives there.
            const adapter = getAdapterForUrl(msg.url);
            if (!adapter) {
              sendResponse({ ok: false, error: "Unknown marketplace." });
              return;
            }

            let reviews: ReviewItem[] = [];
            let debug = "";
            try {
              const result = await adapter.fetchReviews(tabId, msg.url);
              reviews = result.reviews;
              debug = result.debug;
            } catch (err) {
              sendResponse({
                ok: false,
                error: (err as Error).message,
              });
              return;
            }

            const analysis = await summarizeProductReviews(
              reviews,
              msg.language ?? "en",
              msg.locale,
              adapter.id,
              msg.url,
            );
            await consume("analysis");
            sendResponse({
              ok: true,
              summary: analysis.summary,
              issues: analysis.issues,
              pros: analysis.pros,
              cons: analysis.cons,
              verdict: analysis.verdict,
              stats: analysis.stats,
              count: analysis.stats.negative,
              debug,
            });
            return;
          }

          case "GENERATE_LISTING": {
            // Free installs spend one unit of the listing daily quota; PRO is
            // unlimited (canConsume()/consume() no-op for PRO).
            if (!(await canConsume("listing"))) {
              sendResponse({ ok: false, error: "QUOTA_EXCEEDED" });
              return;
            }
            const adapter = getAdapterForUrl(msg.url);
            if (!adapter) {
              sendResponse({ ok: false, error: "Unknown marketplace." });
              return;
            }
            try {
              const listing = await generateListingViaBackend({
                marketplace: adapter.id,
                productUrl: msg.url,
                productTitle: msg.productTitle,
                language: msg.language ?? "en",
                presetId: msg.presetId,
                extraInstructions: msg.extraInstructions,
                context: msg.context,
              });
              await consume("listing");
              sendResponse({ ok: true, listing });
            } catch (err) {
              sendResponse({ ok: false, error: (err as Error).message });
            }
            return;
          }

          case "FETCH_DEMAND": {
            // Free installs spend one unit of the demand daily quota; PRO is
            // unlimited.
            if (!(await canConsume("demand"))) {
              sendResponse({ ok: false, error: "QUOTA_EXCEEDED" });
              return;
            }
            const tabId = sender.tab?.id;
            if (!tabId) {
              sendResponse({ ok: false, error: "No tab context." });
              return;
            }
            const adapter = getAdapterForUrl(msg.url);
            if (!adapter || !adapter.fetchDemand) {
              sendResponse({ ok: false, error: "Unknown marketplace." });
              return;
            }
            try {
              const signals = await adapter.fetchDemand(tabId, msg.url);
              const demand = await analyzeDemandViaBackend({
                marketplace: adapter.id,
                productUrl: msg.url,
                productTitle: msg.productTitle,
                language: msg.language ?? "en",
                signals,
              });
              await consume("demand");
              sendResponse({ ok: true, demand });
            } catch (err) {
              sendResponse({ ok: false, error: (err as Error).message });
            }
            return;
          }

          case "LIST_PRESETS": {
            sendResponse({ ok: true, presets: await listPresets() });
            return;
          }

          case "SAVE_PRESET": {
            try {
              const preset = await savePreset(msg.preset);
              sendResponse({ ok: true, preset });
            } catch (err) {
              sendResponse({ ok: false, error: (err as Error).message });
            }
            return;
          }

          case "DELETE_PRESET": {
            await deletePreset(msg.id);
            sendResponse({ ok: true, deleted: true });
            return;
          }

          case "LICENSE_CHECK":
          case "QUOTA_GET": {
            // Force a backend entitlement sync on UI open so a just-purchased
            // (or just-expired) subscription is reflected immediately.
            const s = await getStatus({ force: true });
            sendResponse({
              ok: true,
              pro: s.pro,
              quotas: s.quotas,
              resetAt: s.resetAt,
              proExpiresAt: s.proExpiresAt,
              status: s.status,
              customerPortalUrl: s.customerPortalUrl,
              email: s.email,
              deviceName: s.deviceName,
              online: s.online,
            });
            return;
          }

          case "LICENSE_ACTIVATE": {
            const activated = await activate(msg.key);
            sendResponse({ ok: true, activated });
            return;
          }

          case "AUTH_OPEN_ACCOUNT": {
            // Open the landing /account page carrying a one-time link token so
            // the web sign-in can bind this device to the account.
            const url = await accountUrl();
            await chrome.tabs.create({ url, active: true });
            sendResponse({ ok: true, opened: true });
            return;
          }

          case "AUTH_LOGOUT": {
            const r = await unlinkAccount();
            if (!r.ok) {
              sendResponse({ ok: false, error: r.error ?? "Logout failed" });
              return;
            }
            await syncFromBackend();
            const s = await getStatus();
            sendResponse({ ok: true, email: s.email, pro: s.pro });
            return;
          }

          default:
            sendResponse({ ok: false, error: "Unknown message type" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: (e as Error).message });
      }
    })();
    return true; // keep async channel open
  },
);
