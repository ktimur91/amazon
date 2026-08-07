# Chrome Web Store listing — Amazon Helper

Copy-paste source for the Developer Dashboard. EN is the default listing; RU is a
localized variant. All store images live in `store-assets/`; the build ZIP is in
`dist-zip/`.

---

## Name (from `_locales`, localized per browser language)
- EN: **Amazon Product Research & Image Downloader — Listing AI**
- RU: **Amazon: анализ спроса и загрузчик фото + AI-карточки**

## Short description / summary (from `_locales`)
- EN: Amazon product research for sellers: monthly sales, opportunity score & margin calculator + image downloader and AI listing generator.
- RU: Анализ товара на Amazon для продавцов: продажи за месяц, оценка перспективности и калькулятор маржи + загрузчик фото и AI-генератор карточек.

## Category
**Workflow & Planning** ("Работа и планирование") — a B2B tool for Amazon sellers, matching the other HelpTools extensions.

## Language
English (default) · Russian (localized listing)

---

## Detailed description (EN)

Amazon Helper is a product-research toolkit for Amazon sellers (FBA/FBM), right on the product page.

▶ DEMAND RESEARCH
Before you source a product, see whether it's worth it. The extension reads the product's monthly sales ("bought in past month"), price, rating and review count and returns an opportunity score (0–100) plus a short AI verdict — so you can tell saturated niches from promising ones at a glance. A built-in margin calculator turns buy/sell/shipping/fees into profit, margin % and ROI.

▶ IMAGE DOWNLOADER
Grab all product photos from any Amazon page in one click, in original resolution, packed into a single ZIP — perfect for building your own listings, ads and research boards. Downloads are always free and unlimited.

▶ AI LISTING GENERATOR (PRO)
Turn a product page into a ready-to-publish Amazon listing — an SEO title, five selling-point bullets, a full description and backend search terms, written to Amazon's A9 search conventions. Save presets for how you like to write.

15 interface languages. Your install is anonymous — no account required to start. The image downloader is free forever; the AI features include a free daily allowance, with PRO for unlimited use.

Not affiliated with, endorsed by, or sponsored by Amazon.

---

## Подробное описание (RU)

Amazon Helper — набор инструментов для анализа товаров на Amazon для продавцов (FBA/FBM), прямо на странице товара.

▶ АНАЛИЗ СПРОСА
Прежде чем заходить в товар — проверьте, стоит ли. Расширение читает продажи за месяц («bought in past month»), цену, рейтинг и число отзывов и выдаёт оценку перспективности (0–100) и короткий AI-вердикт — чтобы с одного взгляда отличать перегретые ниши от перспективных. Встроенный калькулятор маржи считает прибыль, маржу % и ROI из закупки/продажи/доставки/комиссий.

▶ ЗАГРУЗЧИК ФОТО
Скачайте все фото товара с любой страницы Amazon в один клик, в оригинальном разрешении, одним ZIP — удобно для своих карточек, рекламы и ресёрча. Загрузка всегда бесплатна и без лимитов.

▶ AI-ГЕНЕРАТОР КАРТОЧЕК (PRO)
Превратите страницу товара в готовую карточку Amazon — SEO-заголовок, пять буллетов с выгодами, полное описание и backend-ключи под поиск A9. Сохраняйте пресеты под свой стиль.

15 языков интерфейса. Установка анонимна — аккаунт не нужен. Загрузчик фото бесплатен навсегда; у AI-функций есть бесплатный дневной лимит, PRO снимает ограничения.

Не аффилировано с Amazon и не одобрено им.

---

## Store images (`store-assets/`, exact px)

| Slot | EN file | RU file | Size |
|------|---------|---------|------|
| Store icon | `icon128.png` | — | 128×128 |
| Screenshot 1 — image downloader | `shot1.png` | `shot1-ru.png` | 1280×800 |
| Screenshot 2 — demand research | `shot2.png` | `shot2-ru.png` | 1280×800 |
| Screenshot 3 — AI listing | `shot3.png` | `shot3-ru.png` | 1280×800 |
| Screenshot 4 — free / PRO | `shot4.png` | `shot4-ru.png` | 1280×800 |
| Small promo tile | `promo-small.png` | `promo-small-ru.png` | 440×280 |
| Marquee promo tile | `promo-marquee.png` | `promo-marquee-ru.png` | 1400×560 |

> ⚠️ Don't name third-party review tools or other marketplaces in the listing.
> Naming Amazon (the platform the extension operates on) is fine and necessary.
> Icon is a neutral research glyph (magnifier + mini bar chart), NOT Amazon's logo.

---

## Privacy & permissions (Developer Dashboard → Privacy tab)

**Single purpose:** Help Amazon sellers research the product on the page they're viewing — demand/opportunity score, image download, and an AI Amazon listing draft.

**Privacy policy URL:** https://helptools.org/privacy

**Permission justifications:**
- `storage` — save the user's settings (interface language, panel options) and an anonymous install id locally.
- `activeTab` — read the Amazon product page the user is on, only when they click the extension, to collect images, price, rating and the monthly-sales figure for that tab.
- `scripting` — inject the on-page helper panel and run the data-collection code on the active tab when the user requests an action.
- `downloads` — save the product photos to the user's computer as a ZIP when they click download.
- Host `https://api.helptools.org/*` — the HelpTools backend for the AI features (demand verdict, listing) and licensing/quota.
- Host `https://*.media-amazon.com/*`, `https://*.ssl-images-amazon.com/*` — fetch full-resolution product images from Amazon's image CDNs to package into the ZIP.

**Remote code:** No — all logic ships in the package; the backend returns JSON, not code.

**Data disclosures — check only "Website content"** (product data sent to the backend for AI). No email/auth collected by the extension (account linking happens on helptools.org). Confirm all three certification checkboxes.

---

## Reviews are NOT a feature here
Amazon serves only ~8 curated reviews and ignores pagination/star filters, so review analysis is intentionally omitted — don't claim it in the listing.

## Build to upload
`npm run build` → `dist/` → zip into `dist-zip/amazon-helper-v<version>.zip` (manifest at root). Current version **1.0.0**. Bump the version for every re-upload (the store rejects a repeat).
