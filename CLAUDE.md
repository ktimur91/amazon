# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension — **"Amazon Helper — Product Research, Media & Listing AI"**
(`amazon-helper`, v1.0.0) — for Amazon product pages, aimed at FBA/FBM sellers doing product
research. Vue 3 + Vite + `@crxjs/vite-plugin` + Tailwind (all utilities are `tw-` prefixed),
TypeScript throughout.

**Three features ship** (see the stepper in [src/components/HelperPanel.vue](src/components/HelperPanel.vue)):

1. **Demand research** — price / rating / rating-count / "N bought in past month" → backend
   opportunity score + AI verdict.
2. **Media download** — the product gallery bulk-downloaded as a ZIP, at original resolution.
   **Images only** (see gotchas).
3. **AI listing generator** — turn the product page into a ready-to-publish listing for a chosen
   target platform (preset) and language.

**Review analysis is deliberately NOT offered on Amazon.** Amazon serves only ~8 curated,
mostly-positive reviews and ignores `pageNumber`/`filterByStar`, so a verdict over them would
mislead a seller. `amazonAdapter.fetchReviews` returns `[]` with an explanatory `debug` string, and
`HelperPanel.vue` omits the `analysis` step. The whole plumbing (message types, backend client,
result modal, `analysis` quota) is intentionally left wired up in case Amazon opens reviews up —
so **finding review code is not evidence the feature is live**.

This is a fork of a Lazada/Shopee extension, which is why the internal prefix is `lz-` throughout
(shadow host `#lz-helper-root`, console tag `[LZ-Helper]`, storage keys `lz_*`). That naming is
load-bearing for existing installs' `chrome.storage` — don't rename it casually.

Related repos (siblings, not vendored here):

- **`extensions-backend/`** — shared Express/Prisma/Postgres backend at `https://api.helptools.org`.
  Holds the OpenAI key, issues per-install tokens, runs the demand/listing AI, stores history.
  Serves multiple extensions keyed by `extensionId` / `appKey`.
- **`helptools-landing/`** — marketing/landing + account dashboard (`helptools.org`).

## Commands

```bash
npm install
npm run dev          # Vite dev server with HMR (still load dist/ as an unpacked extension)
npm run build        # vue-tsc --noEmit && vite build  → dist/
npm run typecheck    # vue-tsc --noEmit
```

**No test suite and no linter.** CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs
`npm run typecheck` then `npm run build` — a clean build is the only automated bar.
`dist-zip/` holds versioned `.zip`s for Chrome Web Store submission.

## The build-time manifest (read this before touching manifest.json)

