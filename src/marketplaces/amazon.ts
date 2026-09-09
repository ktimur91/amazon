// Amazon marketplace adapter — built for FBA/FBM sellers doing product research.
//
// Verified live on amazon.com (2026-07-16):
//  - ASIN: `/dp/<ASIN>` or `/gp/product/<ASIN>` (10 chars).
//  - MEDIA: the whole gallery is embedded in an inline script as
//      'colorImages': { 'initial': [ {"hiRes":"https://m.media-amazon.com/images/I/…_AC_SL1500_.jpg",
//                                    "large":"…","thumb":"…","variant":"MAIN"} ] }
//    The outer keys are single-quoted (not JSON) but the array itself is valid
//    JSON, so we bracket-match it out and parse. Stripping the `._AC_SL1500_.`
//    size transform yields the ORIGINAL image.
//  - DEMAND: `#productTitle`, `.a-price .a-offscreen`, `#acrPopover[title]`
//    ("4.6 out of 5 stars"), `#acrCustomerReviewText` ("(280)"), and the sold
//    counter Amazon prints as "1K+ bought in past month" — a genuine MONTHLY
//    sales figure, which no other marketplace we support exposes.
//  - REVIEWS: deliberately NOT supported. Amazon serves only ~8 curated reviews
//    (mostly 4-5★) and ignores `pageNumber`/`filterByStar` on both the reviews
//    page and its own `/portal/customer-reviews/ajax/reviews/get/` endpoint
//    (page 1/2/3 return byte-identical payloads; `showStarFilter:false`,
//    `medleyReviewsAjaxUrl:""` in the page state). A "review analysis" over 8
//    hand-picked positives would mislead a seller deciding what to source, so
//    the feature is off for Amazon rather than shipped hollow.
//  - VIDEO: Amazon serves product video as HLS (.m3u8) only — not downloadable
//    as a single file — so media is images-only here.
//
// Self-contained in-page fetchers (serialized via executeScript): no imports.

import type {
  MediaItem,
  ReviewItem,
  DemandSignals,
  ListingContext,
} from "../lib/messages";
import type { MarketplaceAdapter, ReviewFetchResult } from "./types";
import { AMAZON_HOST_GLOBS } from "./hosts";
import { productSlugFromUrl } from "./util";

const AMAZON_CDN = /(media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com)/i;

