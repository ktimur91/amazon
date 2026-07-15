// Marketplace registry.
//
// The ONE place that knows the full set of supported marketplaces. To add a new
// one: implement `MarketplaceAdapter` in `./<name>.ts`, then add it to
// `ADAPTERS` below (and its host globs in `./hosts.ts`). Everything else —
// content-script detection, DOM parsing, the background review fetcher and the
// manifest's host list — resolves the right adapter through this registry.

import type { Marketplace } from "../lib/messages";
import type { MarketplaceAdapter, MarketplaceId } from "./types";
import { amazonAdapter } from "./amazon";

export type { MarketplaceAdapter, MarketplaceId } from "./types";
export { MARKETPLACE_HOST_GLOBS } from "./hosts";

/** Every supported marketplace. Order is not significant. */
export const ADAPTERS: readonly MarketplaceAdapter[] = [amazonAdapter];

/** Adapter for a hostname, or null if it isn't a supported marketplace. */
export function getAdapterByHost(
  host: string = location.hostname,
): MarketplaceAdapter | null {
  return ADAPTERS.find((a) => a.matchesHost(host)) ?? null;
}

/** Adapter for a full URL, or null on an unsupported / malformed URL. */
export function getAdapterForUrl(url: string): MarketplaceAdapter | null {
  try {
    return getAdapterByHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Adapter by its stable id (`"amazon"`). */
export function getAdapterById(id: MarketplaceId): MarketplaceAdapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}

/** Marketplace id for a hostname, or `"unknown"` when none matches. */
export function detectMarketplace(
  host: string = location.hostname,
): Marketplace {
  return getAdapterByHost(host)?.id ?? "unknown";
}