**`manifest.json` at the repo root is a TEMPLATE, not the shipped manifest.** Its
`content_scripts[0].matches` is literally `[]` and its `host_permissions` lists only the
non-marketplace hosts (the API + Amazon's image CDNs). [vite.config.ts](vite.config.ts) imports
`MARKETPLACE_HOST_GLOBS` from [src/marketplaces/hosts.ts](src/marketplaces/hosts.ts) and injects
those 21 Amazon TLD globs into **both** `content_scripts.matches` and `host_permissions` at build
time. The real manifest is `dist/manifest.json`.

Consequences:

- **You must load `dist/`, never the repo root.** Loading the root as an unpacked extension yields
  an extension whose content script matches nothing — it will install cleanly and do absolutely
  nothing, with no error anywhere. This is the single most likely reason "the extension isn't working".
- **Add domains to `hosts.ts`, not to `manifest.json`.** `hosts.ts` is the single source of truth
  for host scope and is deliberately dependency-free (no DOM, no `chrome`, no Vue) so the Vite
  config can import it at build time.
- A `VITE_BACKEND_BASE_URL` pointing at `localhost`/`127.0.0.1` also gets appended to
  `host_permissions` automatically, for local backend testing only.

## Architecture

Three extension contexts talk over `chrome.runtime` messaging; every message shape lives in
[src/lib/messages.ts](src/lib/messages.ts) (`RequestMessage` / `ResponseMessage`) — **change the
contract there first**, then update all three sides.

1. **Content script** ([src/content.ts](src/content.ts) → [src/content/InjectedApp.vue](src/content/InjectedApp.vue))
   — a floating indigo FAB bottom-right that expands into a Vue panel, mounted in a **Shadow DOM**
   (`#lz-helper-root`) so Amazon's CSS can't bleed in. Mounts only when
   `adapter.isProductUrl(location.href)` is true. Logs `[LZ-Helper] mounted on <url>`.
2. **Background service worker** ([src/background.ts](src/background.ts)) — the workhorse and the
   message router: builds the ZIP (fetch each asset → JSZip → `chrome.downloads`), calls the
   backend for demand/listing, enforces quotas via [src/lib/license.ts](src/lib/license.ts).
3. **Popup** ([src/popup/App.vue](src/popup/App.vue)) — renders the same
   [HelperPanel.vue](src/components/HelperPanel.vue) and drives the active tab by sending it
   `UI_*` commands, which `InjectedApp.vue`'s `commandListener` handles.

### Marketplace adapter pattern

Everything Amazon-specific lives behind one interface in [src/marketplaces/](src/marketplaces/):
`MarketplaceAdapter` ([types.ts](src/marketplaces/types.ts)), implemented by
[amazon.ts](src/marketplaces/amazon.ts), registered in the `ADAPTERS` array in
[index.ts](src/marketplaces/index.ts), host globs in [hosts.ts](src/marketplaces/hosts.ts).
**Amazon is currently the only adapter** (`Marketplace = "amazon" | "unknown"`), so the registry is
a one-element array — but the indirection is what lets `vite.config.ts` compose the manifest, so
don't collapse it.

### Amazon data sources ([src/marketplaces/amazon.ts](src/marketplaces/amazon.ts))

Verified live on amazon.com (2026-07-16). Both fetchers run in the page **MAIN world** via
`chrome.scripting.executeScript`, so they must be **self-contained — no imports, no closures over
module scope.**

- **ASIN** — `/dp/<ASIN>`, `/gp/product/<ASIN>`, or `/gp/aw/d/<ASIN>`, 10 chars. This alone decides
  "is this a product page".
- **Media** — the gallery is embedded in an inline script as
  `'colorImages': { 'initial': [ {"hiRes":…,"large":…,"thumb":…} ] }`. The outer keys are
  single-quoted (not JSON) but the array is valid JSON, so it's bracket-matched out and parsed.
  Stripping Amazon's size transform (`X._AC_SL1500_.jpg` → `X.jpg`) yields the original. Falls back
  to `#landingImage`'s `data-a-dynamic-image` plus the `#altImages` thumb rail.
- **Demand** — `#productTitle`, `.a-price .a-offscreen` (locale-aware money parsing),
  `#acrPopover[title]` (`"4.6 out of 5 stars"`), `#acrCustomerReviewText` (`"(280)"`), and a
  `body.innerText` regex for `"1K+ bought in past month"` — a genuine **monthly** sales figure.

### Backend

[src/lib/api/backend.ts](src/lib/api/backend.ts), Bearer install-token auth. The extension
registers once (`POST /v1/installs`), caches the opaque token + install id in
`chrome.storage.local`, and re-registers on any 401 before retrying. **`EXTENSION_ID` is `"amazon"`
and `postEvent` sends `appKey: "amazon"`** — both correct; the backend must have a matching
extension/app entry registered.

Endpoints used: `/v1/installs`, `/v1/billing/status`, `/v1/events`, `/v1/auth/link-token`,
`/v1/auth/unlink`, `/v1/demand/analyze`, `/v1/listing/generate`, `/v1/listing/presets`
(GET/POST/DELETE), `/v1/analysis/reviews` (wired but unreachable on Amazon).

Base URLs default to production and are overridable at build time: `VITE_BACKEND_BASE_URL`
(default `https://api.helptools.org`), `VITE_ACCOUNT_URL` (default `https://helptools.org/account`).

**Quotas: the backend is the source of truth.** [license.ts](src/lib/license.ts) mirrors per-feature
daily usage from `/v1/billing/status` (3-minute sync TTL, forced on every panel open), resetting at
UTC midnight. The `analysis: 10 / listing: 3 / demand: 2` figures in `license.ts`, `backend.ts` and
`InjectedApp.vue` are **cold-start fallbacks only** — never treat them as the real limits. PRO makes
`canConsume`/`consume` no-ops. Media download is free and unlimited, and is not a quota feature.

### i18n

[src/lib/i18n.ts](src/lib/i18n.ts) holds all UI strings for **15 locales** in one file
(`LOCALES`, `t(locale, key, params)`). Add user-facing strings as keys there, not inline.
Separately, `public/_locales/{en,ru}/messages.json` backs only the two `__MSG_*` manifest fields
(extension name and store description) — those two locales are not the UI locale set.

## Conventions & gotchas

- **Load `dist/`, and rebuild after every change** — see the manifest section above.
- **MAIN-world fetchers cannot import.** `amazonMediaFetcher` / `amazonDemandFetcher` are
  serialized and injected; keep them self-contained.
- **Media is images-only.** Amazon serves product video as HLS (`.m3u8`), which can't be packaged
  into the ZIP as a single file. The download modal is hard-coded to show a photo count only.
- **Navigation polling is intentional.** Amazon normally does full page loads, but variant and
  cached-page transitions can change the URL in place. The content UI polls `location.href` so it
  can reset product state without patching page-world history methods.
- **The Shadow DOM panel gets no page styles** — Tailwind comes in via `tailwind.css?inline`, and
  Tippy's CSS is injected into the same shadow root so tooltips render correctly.
- **Store claims must match real features.** Amazon has no margin calculator or review-analysis
  action. Keep `_locales`, `STORE_LISTING.md`, and `store-assets/` aligned with the three shipped
  features above.
- **Storage keys** (all `chrome.storage.local`): `backend_install_token`, `backend_install_id`,
  `lz_license_v1`, `lz_locale_v1`, `lz_show_floating_panel_v1`, `lz_last_preset_v1`, plus the
  history/cache keys in [analysisCache.ts](src/lib/analysisCache.ts).
- **Secrets:** `OPENAI_API_KEY` is server-side only (backend `.env`). Never put it in extension code.