/** Extract the ASIN from an Amazon URL: /dp/B0FD9B38GH, /gp/product/…, /slug/dp/…. */
function extractAsin(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

/** Strip Amazon's size transform to get the original: `X._AC_SL1500_.jpg` → `X.jpg`. */
function originalImage(raw: string): string {
  const u = (raw || "").split("?")[0];
  return u.replace(/\._[A-Z0-9_,-]+_\.(jpe?g|png|webp|gif)$/i, ".$1");
}

// --- DOM media (fallback) --------------------------------------------------

function parseMedia(root: ParentNode = document): MediaItem[] {
  const items = new Map<string, MediaItem>();
  const add = (raw?: string | null) => {
    if (!raw || !/^https?:/i.test(raw) || !AMAZON_CDN.test(raw)) return;
    const url = originalImage(raw);
    if (!items.has(url)) items.set(url, { url, type: "image" });
  };
  // Main image carries every size in data-a-dynamic-image; the thumb rail has the rest.
  const main = root.querySelector<HTMLImageElement>("#landingImage, #imgBlkFront");
  try {
    const dyn = main?.getAttribute("data-a-dynamic-image");
    if (dyn) Object.keys(JSON.parse(dyn)).forEach(add);
  } catch {
    /* ignore */
  }
  add(main?.currentSrc || main?.src);
  root.querySelectorAll<HTMLImageElement>("#altImages img, #imageBlock img").forEach((img) => {
    add(img.currentSrc || img.src);
  });
  return [...items.values()];
}

// Product title lives in `#productTitle` (a <span>, not an <h1>) — so a generic
// `<h1>` grab picks up the wrong element (e.g. an assistant sidebar heading).
function parseTitle(root: ParentNode = document): string | null {
  const t = root.querySelector("#productTitle")?.textContent?.trim();
  return t && t.length > 1 ? t.replace(/\s+/g, " ") : null;
}

// Amazon reviews are capped + curated (see header) — no DOM fallback either.
function parseReviews(_root: ParentNode = document): ReviewItem[] {
  return [];
}

/**
 * True when the DOM actually holds a product.
 *
 * `isProductUrl` only pattern-matches the ASIN in the path, and Amazon serves
 * its "Page Not Found" dog page at a perfectly well-formed `/dp/<ASIN>` URL for
 * any dead or region-blocked ASIN. Without this check the panel mounts on those
 * pages and offers actions whose scrapes all come back empty.
 */
function isProductPage(root: ParentNode = document): boolean {
  return parseTitle(root) !== null;
}

/**
 * The line under the product title. Amazon puts real selling points there that
 * never appear in `#productTitle` (e.g. "100W PD charging, compatible with …"),
 * and there is no dedicated id for it — it is whatever `#title_feature_div`
 * holds beyond the title itself.
 */
function parseSubtitle(root: ParentNode = document): string | undefined {
  const box = root.querySelector<HTMLElement>("#title_feature_div");
  if (!box) return undefined;
  const whole = (box.innerText || "").replace(/\s+/g, " ").trim();
  const title = parseTitle(root) ?? "";
  const rest = (whole.startsWith(title) ? whole.slice(title.length) : whole).trim();
  return rest.length >= 3 ? rest.slice(0, 300) : undefined;
}

/**
 * Amazon-specific listing context for the AI generator.
 *
 * Generic `[class*="attribute"]` / `[class*="spec"]` heuristics are actively
 * harmful here: on Amazon they match the account-nav flyout ("Create a List",
 * "Your Saved Books") and the customer Q&A table, so the model was being fed
 * site chrome as product attributes. These ids are the real blocks.
 */
function parseProductContext(root: ParentNode = document): ListingContext {
  const ctx: ListingContext = {};

  const crumbs = Array.from(
    root.querySelectorAll<HTMLElement>("#wayfinding-breadcrumbs_feature_div a"),
  )
    .map((a) => (a.textContent || "").trim())
    .filter((t) => t && t.length < 40);
  if (crumbs.length) ctx.category = crumbs.slice(-4).join(" > ");

  const subtitle = parseSubtitle(root);
  if (subtitle) ctx.subtitle = subtitle;

  const attrs: string[] = [];
  const push = (raw: string | null | undefined): void => {
    const t = (raw || "").replace(/\s+/g, " ").trim();
    if (t.length >= 3 && t.length <= 300) attrs.push(t);
  };
  // Spec table ("Brand UGREEN", "Hardware Interface HDMI, USB, …").
  root
    .querySelectorAll<HTMLElement>("#productOverview_feature_div tr")
    .forEach((el) => push(el.innerText));
  // "About this item" bullets. Amazon collapses all but the first behind an
  // expander, so this is often a single (long) entry — still the richest
  // free-text description available in the DOM.
  root
    .querySelectorAll<HTMLElement>("#feature-bullets li")
    .forEach((el) => push(el.innerText));
  // Technical/additional details, present on many categories.
  root
    .querySelectorAll<HTMLElement>(
      "#detailBullets_feature_div li, #productDetails_techSpec_section_1 tr",
    )
    .forEach((el) => push(el.innerText));

  if (attrs.length) ctx.attributes = [...new Set(attrs)].slice(0, 20);
  return ctx;
}

// --- In-page media fetcher (MAIN world) ------------------------------------
function amazonMediaFetcher(): Promise<{
  media: Array<{ url: string; type: "image" | "video" }>;
  debug: string;
}> {
  return new Promise((resolve) => {
    const media: Array<{ url: string; type: "image" | "video" }> = [];
    const seen = new Set<string>();
    const debug: string[] = [];
    const orig = (raw: string): string =>
      (raw || "").split("?")[0].replace(/\._[A-Z0-9_,-]+_\.(jpe?g|png|webp|gif)$/i, ".$1");
    const add = (raw?: string | null) => {
      if (!raw || !/^https?:/i.test(raw)) return;
      const url = orig(raw);
      if (!seen.has(url)) {
        seen.add(url);
        media.push({ url, type: "image" });
      }
    };

    // Bracket-match a JSON array starting at `start` (index of "["), string-aware.
    const sliceArray = (s: string, start: number): string | null => {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === "[") depth++;
        else if (c === "]") {
          depth--;
          if (depth === 0) return s.slice(start, i + 1);
        }
      }
      return null;
    };

    try {
      const html = document.documentElement.innerHTML;
      // 'colorImages': { 'initial': [ … ] }  — outer keys are single-quoted.
      const ci = html.indexOf("colorImages");
      let parsed = 0;
      if (ci > -1) {
        const init = html.indexOf("initial", ci);
        const open = init > -1 ? html.indexOf("[", init) : -1;
        const arr = open > -1 ? sliceArray(html, open) : null;
        if (arr) {
          try {
            const list = JSON.parse(arr) as Array<Record<string, unknown>>;
            for (const it of list) {
              const src =
                (typeof it.hiRes === "string" && it.hiRes) ||
                (typeof it.large === "string" && it.large) ||
                (typeof it.thumb === "string" && it.thumb) ||
                null;
              if (src) {
                add(src);
                parsed++;
              }
            }
          } catch (e) {
            debug.push("colorImages parse err " + String(e).slice(0, 60));
          }
        }
      }
      debug.push(`colorImages=${parsed}`);

      // Fallback: every size of the main image + the thumb rail.
      if (media.length === 0) {
        const main = document.querySelector("#landingImage, #imgBlkFront") as HTMLImageElement | null;
        try {
          const dyn = main?.getAttribute("data-a-dynamic-image");
          if (dyn) Object.keys(JSON.parse(dyn)).forEach(add);
        } catch {
          /* ignore */
        }
        add(main?.currentSrc || main?.src);
        document.querySelectorAll("#altImages img").forEach((n) => add((n as HTMLImageElement).src));
        debug.push(`dom-fallback=${media.length}`);
      }
      // Amazon product video is HLS (.m3u8) only — can't be packaged into the ZIP.
    } catch (e) {
      debug.push("err " + String(e).slice(0, 90));
    }
    resolve({ media, debug: debug.join("; ") });
  });
}

