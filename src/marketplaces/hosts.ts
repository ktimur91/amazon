// Marketplace host globs — the single source of truth for the manifest's
// `content_scripts.matches` AND `host_permissions`, and for each adapter's
// `matchesHost`. Kept in a dependency-free module (no DOM, no chrome, no Vue)
// so `vite.config.ts` can import it at build time to compose the manifest.
//
// To support a new marketplace domain, add its globs here and reference them
// from the adapter — the manifest picks them up automatically on the next build.

// Amazon runs one storefront per country on its own TLD, but every one serves
// the same product-page markup (`/dp/<ASIN>`, `#productTitle`, `#acrPopover`,
// the inline `colorImages` gallery), so a single adapter covers them all.
// `*.amazon.com` also matches the bare `amazon.com` plus `www.`/`smile.`.
export const AMAZON_HOST_GLOBS = [
  // North & South America
  "*://*.amazon.com/*",
  "*://*.amazon.ca/*",
  "*://*.amazon.com.mx/*",
  "*://*.amazon.com.br/*",
  // Europe
  "*://*.amazon.co.uk/*",
  "*://*.amazon.de/*",
  "*://*.amazon.fr/*",
  "*://*.amazon.it/*",
  "*://*.amazon.es/*",
  "*://*.amazon.nl/*",
  "*://*.amazon.se/*",
  "*://*.amazon.pl/*",
  "*://*.amazon.com.be/*",
  "*://*.amazon.com.tr/*",
  // Asia-Pacific & Middle East
  "*://*.amazon.co.jp/*",
  "*://*.amazon.in/*",
  "*://*.amazon.sg/*",
  "*://*.amazon.com.au/*",
  "*://*.amazon.ae/*",
  "*://*.amazon.sa/*",
  "*://*.amazon.eg/*",
] as const;

/** Every marketplace host glob, in manifest order. */
export const MARKETPLACE_HOST_GLOBS: string[] = [...AMAZON_HOST_GLOBS];
