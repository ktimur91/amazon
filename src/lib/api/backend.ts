// Client for the shared extensions backend (helptools.org).
//
// Responsibilities:
//   - Register this install once and cache an opaque token in chrome.storage.local.
//   - Call the authenticated review-analysis endpoint.
//
// The backend keeps the OpenAI key server-side; the extension only ever holds
// an install token. See extensions-backend for the API contract.
import type {
  DemandResult,
  DemandSignals,
  FeatureQuotas,
  ListingContext,
  ListingPreset,
  ListingResult,
  QuotaFeature,
  ReviewStats,
  ReviewVerdict,
} from "../messages";

// Defaults to production; override at build time with
// VITE_BACKEND_BASE_URL=http://localhost:8080 for local testing.
const BACKEND_BASE_URL =
  (import.meta.env.VITE_BACKEND_BASE_URL as string | undefined) ||
  "https://api.helptools.org";
// Identifies this extension to the shared backend (capability gating + per-app
// quota/billing). The backend must register a matching extension + app entry.
const EXTENSION_ID = "amazon";
const TOKEN_KEY = "backend_install_token";
const INSTALL_ID_KEY = "backend_install_id";

interface InstallResponse {
  installId: string;
  token: string;
  extensionId: string;
}

export interface BackendReview {
  rating: number;
  text: string;
}

export interface BackendAnalysisArgs {
  marketplace: "amazon";
  reviews: BackendReview[];
  language: string;
  productUrl?: string;
  productTitle?: string;
}

export interface BackendAnalysis {
  summary: string;
  issues: string[];
  pros: string[];
  cons: string[];
  verdict: ReviewVerdict;
  stats?: ReviewStats;
}

async function readStoredToken(): Promise<string | null> {
  const data = await chrome.storage.local.get(TOKEN_KEY);
  const token = data[TOKEN_KEY];
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function registerInstall(): Promise<string> {
  const res = await fetch(`${BACKEND_BASE_URL}/v1/installs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extensionId: EXTENSION_ID }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Install registration failed ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as InstallResponse;
  if (!data.token) throw new Error("Install registration returned no token");
  await chrome.storage.local.set({
    [TOKEN_KEY]: data.token,
    [INSTALL_ID_KEY]: data.installId,
  });
  return data.token;
}

async function getInstallToken(): Promise<string> {
  return (await readStoredToken()) ?? (await registerInstall());
}

/// The opaque install id (uuid) for this browser, if the install has been
/// registered. Safe to pass in URLs (it is NOT the secret token) so the landing
/// can link this install to a user account after sign-in. Returns null if the
/// extension has not registered with the backend yet.
export async function getStoredInstallId(): Promise<string | null> {
  const data = await chrome.storage.local.get(INSTALL_ID_KEY);
  const id = data[INSTALL_ID_KEY];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/// Ensure this browser has a registered install and return its opaque install
/// id, registering on first call. Use this (not getStoredInstallId) where an
/// install id MUST exist — e.g. building the upgrade/checkout link, so the
/// billing webhook can link the resulting subscription to this install even if
/// the user upgrades before ever running an analysis. Returns null only when
/// registration fails (offline); callers then proceed without an install id.
export async function ensureInstallId(): Promise<string | null> {
  const existing = await getStoredInstallId();
  if (existing) return existing;
  try {
    await getInstallToken(); // registers + persists INSTALL_ID_KEY
  } catch {
    return null;
  }
  return getStoredInstallId();
}

export interface BillingStatus {
  plan: "free" | "pro";
  status: string | null; // Lemon Squeezy status (active, past_due, expired, ...)
  proActive: boolean;
  currentPeriodEnd: string | null; // ISO date when PRO access lapses if unpaid
  customerPortalUrl: string | null; // Lemon Squeezy portal to manage/cancel
  email: string | null; // signed-in account email (null if not signed in)
  deviceName: string | null; // this install's friendly name (matches the account's Devices list)
  quotas: FeatureQuotas; // per-feature daily usage/limit (backend = source of truth)
}

// Cold-start fallback limits (before the first backend sync), matching the
// backend env defaults. The real limits always come from billing/status.
const FALLBACK_LIMITS: Record<QuotaFeature, number> = {
  analysis: 10,
  listing: 3,
  demand: 2,
};

function parseQuotas(value: unknown): FeatureQuotas {
  const src = (value ?? {}) as Partial<
    Record<QuotaFeature, { used?: unknown; limit?: unknown }>
  >;
  const one = (f: QuotaFeature) => {
    const q = src[f] ?? {};
    return {
      used: typeof q.used === "number" ? q.used : 0,
      limit: typeof q.limit === "number" ? q.limit : FALLBACK_LIMITS[f],
    };
  };
  return { analysis: one("analysis"), listing: one("listing"), demand: one("demand") };
}

/// Fetch the install's PRO entitlement from the backend (server-side source of
/// truth, driven by Lemon Squeezy webhooks). Registers the install on first use
/// and retries once on a stale token. Returns null on any network/HTTP error so
/// callers can fall back to the last known local state (offline-friendly).
export async function getBillingStatus(): Promise<BillingStatus | null> {
  try {
    let token = await getInstallToken();
    let res = await fetch(`${BACKEND_BASE_URL}/v1/billing/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      await chrome.storage.local.remove(TOKEN_KEY);
      token = await registerInstall();
      res = await fetch(`${BACKEND_BASE_URL}/v1/billing/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<BillingStatus>;
    return {
      plan: data.plan === "pro" ? "pro" : "free",
      status: typeof data.status === "string" ? data.status : null,
      proActive: Boolean(data.proActive),
      currentPeriodEnd:
        typeof data.currentPeriodEnd === "string"
          ? data.currentPeriodEnd
          : null,
      customerPortalUrl:
        typeof data.customerPortalUrl === "string"
          ? data.customerPortalUrl
          : null,
      email: typeof data.email === "string" ? data.email : null,
      deviceName: typeof data.deviceName === "string" ? data.deviceName : null,
      quotas: parseQuotas((data as { quotas?: unknown }).quotas),
    };
  } catch {
    return null;
  }
}

async function authPost(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status?: BillingStatus; error?: string }> {
  const token = await getInstallToken();
  const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as
    | Partial<BillingStatus>
    | { error?: { message?: string } };
  if (!res.ok) {
    const message =
      (data as { error?: { message?: string } })?.error?.message ??
      `Request failed (${res.status})`;
    return { ok: false, error: message };
  }
  return { ok: true, status: data as BillingStatus };
}

export interface ActivityEvent {
  type: "analysis" | "download" | "listing" | "demand";
  group?: string;
  language?: string;
  productRef?: string;
  title?: string;
  imageUrl?: string;
  payload?: unknown;
}

/// Mirror an activity event (analysis / download) to the backend so it shows up
/// in the user's account history. Best-effort: the backend only persists it when
/// this install is signed in to an account, and any failure is swallowed so the
/// extension UX never depends on it.
export async function postEvent(event: ActivityEvent): Promise<void> {
  try {
    const token = await getInstallToken();
    await fetch(`${BACKEND_BASE_URL}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ appKey: "amazon", ...event }),
    });
  } catch {
    /* history mirroring must never break the UX */
  }
}

