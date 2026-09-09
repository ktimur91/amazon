// Marketplace adapter contract.
//
// Everything marketplace-specific lives behind this one interface. Amazon is
// currently the only implementation; adding another means writing one
// `src/marketplaces/<name>.ts` implementing `MarketplaceAdapter` and registering
// it in `src/marketplaces/index.ts`. The manifest, the content-script
// detection/parsing and the background fetchers all read from the registry, so
// no other file needs to learn about the new marketplace.
//
// Methods are grouped by the execution context they run in. A single adapter
// object spans all three contexts; each method is only ever CALLED in its own
// context (the registry is imported by the content script, the background worker
// and — for host globs only — the Vite config), so nothing touches `document`
// or `chrome` at import time.

import type {
  MediaItem,
  ReviewItem,
  Marketplace,
  DemandSignals,
  ListingContext,
} from "../lib/messages";

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

  /** Manifest match/host globs, e.g. `"*://*.amazon.com/*"`. Source of truth for
   *  both `content_scripts.matches` and `host_permissions`. */
  readonly hostGlobs: readonly string[];

  /** True if `host` (a hostname) belongs to this marketplace. */
  matchesHost(host: string): boolean;

  /** True if `url` LOOKS like a product page (not search / home / category).
   *  URL shape only — a marketplace can serve a not-found page at a perfectly
   *  well-formed product URL, so pair this with `isProductPage` before
   *  committing to any UI. */
  isProductUrl(url: string): boolean;

  /** Filesystem-safe slug for the product, used to name the media ZIP. */
  productSlug(url: string): string;

  // --- content world (DOM scraping) -------------------------------------------

  /** Collect downloadable product media from the page DOM. */
  parseMedia(root?: ParentNode): MediaItem[];

  /** The product's title from the page DOM (e.g. Amazon's `#productTitle`).
   *  Marketplace-specific because a generic `<h1>` grab picks up the wrong
   *  element on some sites. Returns null when not on a product page. */
  productTitle?(root?: ParentNode): string | null;

  /** True when the DOM actually contains a product, as opposed to a not-found
   *  or interstitial page served at a product-shaped URL. Used to gate mounting
   *  the panel. Adapters that can't distinguish may omit it (treated as true). */
  isProductPage?(root?: ParentNode): boolean;

  /** Marketplace-specific context for the AI listing generator (spec table,
   *  feature bullets, the subtitle line under the title). Marketplace-specific
   *  because generic class-name heuristics match site chrome — on Amazon they
   *  pick up the account-nav flyout and the customer Q&A table. */
  productContext?(root?: ParentNode): ListingContext;

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

  /** Optionally collect demand signals (units sold, price, rating, review
   *  count) for `url`, by running an in-page scrape inside `tabId`. Returns
   *  partial data — any field may be missing, and on Amazon `sold` frequently
   *  is — and the backend degrades gracefully. Throws with a user-facing
   *  message when the URL lacks the needed IDs. */
  fetchDemand?(tabId: number, url: string): Promise<DemandSignals>;
}