// --- In-page demand fetcher (MAIN world) -----------------------------------
function amazonDemandFetcher(): Promise<{
  sold?: number;
  soldLabel?: string;
  price?: number;
  priceMax?: number;
  currency?: string;
  ratingAvg?: number;
  ratingCount?: number;
  debug: string;
}> {
  return new Promise((resolve) => {
    const debug: string[] = [];
    try {
      const q = (s: string) => document.querySelector(s);
      const text = (s: string) => (q(s)?.textContent || "").trim().replace(/\s+/g, " ");

      // Price — locale-aware ("$32.99", "€32,99", "KZT15,528.39").
      const rawPrice =
        text("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen") ||
        text("#corePrice_feature_div .a-price .a-offscreen") ||
        text(".a-price .a-offscreen") ||
        text("#priceblock_ourprice") ||
        text("#priceblock_dealprice");
      const normalizeDigits = (s: string): string =>
        s
          .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
          .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
          .replace(/٫/g, ".")
          .replace(/٬/g, ",");
      const parseLocalizedNumber = (s: string): number | undefined => {
        const c = normalizeDigits(s).replace(/[^\d.,]/g, "");
        if (!c) return undefined;
        const d = c.lastIndexOf(".");
        const m = c.lastIndexOf(",");
        let norm: string;
        if (d >= 0 && m >= 0) {
          // The final separator is decimal; the other one is grouping.
          norm =
            d > m
              ? c.replace(/,/g, "")
              : c.replace(/\./g, "").replace(/,/g, ".");
        } else {
          const sep = d >= 0 ? "." : m >= 0 ? "," : "";
          if (!sep) norm = c;
          else {
            const parts = c.split(sep);
            const last = parts[parts.length - 1] || "";
            // A single/grouped 3-digit tail is a thousands separator
            // ("1,299", "1.299", "1,299,000"), not a decimal fraction.
            const grouped = last.length === 3 && parts.slice(1).every((p) => p.length === 3);
            norm = grouped
              ? parts.join("")
              : `${parts.slice(0, -1).join("")}.${last}`;
          }
        }
        const n = parseFloat(norm);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      const price = rawPrice ? parseLocalizedNumber(rawPrice) : undefined;
      const currency = rawPrice ? rawPrice.replace(/[\d.,\s ]/g, "").trim() || undefined : undefined;

      // Rating: #acrPopover title = "4.6 out of 5 stars"
      const ratingTitle =
        q("#acrPopover")?.getAttribute("title") ||
        text('[data-hook="rating-out-of-text"]') ||
        text("#averageCustomerReviews .a-icon-alt");
      // Amazon localizes "out of 5"; the rating itself is consistently the
      // first 0..5 decimal in the accessibility label.
      const ratingToken = normalizeDigits(ratingTitle).match(/\d(?:[.,]\d+)?/)?.[0] ?? "";
      const ratingAvg = Number.parseFloat(ratingToken.replace(",", "."));

      // Review/rating count: "(280)" or "280 ratings"
      const countTxt = text("#acrCustomerReviewText") || text('[data-hook="total-review-count"]');
      const ratingCount = Number.parseInt(normalizeDigits(countTxt).replace(/[^\d]/g, ""), 10);

      // Sold: Amazon prints "1K+ bought in past month" — a MONTHLY figure.
      let sold: number | undefined;
      let soldLabel: string | undefined;
      const body = normalizeDigits(document.body.innerText).replace(/\u00a0/g, " ");
      const soldPatterns = [
        /([\d.,]+)\s*([KMB])?\+?\s*bought in past month/i,
        /im letzten monat\s+([\d.,]+)\+?\s*(?:mal\s+)?gekauft/i,
        /([\d.,]+)\+?\s*(?:mal\s+)?im letzten monat gekauft/i,
        /(?:plus de\s+)?([\d.,]+)\+?\s*achet(?:é|és|ée|ées).*mois dernier/i,
        /(?:más de\s+)?([\d.,]+)\+?\s*comprad(?:o|os|a|as).*mes pasado/i,
        /(?:oltre\s+)?([\d.,]+)\+?\s*acquistat(?:o|i|a|e).*mese scorso/i,
        /(?:mais de\s+)?([\d.,]+)\+?\s*compr(?:ado|ados|ada|adas|as).*m[eê]s passado/i,
        /(?:in de\s+)?afgelopen maand\s+(?:meer dan\s+)?([\d.,]+)\+?\s*(?:keer\s+)?gekocht/i,
        /(?:meer dan\s+)?([\d.,]+)\+?\s*(?:keer\s+)?gekocht.*afgelopen maand/i,
        /([\d.,]+)\+?\s*k[öo]pt.*senaste m[åa]naden/i,
        /(?:ponad\s+)?([\d.,]+)\+?\s*kupion.*zesz[łl]ym miesi[aą]cu/i,
        /ge[çc]en ay\s+([\d.,]+)\+?.*sat[ıi]n al[ıi]nd[ıi]/i,
        /過去1か月で([\d,]+)点以上購入/,
        /تم شراء\s*([\d.,]+)\+?.*الشهر الماضي/,
      ];
      const bought = soldPatterns.map((pattern) => body.match(pattern)).find(Boolean);
      if (bought) {
        let n = parseLocalizedNumber(bought[1]) ?? 0;
        const suf = (bought[2] || "").toUpperCase();
        if (suf === "K") n *= 1000;
        else if (suf === "M") n *= 1_000_000;
        else if (suf === "B") n *= 1_000_000_000;
        if (Number.isFinite(n) && n > 0) sold = Math.round(n);
        soldLabel = bought[0].replace(/\s+/g, " ").trim().slice(0, 120);
      }

      debug.push(
        `price=${price ?? "?"}${currency ?? ""} rating=${ratingAvg || "?"} count=${ratingCount || "?"} sold/mo=${sold ?? "?"}`,
      );
      resolve({
        sold,
        soldLabel,
        price,
        currency,
        ratingAvg: Number.isFinite(ratingAvg) && ratingAvg > 0 && ratingAvg <= 5 ? ratingAvg : undefined,
        ratingCount: Number.isFinite(ratingCount) && ratingCount > 0 ? ratingCount : undefined,
        debug: debug.join("; "),
      });
    } catch (e) {
      resolve({ debug: "err " + String(e).slice(0, 120) });
    }
  });
}

// --- background-world entry points -----------------------------------------

async function fetchMedia(tabId: number, url: string): Promise<MediaItem[]> {
  if (!extractAsin(url)) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: amazonMediaFetcher,
    });
    const r = results[0]?.result as { media?: MediaItem[]; debug?: string } | undefined;
    console.log(`[BG] Amazon media → ${r?.media?.length ?? 0} (${r?.debug ?? ""})`);
    return r?.media ?? [];
  } catch (e) {
    console.error("[BG] Amazon fetchMedia failed:", e);
    return [];
  }
}

