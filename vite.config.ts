import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { crx } from "@crxjs/vite-plugin";
import baseManifest from "./manifest.json" with { type: "json" };
import { MARKETPLACE_HOST_GLOBS } from "./src/marketplaces/hosts";

// The marketplace host globs (content-script matches + host_permissions) are
// derived from the adapter registry's `hosts.ts` — the single source of truth —
// so adding a marketplace's domains there updates the manifest automatically.
// manifest.json only carries the non-marketplace bits (api/proxy host perms).
//
// For local testing the extension talks to a dev backend (VITE_BACKEND_BASE_URL=
// http://localhost:8080). Content-script fetches (history mirroring) are subject
// to CORS unless the host is in host_permissions, so grant the dev backend host
// only for local builds. Production builds add nothing extra.
const devBackend = process.env.VITE_BACKEND_BASE_URL;
const isLocalBackend =
  !!devBackend && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(devBackend);

const manifest = {
  ...baseManifest,
  content_scripts: baseManifest.content_scripts.map((cs) => ({
    ...cs,
    matches: MARKETPLACE_HOST_GLOBS,
  })),
  host_permissions: [
    ...MARKETPLACE_HOST_GLOBS,
    ...baseManifest.host_permissions,
    ...(isLocalBackend ? [`${devBackend!.replace(/\/$/, "")}/*`] : []),
  ],
};

export default defineConfig({
  plugins: [vue(), crx({ manifest })],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    hmr: {
      host: "127.0.0.1",
      port: 5173,
    },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        popup: "src/popup/index.html",
      },
    },
  },
});
