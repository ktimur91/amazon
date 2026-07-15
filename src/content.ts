// Content script — Shadow-DOM-isolated Vue UI on aliexpress.ru / aliexpress.com
import { createApp, type App } from "vue";
import VueTippy from "vue-tippy";
import InjectedApp from "./content/InjectedApp.vue";
import { getAdapterByHost } from "./marketplaces";
import tailwindCss from "./styles/tailwind.css?inline";
import tippyCss from "tippy.js/dist/tippy.css?inline";

const HOST_ID = "lz-helper-root";
let app: App | null = null;

/**
 * Detect whether the current URL is a product page (not search / home /
 * category). The per-marketplace URL shapes live in each adapter's
 * `isProductUrl`, so this stays marketplace-agnostic.
 */
function isProductPage(): boolean {
  return getAdapterByHost()?.isProductUrl(location.href) ?? false;
}

function mount(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  // Inline styles win over `:host { ... }` rules, so we must set the font
  // properties HERE (otherwise `all: initial` resets font-family for the
  // whole shadow subtree to the browser default, e.g. Times serif).
  host.style.cssText = [
    // "all: initial",
    "position: fixed",
    "z-index: 2147483647",
    'font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    "font-size: 16px",
    "color: #111827",
  ].join("; ");
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  // `:host` fallback (in case some marketplace stylesheet manages to override
  // the inline style with `!important`). Preflight handles the rest INSIDE
  // the shadow tree.
  const base = document.createElement("style");
  base.textContent = `
    :host {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
      font-size: 16px !important;
      color: #111827 !important;
    }
  `;
  shadow.appendChild(base);

  const style = document.createElement("style");
  style.textContent = tailwindCss;
  shadow.appendChild(style);

  // Tippy renders into `appendTo` (below) and needs its own CSS in the SAME
  // root — inject it into the shadow tree so tooltips are styled here, not in
  // the page. The extra rules size the tooltip (the shadow `:host` font-size is
  // 16px and `max-width` alone only caps width, leaving the box too narrow).
  const tippyStyle = document.createElement("style");
  tippyStyle.textContent = `${tippyCss}
    .tippy-box { width: max-content; max-width: 260px !important; font-size: 12px; line-height: 1.45; }
    .tippy-box .tippy-content { white-space: normal; padding: 7px 10px; }
  `;
  shadow.appendChild(tippyStyle);

  const appRoot = document.createElement("div");
  shadow.appendChild(appRoot);

  app = createApp(InjectedApp);
  // Tooltips: render inside the shadow root (so the injected CSS applies and the
  // page can't clip/style them), above the panel/modal stacking.
  app.use(VueTippy, {
    defaultProps: {
      appendTo: () => appRoot,
      zIndex: 2147483647,
      delay: [150, 0],
      allowHTML: false,
      maxWidth: 280,
    },
  });
  app.mount(appRoot);
  console.log("[LZ-Helper] mounted on", location.href);
}

function unmount(): void {
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  app?.unmount();
  app = null;
  host.remove();
  console.log("[LZ-Helper] unmounted");
}

function sync(): void {
  if (isProductPage()) mount();
  else unmount();
}

// SPA navigation handling. AliExpress navigate via pushState in the PAGE's
// main world. A content script runs in an isolated world, so monkey-patching
// `history.pushState` here only catches navigations triggered from this script
// — it never sees the marketplace's own routing. The reliable cross-world
// approach is to poll `location.href` for changes.
let lastHref = location.href;
function onMaybeLocationChange(): void {
  if (location.href === lastHref) return;
  lastHref = location.href;
  // AliExpress swap the DOM asynchronously after the URL changes; give the
  // new product page a moment to render before (re)mounting.
  setTimeout(sync, 400);
}

window.addEventListener("popstate", onMaybeLocationChange);
window.addEventListener("hashchange", onMaybeLocationChange);
// Poll as a robust fallback for main-world pushState navigations that don't
// emit any event observable from the isolated world.
setInterval(onMaybeLocationChange, 700);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", sync, { once: true });
} else {
  sync();
}