// Defaults to production; override at build time with
// VITE_ACCOUNT_URL=http://localhost:3000/account for local testing.
const ACCOUNT_URL =
  (import.meta.env.VITE_ACCOUNT_URL as string | undefined) ||
  "https://helptools.org/account";

/// Build the landing /account URL carrying a one-time link token so the web
/// page (after the user signs in there) can bind THIS install to the account.
/// Falls back to the plain account URL if the token can't be issued.
export async function accountUrl(): Promise<string> {
  try {
    const token = await getInstallToken();
    const res = await fetch(`${BACKEND_BASE_URL}/v1/auth/link-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (res.ok) {
      const data = (await res.json()) as { linkToken?: string };
      if (data.linkToken) {
        return `${ACCOUNT_URL}?link=${encodeURIComponent(data.linkToken)}`;
      }
    }
  } catch {
    /* offline — open the account page without linking */
  }
  return ACCOUNT_URL;
}

/// Sign out on this device (unlink the install from the account).
export async function unlinkAccount(): Promise<{
  ok: boolean;
  status?: BillingStatus;
  error?: string;
}> {
  return authPost("/v1/auth/unlink", {});
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
}

async function postAnalysis(
  token: string,
  args: BackendAnalysisArgs,
): Promise<Response> {
  return fetch(`${BACKEND_BASE_URL}/v1/analysis/reviews`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      marketplace: args.marketplace,
      language: args.language || "en",
      productUrl: args.productUrl,
      productTitle: args.productTitle,
      reviews: args.reviews.map((r) => ({ rating: r.rating, text: r.text })),
    }),
  });
}

/// Analyze marketplace reviews via the shared backend.
/// Registers the install on first use and retries once if the token is stale.
export async function analyzeReviewsViaBackend(
  args: BackendAnalysisArgs,
): Promise<BackendAnalysis> {
  let token = await getInstallToken();
  let res = await postAnalysis(token, args);

  // Stored token revoked/invalid: re-register once and retry.
  if (res.status === 401) {
    await chrome.storage.local.remove(TOKEN_KEY);
    token = await registerInstall();
    res = await postAnalysis(token, args);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Backend ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    summary?: string;
    issues?: unknown;
    pros?: unknown;
    cons?: unknown;
    verdict?: ReviewVerdict;
    stats?: ReviewStats;
  };

  return {
    summary: (data.summary ?? "").trim(),
    issues: toStringArray(data.issues),
    pros: toStringArray(data.pros),
    cons: toStringArray(data.cons),
    verdict: data.verdict ?? "no_data",
    stats: data.stats,
  };
}

export interface BackendListingArgs {
  marketplace: "amazon";
  productUrl?: string;
  productTitle: string;
  language: string;
  presetId?: string;
  extraInstructions?: string;
  context?: ListingContext;
}

function postListing(token: string, args: BackendListingArgs): Promise<Response> {
  return fetch(`${BACKEND_BASE_URL}/v1/listing/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      marketplace: args.marketplace,
      language: args.language || "en",
      productUrl: args.productUrl,
      productTitle: args.productTitle,
      presetId: args.presetId,
      extraInstructions: args.extraInstructions,
      context: args.context,
    }),
  });
}

