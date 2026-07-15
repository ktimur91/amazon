// Marketplace adapter contract.
//
// Everything that differs between AliExpress, 1688, Taobao (and any future marketplace —
// TikTok Shop, Amazon, …) lives behind this one interface. Adding a marketplace
// means: write one `src/marketplaces/<name>.ts` implementing `MarketplaceAdapter`
// and register it in `src/marketplaces/index.ts`. The manifest, the content-script
// detection/parsing and the background review fetcher all read from the registry,
// so no other file needs to learn about the new marketplace.
//
// Methods are grouped by the execution context they run in. A single adapter
// object spans all three contexts; each method is only ever CALLED in its own
// context (the registry is imported by the content script, the background worker
// and — for host globs only — the Vite config), so nothing touches `document`
// or `chrome` at import time.

import type { MediaItem, ReviewItem, Marketplace, DemandSignals } from "../lib/messages";

export type MarketplaceId = Exclude<Marketplace, "unknown">;

export interface ReviewFetchResult {
  reviews: ReviewItem[];
  /** Free-form diagnostics surfaced in the analysis response for debugging. */
  debug: string;
}

export interface MarketplaceAdapter {
  /** Stable id; also the `marketplace` label sent to the analysis backend. */
  readonly id: MarketplaceId;
  /** Human-readable name. */
  readonly label: string;

  // --- identity (pure; safe in any context) ----------------------------------

  /** Manifest match/host globs, e.g. `"*://*.aliexpress.ru/*"`. Source of truth for
   *  both `content_scripts.matches` and `host_permissions`. */
  readonly hostGlobs: readonly string[];

  /** True if `host` (a hostname) belongs to this marketplace. */
  matchesHost(host: string): boolean;

  /** True if `url` is a product page (not search / home / category). */
  isProductUrl(url: string): boolean;

  /** Filesystem-safe slug for the product, used to name the media ZIP. */
  productSlug(url: string): string;

  // --- content world (DOM scraping) -------------------------------------------

  /** Collect downloadable product media from the page DOM. */
  parseMedia(root?: ParentNode): MediaItem[];

  /** DOM fallback review scraper. Not on the hot path (reviews normally come
   *  from `fetchReviews`), but kept as a per-marketplace capability. */
  parseReviews(root?: ParentNode): ReviewItem[];

  // --- background world (chrome.scripting) ------------------------------------

  /** Fetch reviews for `url` by running an in-page request inside `tabId`.
   *  Throws with a user-facing message when the URL lacks the needed IDs. */
  fetchReviews(tabId: number, url: string): Promise<ReviewFetchResult>;

  /** Optionally collect product media via the marketplace's own item API, run
   *  in the page MAIN world (same-origin + cookies). Preferred over the DOM
   *  `parseMedia` scrape when present — it returns the exact product gallery +
   *  video with none of the page's recommendation/banner junk. Returns `[]` on
   *  any failure so the caller can fall back to the DOM scrape. */
  fetchMedia?(tabId: number, url: string): Promise<MediaItem[]>;

  /** Optionally collect demand signals (units sold, price, rating, review count,
   *  stock) for `url`. AliExpress reads its productData API (aliexpress.ru) / runParams (.com)
   *  data. Returns partial data — any field may be missing — and the backend
   *  degrades gracefully. Throws with a user-facing message when the URL lacks
   *  the needed IDs. */
  fetchDemand?(tabId: number, url: string): Promise<DemandSignals>;
}
