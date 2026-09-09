// Shared message contracts between content / background / popup.

export type Marketplace = "amazon" | "unknown";

// AI features that each have their own daily free quota. Media downloads are
// always free and are NOT a quota feature.
export type QuotaFeature = "analysis" | "listing" | "demand";
export interface FeatureQuota {
  used: number;
  limit: number;
}
export type FeatureQuotas = Record<QuotaFeature, FeatureQuota>;

export interface MediaItem {
  url: string;
  type: "image" | "video";
}

export interface ReviewItem {
  rating: number;
  text: string;
}

export type ReviewVerdict = "excellent" | "mixed" | "poor" | "no_data";

export interface ReviewStats {
  total: number;
  positive: number;
  neutral: number;
  negative: number;
  average: number;
}

/// Activity event mirrored to the account history. Relayed to the background
/// (POST_EVENT) so the API call is made there — content-script fetches are
/// blocked by CORS on prod, while the background reaches the API via
/// host_permissions.
export interface ActivityEventInput {
  type: "analysis" | "download" | "listing" | "demand";
  group?: string;
  language?: string; // UI language the result was generated in (analysis/listing)
  productRef?: string;
  title?: string;
  imageUrl?: string;
  payload?: unknown;
}

/// Product context scraped from the page, fed to the AI listing generator.
export interface ListingContext {
  category?: string;
  price?: string;
  /// The line under the product title. On Amazon this carries selling points
  /// that are NOT in `#productTitle` (e.g. "100W PD charging, compatible with
  /// …"), so omitting it loses headline features.
  subtitle?: string;
  attributes?: string[];
  reviewSummary?: string;
  mediaCount?: number;
}

/// The AI-generated, marketplace-optimized listing returned by the backend.
export interface ListingResult {
  title: string;
  description: string;
  bullets: string[];
  tags: string[];
  language: string;
  presetId?: string; // which preset (target platform) it was generated for
  presetLabel?: string; // platform display label
  presetShort?: string; // compact tag for the history chip ("WB", "FB/IG", …)
  usage?: { used: number; limit: number; plan: string };
}

/// A listing preset (target platform). Built-in or the user's saved custom one.
export interface ListingPreset {
  id: string; // built-in id or "custom:<uuid>"
  platform: string; // display label
  short: string; // compact tag
  custom: boolean;
  name?: string;
}

/// Demand signals scraped from a product page, fed to the demand endpoint.
export interface DemandSignals {
  sold?: number; // units sold as exposed by the page
  soldLabel?: string; // raw "X sold" / period hint (honesty about the number)
  price?: number; // numeric price (single value or the low end of a range)
  priceMax?: number; // high end of a variant price range
  currency?: string;
  ratingAvg?: number; // 0..5
  ratingCount?: number; // number of ratings / reviews
  stock?: number;
  liked?: number;
}

/// The demand snapshot returned by the backend.
export interface DemandResult {
  sold: number | null;
  soldLabel: string | null;
  price: number | null;
  priceMax: number | null;
  currency: string | null;
  ratingAvg: number | null;
  ratingCount: number | null;
  revenueEstimate: number | null;
  opportunityScore: number; // 0..100
  scoreBreakdown: { demand: number; qualityGap: number };
  verdict: string;
  language: string;
  usage?: { used: number; limit: number; plan: string };
}

export type RequestMessage =
  | { type: "PING" }
  | { type: "POST_EVENT"; event: ActivityEventInput }
  | { type: "DOWNLOAD_MEDIA"; items: MediaItem[]; productSlug: string }
  | {
      type: "FETCH_AND_ANALYZE";
      url: string;
      language?: string;
      locale?: string;
    }
  | {
      type: "GENERATE_LISTING";
      url: string;
      productTitle: string;
      language?: string;
      presetId?: string;
      extraInstructions?: string;
      context?: ListingContext;
    }
  | {
      type: "FETCH_DEMAND";
      url: string;
      productTitle: string;
      language?: string;
    }
  | { type: "LIST_PRESETS" }
  | {
      type: "SAVE_PRESET";
      preset: { name: string; basePresetId?: string; instructions?: string };
    }
  | { type: "DELETE_PRESET"; id: string }
  | { type: "LICENSE_CHECK" }
  | { type: "LICENSE_ACTIVATE"; key: string }
  | { type: "QUOTA_GET" }
  | { type: "AUTH_OPEN_ACCOUNT" }
  | { type: "AUTH_LOGOUT" };

export type ResponseMessage =
  | { ok: true; ts: number } // PING
  | {
      ok: true;
      zipName: string;
      photos?: number;
      videos?: number;
      /// True only once the browser reports the file as fully written to disk.
      /// False when the download was cancelled, interrupted, or is still
      /// waiting on a "save as" prompt — callers must NOT claim success or
      /// record history unless this is true.
      completed: boolean;
    } // DOWNLOAD_MEDIA
  | { ok: false; error: string }
  | {
      ok: true;
      summary: string;
      issues: string[];
      pros?: string[];
      cons?: string[];
      verdict?: ReviewVerdict;
      stats?: ReviewStats;
      count?: number;
      debug?: string;
    } // FETCH_AND_ANALYZE
  | { ok: true; listing: ListingResult } // GENERATE_LISTING
  | { ok: true; demand: DemandResult } // FETCH_DEMAND
  | { ok: true; presets: ListingPreset[] } // LIST_PRESETS
  | { ok: true; preset: ListingPreset } // SAVE_PRESET
  | { ok: true; deleted: true } // DELETE_PRESET
  | {
      ok: true;
      pro: boolean;
      quotas: FeatureQuotas; // per-feature daily usage/limit (backend = source of truth)
      resetAt: number;
      proExpiresAt: number | null;
      status: string | null;
      customerPortalUrl: string | null;
      email: string | null;
      deviceName: string | null;
      online: boolean; // backend reachable on the last sync (health check)
    } // LICENSE_CHECK / QUOTA_GET
  | { ok: true; activated: boolean } // LICENSE_ACTIVATE
  | { ok: true; opened: true } // AUTH_OPEN_ACCOUNT
  | { ok: true; email: string | null; pro: boolean }; // AUTH_LOGOUT