/// Generate a marketplace-optimized listing via the shared backend.
/// Registers the install on first use and retries once if the token is stale.
/// Surfaces "QUOTA_EXCEEDED" as the error message so the UI can prompt upgrade.
export async function generateListingViaBackend(
  args: BackendListingArgs,
): Promise<ListingResult> {
  let token = await getInstallToken();
  let res = await postListing(token, args);

  if (res.status === 401) {
    await chrome.storage.local.remove(TOKEN_KEY);
    token = await registerInstall();
    res = await postListing(token, args);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429 || /quota/i.test(body)) throw new Error("QUOTA_EXCEEDED");
    throw new Error(`Backend ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as Partial<ListingResult>;
  return {
    title: (data.title ?? "").trim(),
    description: (data.description ?? "").trim(),
    bullets: Array.isArray(data.bullets) ? data.bullets.map((s) => String(s).trim()).filter(Boolean) : [],
    tags: Array.isArray(data.tags) ? data.tags.map((s) => String(s).trim()).filter(Boolean) : [],
    language: data.language ?? args.language,
    presetId: data.presetId,
    presetLabel: data.presetLabel,
    presetShort: data.presetShort,
    usage: data.usage,
  };
}

export interface BackendDemandArgs {
  marketplace: "amazon";
  productUrl?: string;
  productTitle: string;
  language: string;
  signals: DemandSignals;
}

function postDemand(token: string, args: BackendDemandArgs): Promise<Response> {
  return fetch(`${BACKEND_BASE_URL}/v1/demand/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      marketplace: args.marketplace,
      language: args.language || "en",
      productUrl: args.productUrl,
      productTitle: args.productTitle,
      signals: args.signals,
    }),
  });
}

/// Run a demand snapshot via the shared backend. Registers the install on first
/// use and retries once on a stale token. Surfaces "QUOTA_EXCEEDED" so the UI
/// can prompt upgrade.
export async function analyzeDemandViaBackend(
  args: BackendDemandArgs,
): Promise<DemandResult> {
  let token = await getInstallToken();
  let res = await postDemand(token, args);

  if (res.status === 401) {
    await chrome.storage.local.remove(TOKEN_KEY);
    token = await registerInstall();
    res = await postDemand(token, args);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429 || /quota/i.test(body)) throw new Error("QUOTA_EXCEEDED");
    throw new Error(`Backend ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as Partial<DemandResult>;
  return {
    sold: data.sold ?? null,
    soldLabel: data.soldLabel ?? null,
    price: data.price ?? null,
    priceMax: data.priceMax ?? null,
    currency: data.currency ?? null,
    ratingAvg: data.ratingAvg ?? null,
    ratingCount: data.ratingCount ?? null,
    revenueEstimate: data.revenueEstimate ?? null,
    opportunityScore: typeof data.opportunityScore === "number" ? data.opportunityScore : 0,
    scoreBreakdown:
      data.scoreBreakdown && typeof data.scoreBreakdown === "object"
        ? {
            demand: Number(data.scoreBreakdown.demand) || 0,
            qualityGap: Number(data.scoreBreakdown.qualityGap) || 0,
          }
        : { demand: 0, qualityGap: 0 },
    verdict: (data.verdict ?? "").trim(),
    language: data.language ?? args.language,
    usage: data.usage,
  };
}

/// List listing presets (built-in + the user's custom). Empty list on error.
export async function listPresets(): Promise<ListingPreset[]> {
  try {
    let token = await getInstallToken();
    let res = await fetch(`${BACKEND_BASE_URL}/v1/listing/presets`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      await chrome.storage.local.remove(TOKEN_KEY);
      token = await registerInstall();
      res = await fetch(`${BACKEND_BASE_URL}/v1/listing/presets`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    if (!res.ok) return [];
    const data = (await res.json()) as { presets?: ListingPreset[] };
    return Array.isArray(data.presets) ? data.presets : [];
  } catch {
    return [];
  }
}

/// Save a custom preset (PRO). Throws on error so the UI can surface it.
export async function savePreset(input: {
  name: string;
  basePresetId?: string;
  instructions?: string;
}): Promise<ListingPreset> {
  const token = await getInstallToken();
  const res = await fetch(`${BACKEND_BASE_URL}/v1/listing/presets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 403) throw new Error("PRO_REQUIRED");
    if (res.status === 401) throw new Error("SIGN_IN_REQUIRED");
    throw new Error(`Backend ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as ListingPreset;
}

/// Delete a custom preset.
export async function deletePreset(id: string): Promise<void> {
  const token = await getInstallToken();
  await fetch(`${BACKEND_BASE_URL}/v1/listing/presets/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}