async function fetchDemand(tabId: number, url: string): Promise<DemandSignals> {
  if (!extractAsin(url)) throw new Error("Could not read the ASIN from this Amazon URL.");
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: amazonDemandFetcher,
  });
  const r = (results[0]?.result ?? {}) as DemandSignals & { debug?: string };
  console.log(`[BG] Amazon demand → (${r.debug ?? ""})`);
  return {
    sold: r.sold,
    soldLabel: r.soldLabel,
    price: r.price,
    priceMax: r.priceMax,
    currency: r.currency,
    ratingAvg: r.ratingAvg,
    ratingCount: r.ratingCount,
  };
}

// Review analysis is intentionally unavailable on Amazon (see the header note).
// Kept as a no-op so the adapter still satisfies the contract and the UI can
// hide the feature via `supportsReviews`.
async function fetchReviews(_tabId: number, _url: string): Promise<ReviewFetchResult> {
  return {
    reviews: [],
    debug:
      "Amazon exposes only ~8 curated reviews and ignores pagination/star filters — review analysis is disabled for Amazon.",
  };
}

export const amazonAdapter: MarketplaceAdapter = {
  id: "amazon",
  label: "Amazon",
  hostGlobs: AMAZON_HOST_GLOBS,
  matchesHost: (host) => /(^|\.)amazon\.[a-z.]{2,6}$/i.test(host),
  isProductUrl: (url) => extractAsin(url) !== null,
  productSlug: (url) => {
    const asin = extractAsin(url);
    return asin ? `amazon-${asin}` : productSlugFromUrl(url);
  },
  parseMedia,
  productTitle: parseTitle,
  isProductPage,
  productContext: parseProductContext,
  parseReviews,
  fetchMedia,
  fetchReviews,
  fetchDemand,
};
