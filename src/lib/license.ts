import { getBillingStatus } from "./api/backend";
import type { FeatureQuotas, QuotaFeature } from "./messages";

interface LicenseState {
  pro: boolean;
  key: string | null;
  proExpiresAt: number | null; // epoch ms; null = no expiry / not PRO
  quotas: FeatureQuotas; // per-feature daily usage/limit — mirrored from the backend
  online: boolean; // whether the last backend sync succeeded (health)
  lastSyncAt: number | null; // epoch ms of last backend entitlement sync
  status: string | null; // Lemon Squeezy status (active, cancelled, ...)
  customerPortalUrl: string | null; // portal to manage/cancel the subscription
  email: string | null; // signed-in account email (null if not signed in)
  deviceName: string | null; // this install's friendly name (matches the account Devices list)
}

const KEY = "lz_license_v1";

// Cold-start fallback ONLY (before the first backend sync). The real limits are
// always the backend's per-feature limits — the extension never hardcodes them.
const DEFAULT_QUOTAS: FeatureQuotas = {
  analysis: { used: 0, limit: 10 },
  listing: { used: 0, limit: 3 },
  demand: { used: 0, limit: 2 },
};

function cloneDefaultQuotas(): FeatureQuotas {
  return {
    analysis: { ...DEFAULT_QUOTAS.analysis },
    listing: { ...DEFAULT_QUOTAS.listing },
    demand: { ...DEFAULT_QUOTAS.demand },
  };
}

// How long a backend entitlement sync is trusted before refreshing. Keeps the
// frequent canConsume()/getStatus() calls cheap while still reacting to
// subscription changes (e.g. a failed renewal) within a few minutes.
const SYNC_TTL_MS = 3 * 60_000;

/** Epoch ms of the next quota reset (UTC midnight). */
function nextResetAt(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

async function read(): Promise<LicenseState> {
  const r = await chrome.storage.local.get(KEY);
  const stored = r[KEY] as Partial<LicenseState> | undefined;
  return {
    pro: stored?.pro ?? false,
    key: stored?.key ?? null,
    proExpiresAt: stored?.proExpiresAt ?? null,
    quotas: stored?.quotas ?? cloneDefaultQuotas(),
    online: stored?.online ?? true,
    lastSyncAt: stored?.lastSyncAt ?? null,
    status: stored?.status ?? null,
    customerPortalUrl: stored?.customerPortalUrl ?? null,
    email: stored?.email ?? null,
    deviceName: stored?.deviceName ?? null,
  };
}

async function write(s: LicenseState): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}

/** A PRO license is active only if it has no expiry or the expiry is in the future. */
function isProActive(s: LicenseState): boolean {
  if (!s.pro) return false;
  if (s.proExpiresAt && s.proExpiresAt <= Date.now()) return false;
  return true;
}

/**
 * Pull the authoritative PRO entitlement from the backend (driven by Lemon
 * Squeezy webhooks) and mirror it into local storage. Best-effort: on any
 * network/HTTP error the local state is left untouched so the extension keeps
 * working offline with the last known status. Returns true if a sync happened.
 */
export async function syncFromBackend(): Promise<boolean> {
  const status = await getBillingStatus();
  const s = await read();
  if (!status) {
    // Backend unreachable — flag offline, keep the last-known entitlement/quota.
    if (s.online) {
      s.online = false;
      await write(s);
    }
    return false;
  }
  s.pro = status.proActive;
  // currentPeriodEnd is when access lapses if the subscription does not renew
  // (e.g. card declined). null => no known expiry (treated as active-no-expiry).
  s.proExpiresAt = status.currentPeriodEnd
    ? Date.parse(status.currentPeriodEnd) || null
    : null;
  s.status = status.status;
  s.customerPortalUrl = status.customerPortalUrl;
  s.email = status.email;
  s.deviceName = status.deviceName;
  s.quotas = status.quotas;
  s.online = true;
  s.lastSyncAt = Date.now();
  await write(s);
  return true;
}

/** Sync from the backend only if the cached entitlement is older than the TTL. */
async function maybeSync(): Promise<void> {
  const s = await read();
  if (s.lastSyncAt && Date.now() - s.lastSyncAt < SYNC_TTL_MS) return;
  await syncFromBackend();
}

export async function getStatus(options?: { force?: boolean }): Promise<{
  pro: boolean;
  quotas: FeatureQuotas;
  online: boolean;
  resetAt: number;
  proExpiresAt: number | null;
  status: string | null;
  customerPortalUrl: string | null;
  email: string | null;
  deviceName: string | null;
}> {
  // `force` (used when the user opens the popup/panel) always hits the backend
  // so a just-purchased subscription reflects immediately; otherwise TTL-gated.
  if (options?.force) await syncFromBackend();
  else await maybeSync();

  const s = await read();
  const pro = isProActive(s);
  return {
    pro,
    // Quota mirrors the backend (single source of truth).
    quotas: s.quotas ?? cloneDefaultQuotas(),
    online: s.online,
    resetAt: nextResetAt(),
    proExpiresAt: pro ? s.proExpiresAt : null,
    status: pro ? s.status : null,
    customerPortalUrl: pro ? s.customerPortalUrl : null,
    // email reflects the signed-in account regardless of plan.
    email: s.email,
    deviceName: s.deviceName,
  };
}

export async function canConsume(feature: QuotaFeature): Promise<boolean> {
  const { pro, quotas } = await getStatus();
  const q = quotas[feature];
  return pro || q.used < q.limit;
}

export async function consume(feature: QuotaFeature): Promise<void> {
  const s = await read();
  if (isProActive(s)) return;
  // Optimistic local bump for instant UI; the next backend sync corrects it.
  const quotas = s.quotas ?? cloneDefaultQuotas();
  quotas[feature] = {
    used: (quotas[feature]?.used ?? 0) + 1,
    limit: quotas[feature]?.limit ?? DEFAULT_QUOTAS[feature].limit,
  };
  s.quotas = quotas;
  await write(s);
}

/**
 * Validate license key against a remote endpoint (LemonSqueezy-style).
 * The vendor endpoint URL is read from import.meta.env.VITE_LICENSE_API,
 * with a safe offline-friendly fallback: any key matching ^LZ-PRO-[A-Z0-9]{8,}$
 * is treated as valid for development.
 */
export async function activate(key: string): Promise<boolean> {
  const cleaned = key.trim();
  if (!cleaned) return false;

  const endpoint = import.meta.env.VITE_LICENSE_API as string | undefined;
  let valid = false;

  if (endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license_key: cleaned }),
      });
      const data = (await res.json().catch(() => ({}))) as { valid?: boolean };
      valid = Boolean(data?.valid);
    } catch {
      valid = false;
    }
  } else {
    valid = /^LZ-PRO-[A-Z0-9]{8,}$/.test(cleaned);
  }

  if (valid) {
    const s = await read();
    s.pro = true;
    s.key = cleaned;
    // No real subscription billing yet (Lemon Squeezy pending), so PRO has no
    // expiry. Once billing is live, set s.proExpiresAt from the vendor response.
    s.proExpiresAt = null;
    await write(s);
  }
  return valid;
}
