# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension — **"AliExpress Image & Video Downloader — Reviews & Listing AI"** —
for AliExpress product pages. Four features: (1) bulk-download product photos/videos as a ZIP (no
watermark), (2) **demand research** (price / rating / units-sold → opportunity score + AI verdict),
(3) **AI review analysis** (negative-review summary/verdict), and (4) an **AI listing generator**
(turn a product page into a ready-to-publish listing for Ozon/Wildberries/etc.). Built with
Vue 3 + Vite + `@crxjs/vite-plugin` + Tailwind, TypeScript throughout.

It is the **CIS-market sibling** of the Lazada/Shopee extension (`lazada-shopee/`): same codebase
shape and shared backend, a different marketplace adapter. 1688 / Taobao are planned as additional
adapters later (hence the repo name `aliexpress-1688`); for now it's AliExpress-only.

This directory is one of several related repos (all are working directories in this session):
- **`aliexpress-1688/`** (here) — this extension.
- **`lazada-shopee/`** — the original SEA extension (Lazada + Shopee); the template this was forked from.
- **`extensions-backend/`** — shared Express/Prisma/Postgres backend at `https://api.helptools.org`.
  Holds the OpenAI key, issues per-install tokens, runs review/demand/listing AI, stores history.
  Serves multiple extensions keyed by `extensionId` / `appKey` (this one registers as `aliexpress`).
- **`helptools-landing/`** — marketing/landing + account dashboard site (`helptools.org`).

## Commands

```bash
npm install
npm run dev          # Vite dev server with HMR (load dist/ as an unpacked extension)
npm run build        # vue-tsc --noEmit && vite build  → dist/
npm run typecheck    # vue-tsc --noEmit (Vue + extension TS)
```

There is **no test suite and no linter**. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml))
runs only `npm run build` (which type-checks first). Treat a clean `build` as the bar for "it
compiles". To load locally: `npm run build`, then Chrome → Extensions → Load unpacked → `dist/`.
`dist-zip/` holds versioned `.zip`s for Chrome Web Store submission.

## Architecture

Three extension contexts communicate over `chrome.runtime`/`chrome.tabs` messaging; all message
shapes live in [src/lib/messages.ts](src/lib/messages.ts) (`RequestMessage` / `ResponseMessage`) —
**change message contracts there first**, then update all three sides.

1. **Content script** ([src/content.ts](src/content.ts) → [src/content/InjectedApp.vue](src/content/InjectedApp.vue))
   — a floating Vue panel in a **Shadow DOM** (`#lz-helper-root`) so marketplace CSS can't bleed in.
   Only mounts on product pages. AliExpress is an SPA, so navigation is detected by **polling
   `location.href`**, not history patching.
2. **Background service worker** ([src/background.ts](src/background.ts)) — the workhorse: media
   download (fetch each asset → JSZip → `chrome.downloads`), review fetch + AI analysis, demand, listing.
3. **Popup** ([src/components/HelperPanel.vue](src/components/HelperPanel.vue)) — the main UI
   (stage stepper, account card, history, language picker).

### Marketplace adapter pattern (the important part)

Everything marketplace-specific lives behind one interface in
[src/marketplaces/](src/marketplaces/): each marketplace is a `MarketplaceAdapter`
([types.ts](src/marketplaces/types.ts)) registered in [index.ts](src/marketplaces/index.ts).
**Adding a marketplace (1688, Taobao, …) = write one `src/marketplaces/<name>.ts` + register it +
add its host globs to [hosts.ts](src/marketplaces/hosts.ts).** Nothing else needs to change:
`hosts.ts` is the single source of truth for the manifest's `content_scripts.matches` AND
`host_permissions` — `vite.config.ts` composes them into the manifest at build time (so
`manifest.json` itself carries only the non-marketplace host perms: the API + the image/video CDNs).

### AliExpress data sources ([src/marketplaces/aliexpress.ts](src/marketplaces/aliexpress.ts))

AliExpress runs **two distinct front-ends** and the adapter handles both:

- **aliexpress.ru (AER)** — the **primary** target: CIS visitors hitting aliexpress.com are
  geo-redirected here. It ships **no product data in the HTML** (a hydrating SPA); everything comes
  from a same-origin JSON API, read in the page MAIN world:
  `GET /aer-jsonapi/v1/bx/pdp/web/productData?productId=<id>&sourceId=0&sku_id=0` →
  `data.gallery[]` (`{imageUrl, videoUrl}`, full-res), `data.price.{min,max}ActivityAmount`,
  **`data.tradeInfo.tradeCount`** (units sold — AliExpress publishes it, unlike Lazada),
  `data.rating.middle`, `data.reviews` (count). Full reviews come from a second
  paginated JSON API: `POST /aer-jsonapi/review/v5/desktop/product-reviews?_bx-v=2.5.36`
  with `{productKey:{id,sourceId:0}, pagination:{pageNum,pageSize:10}, filters:[], sort:1}`
  → `data.reviews[].root.{grade,text}` (paged through in `aeReviewFetcher`, ~120 max).
- **aliexpress.com / .us** — the global PDP embeds `window.runParams.data`
  (`imageModule` / `titleModule.{tradeCount,feedbackRating}` / `priceModule`), read in the MAIN world.

Item id comes from `/item/<digits>.html` (both front-ends).

### AI backend

Review/demand/listing flows call the **helptools.org backend**
([src/lib/api/backend.ts](src/lib/api/backend.ts), Bearer install-token auth). The extension
registers an install once (`POST /v1/installs`, `extensionId: "aliexpress"`), caches the opaque
token in `chrome.storage.local`, re-registers on 401. The backend keeps the OpenAI key server-side.
**Backend wiring still TODO:** the backend must register this `extensionId`/`appKey` (`aliexpress`),
accept `marketplace: "aliexpress"`, and use an AliExpress/CIS-appropriate demand prompt.

### i18n

[src/lib/i18n.ts](src/lib/i18n.ts) holds all UI strings for **15 locales** in one file
(`LOCALES`, `t(locale, key, params)`). Add user-facing strings as keys there, not inline.

## Conventions & gotchas

- **`hosts.ts` is the source of truth for host scope** — `vite.config.ts` injects those globs into
  both `content_scripts.matches` and `host_permissions`. Add a domain there, not in `manifest.json`.
- Code injected into the page MAIN world (`executeScript`) **cannot import** — keep those fetcher
  functions self-contained (no imports, no closures over module scope).
- The content panel lives in a Shadow DOM; styles come from `tailwind.css?inline`. Don't rely on
  page styles.
- The extension **icon is still the Lazada/Shopee placeholder** (`src/assets/icons/`) — replace with
  an AliExpress-branded icon before store submission.
- Secrets: `OPENAI_API_KEY` is server-side only (backend `.env`). Never put it in extension code.
