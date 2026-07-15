<script setup lang="ts">
import {
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Download,
  ExternalLink,
  FileText,
  Globe,
  History as HistoryIcon,
  Info,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  RotateCw,
  Settings,
  Store,
  TrendingUp,
  TriangleAlert,
  UserRound,
  Zap,
} from "@lucide/vue";
import type { Component } from "vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { HistoryEntry } from "../lib/analysisCache";
import { LOCALES, t, type LocaleCode } from "../lib/i18n";
import type {
  FeatureQuotas,
  QuotaFeature,
  RequestMessage,
  ResponseMessage,
} from "../lib/messages";

const OFFICIAL_SITE_URL = "https://helptools.org";
const WEB_STORE_URL = "https://chromewebstore.google.com/detail/lhkeophpelaeglokkaldhfnmkoaipnec";

type PanelMessage = { kind: "ok" | "err"; text: string } | null;

const props = withDefaults(
  defineProps<{
    locale: LocaleCode;
    pro: boolean;
    quotas: FeatureQuotas;
    downloading?: boolean;
    analyzing?: boolean;
    generatingListing?: boolean;
    analyzingDemand?: boolean;
    downloaded?: boolean;
    resetAt?: number | null;
    proExpiresAt?: number | null;
    status?: string | null;
    customerPortalUrl?: string | null;
    email?: string | null;
    deviceName?: string | null;
    online?: boolean;
    error?: string | null;
    message?: PanelMessage;
    showFloatingToggle?: boolean;
    floatingEnabled?: boolean;
    showHistory?: boolean;
    history?: HistoryEntry[];
    // The product currently open (origin+path); used to mark which stage
    // actions are already "done" for this product (green stepper state).
    currentProductId?: string | null;
  }>(),
  {
    downloading: false,
    analyzing: false,
    generatingListing: false,
    analyzingDemand: false,
    downloaded: false,
    resetAt: null,
    proExpiresAt: null,
    status: null,
    customerPortalUrl: null,
    email: null,
    deviceName: null,
    online: true,
    error: null,
    message: null,
    showFloatingToggle: true,
    floatingEnabled: true,
    showHistory: false,
    history: () => [],
    currentProductId: null,
  },
);

const emit = defineEmits<{
  "update:locale": [locale: LocaleCode];
  "update:floatingEnabled": [enabled: boolean];
  upgrade: [];
  refreshStatus: [];
  authChanged: [];
  downloadMedia: [];
  analyzeReviews: [];
  generateListing: [];
  analyzeDemand: [];
  viewEntry: [entry: HistoryEntry];
}>();

const tr = (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) =>
  t(props.locale, key, params);

// --- Account / auth ---------------------------------------------------------
function sendRuntime(msg: RequestMessage): Promise<ResponseMessage> {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (r: ResponseMessage) => resolve(r)),
  );
}

// Sign-in & management live on the landing /account page; the panel just opens
// it (the background attaches a one-time device-link token).
async function onOpenAccount(): Promise<void> {
  await sendRuntime({ type: "AUTH_OPEN_ACCOUNT" });
}

async function onLogout(): Promise<void> {
  await sendRuntime({ type: "AUTH_LOGOUT" });
  emit("authChanged");
}

function onUpgrade(): void {
  emit("upgrade");
}

function onRefreshStatus(): void {
  emit("refreshStatus");
}

function changeFloating(event: Event): void {
  emit("update:floatingEnabled", (event.target as HTMLInputElement).checked);
}

// --- Language picker (custom dropdown: flag + code → flag + full name) -------
const langOpen = ref(false);
const currentLocale = computed(
  () => LOCALES.find((l) => l.code === props.locale) ?? LOCALES[2],
);
function toggleLang(): void {
  langOpen.value = !langOpen.value;
}
function pickLocale(code: LocaleCode): void {
  langOpen.value = false;
  if (code !== props.locale) emit("update:locale", code);
}

// --- Stage stepper ----------------------------------------------------------
type StepId = "demand" | "analysis" | "media" | "listing";
type StepState = "active" | "pending" | "done" | "exhausted";

interface StepDef {
  id: StepId;
  icon: Component;
  title: string;
  sub: string;
  bold: boolean;
  feature: QuotaFeature | null; // null → media (no daily limit)
  loading: boolean;
  event: "analyzeDemand" | "analyzeReviews" | "downloadMedia" | "generateListing";
}

const steps = computed<StepDef[]>(() => [
  {
    id: "demand",
    icon: TrendingUp,
    title: tr("histDemand"),
    sub: tr("actDemandSub"),
    bold: true,
    feature: "demand",
    loading: props.analyzingDemand,
    event: "analyzeDemand",
  },
  // NOTE: no "analysis" (AI review) action on Amazon. Amazon serves only ~8
  // curated, mostly-positive reviews and ignores pagination/star filters, so a
  // review verdict would mislead a seller. The plumbing (props/emits/backend)
  // is intentionally left in place in case Amazon ever opens reviews up.
  {
    id: "media",
    icon: Download,
    title: tr("actMedia"),
    sub: allExhausted.value ? tr("actMediaNoLimit") : tr("actMediaSub"),
    bold: false,
    feature: null,
    loading: props.downloading,
    event: "downloadMedia",
  },
  {
    id: "listing",
    icon: FileText,
    title: tr("actListing"),
    sub: tr("actListingSub"),
    bold: false,
    feature: "listing",
    loading: props.generatingListing,
    event: "generateListing",
  },
]);

const stage1 = computed(() => steps.value.filter((s) => s.id === "demand" || s.id === "analysis"));
const stage2 = computed(() => steps.value.filter((s) => s.id === "media" || s.id === "listing"));

// Which actions are already done for the open product (history is the source of
// truth: any saved analysis/demand/listing or a media download marks it done).
const doneSet = computed<Record<StepId, boolean>>(() => {
  const set: Record<StepId, boolean> = {
    demand: false,
    analysis: false,
    media: props.downloaded,
    listing: false,
  };
  const pid = props.currentProductId;
  if (pid) {
    for (const e of props.history) {
      if (e.productId !== pid) continue;
      if (e.type === "demand") set.demand = true;
      else if (e.type === "analysis") set.analysis = true;
      else if (e.type === "listing") set.listing = true;
      else if (e.type === "download") set.media = true;
    }
  }
  return set;
});

function isExhausted(s: StepDef): boolean {
  if (props.pro || !s.feature) return false;
  const q = props.quotas[s.feature];
  return q.used >= q.limit;
}

// Backend-dependent actions are disabled when the service is unreachable; media
// download is local and always works.
function isOfflineDisabled(s: StepDef): boolean {
  return !props.online && s.feature !== null;
}

// The single accented "next step": first action that is neither done nor
// exhausted (offline-disabled actions are skipped so the accent doesn't land on
// a button you can't press).
const activeStepId = computed<StepId | null>(() => {
  for (const s of steps.value) {
    if (doneSet.value[s.id]) continue;
    if (isExhausted(s)) continue;
    if (isOfflineDisabled(s)) continue;
    return s.id;
  }
  return null;
});

function stateOf(s: StepDef): StepState {
  if (s.loading) return "active";
  if (isExhausted(s)) return "exhausted";
  if (doneSet.value[s.id]) return "done";
  return s.id === activeStepId.value ? "active" : "pending";
}

// All daily limits used up (free plan, every limited action at its cap).
// Computed straight from quotas (NOT from `steps`) to avoid a reactive cycle —
// `steps` reads `allExhausted` for the media subtitle.
// "analysis" is excluded — the AI review action isn't offered on Amazon.
const LIMITED_FEATURES: QuotaFeature[] = ["listing", "demand"];
const allExhausted = computed(
  () =>
    !props.pro &&
    LIMITED_FEATURES.every((k) => props.quotas[k].used >= props.quotas[k].limit),
);

function onStepClick(s: StepDef): void {
  if (s.loading || isOfflineDisabled(s)) return;
  // Exhausted still emits — the parent shows the upgrade prompt for that action.
  if (s.event === "analyzeDemand") emit("analyzeDemand");
  else if (s.event === "analyzeReviews") emit("analyzeReviews");
  else if (s.event === "downloadMedia") emit("downloadMedia");
  else emit("generateListing");
}

function badgeText(s: StepDef): string {
  if (!s.feature) return "";
  const q = props.quotas[s.feature];
  return `${Math.min(q.used, q.limit)} / ${q.limit}`;
}

// Per-state class tables (mirror the design tokens).
const BTN: Record<StepState, string> = {
  pending:
    "tw-bg-white tw-border-[#ededf3] tw-text-[#7a7a88] hover:-tw-translate-y-px hover:tw-border-[#d7d2f3] hover:tw-bg-[#faf9ff] hover:tw-shadow-[0_5px_16px_rgba(20,20,40,0.07)]",
  active:
    "tw-bg-gradient-to-br tw-from-[#6354ff] tw-to-[#4b3fd6] tw-border-transparent tw-text-white tw-shadow-[0_8px_20px_rgba(83,75,224,0.28)] hover:-tw-translate-y-px hover:tw-shadow-[0_11px_26px_rgba(83,75,224,0.36)] hover:tw-brightness-105",
  done: "tw-bg-[#f0faf4] tw-border-[#cdebd8] tw-text-[#1f5b3a]",
  exhausted:
    "tw-bg-white tw-border-[#f4d9d6] tw-text-[#7a7268] tw-cursor-not-allowed hover:tw-bg-[#fff7f6] hover:tw-border-[#f0ccc8]",
};
const TILE: Record<StepState, string> = {
  pending: "tw-bg-[#f4f4f9] tw-text-[#b0b0be]",
  active: "tw-bg-white/[0.18] tw-text-white",
  done: "tw-bg-[#d8f3e2] tw-text-[#1f9d57]",
  exhausted: "tw-bg-[#fdecea] tw-text-[#d05a4e]",
};
const SUB: Record<StepState, string> = {
  pending: "tw-text-[#a8a8b6]",
  active: "tw-text-white/[0.82]",
  done: "tw-text-[#5a9678]",
  exhausted: "tw-text-[#c0392b]",
};
const BADGE: Record<StepState, string> = {
  pending: "tw-bg-[#f3f3f7] tw-text-[#a0a0b0]",
  active: "tw-bg-white/20 tw-text-white",
  done: "tw-bg-[#d8f3e2] tw-text-[#1f9d57]",
  exhausted: "tw-bg-[#fdecea] tw-text-[#c0392b]",
};

// --- History ----------------------------------------------------------------
function historyTime(createdAt: number): string {
  return new Intl.DateTimeFormat(props.locale, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

function typeLabel(type: HistoryEntry["type"]): string {
  if (type === "download") return tr("histMedia");
  if (type === "listing") return tr("histListing");
  if (type === "demand") return tr("histDemand");
  return tr("histAnalysis");
}
// Result-chip colour per action (rounded pill, design palette).
function chipClass(type: HistoryEntry["type"]): string {
  if (type === "download") return "tw-bg-[#f1f1f6] tw-text-[#7c8696]";
  if (type === "listing") return "tw-bg-[#f1effe] tw-text-[#5b4be6]";
  if (type === "demand") return "tw-bg-[#e8f0fe] tw-text-[#2563c9]";
  return "tw-bg-[#e6f7ee] tw-text-[#15824b]";
}
function langTag(locale?: string): string {
  return (locale ?? "").toUpperCase();
}
const VERDICT_GLYPH: Record<string, string> = {
  excellent: "👍",
  mixed: "😐",
  poor: "⚠️",
  no_data: "—",
};
// Chip label shows the final result inline: listing → platform tag, demand →
// score, analysis → verdict glyph.
function entryLabel(e: HistoryEntry): string {
  if (e.type === "listing") return e.listing?.presetShort || tr("histListing");
  if (e.type === "demand" && typeof e.demand?.opportunityScore === "number")
    return `${tr("histDemand")} ${e.demand.opportunityScore}`;
  if (e.type === "analysis" && e.analysis?.verdict)
    return `${tr("histAnalysis")} ${VERDICT_GLYPH[e.analysis.verdict] ?? ""}`.trim();
  return typeLabel(e.type);
}

function storeKey(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "—";
  }
}

const selectedStore = ref<string | null>(null);

const storeGroups = computed(() => {
  const map = new Map<string, HistoryEntry[]>();
  for (const item of props.history) {
    const key = storeKey(item.url);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
});

const storeTabs = computed(() => Array.from(storeGroups.value.keys()));

const activeStore = computed(() => {
  const tabs = storeTabs.value;
  if (selectedStore.value && tabs.includes(selectedStore.value)) {
    return selectedStore.value;
  }
  return tabs[0] ?? null;
});

const visibleHistory = computed(() => {
  if (!activeStore.value) return [];
  return storeGroups.value.get(activeStore.value) ?? [];
});

// One card per product: group the active store's entries by productId.
interface ProductGroup {
  productId: string;
  title: string;
  imageUrl?: string;
  url: string;
  createdAt: number;
  entries: HistoryEntry[];
}
const productGroups = computed<ProductGroup[]>(() => {
  const map = new Map<string, ProductGroup>();
  for (const e of visibleHistory.value) {
    const g = map.get(e.productId);
    if (g) {
      g.entries.push(e);
      if (e.createdAt > g.createdAt) {
        g.createdAt = e.createdAt;
        g.title = e.productTitle || g.title;
        if (e.imageUrl) g.imageUrl = e.imageUrl;
        g.url = e.url;
      }
    } else {
      map.set(e.productId, {
        productId: e.productId,
        title: e.productTitle,
        ...(e.imageUrl ? { imageUrl: e.imageUrl } : {}),
        url: e.url,
        createdAt: e.createdAt,
        entries: [e],
      });
    }
  }
  return [...map.values()]
    .map((g) => ({
      ...g,
      entries: [...g.entries].sort((a, b) => b.createdAt - a.createdAt),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
});

function selectStore(key: string): void {
  selectedStore.value = key;
}

function storeProductCount(store: string): number {
  return new Set((storeGroups.value.get(store) ?? []).map((e) => e.productId))
    .size;
}

// --- Plan strip helpers -----------------------------------------------------
const resetTime = computed(() =>
  props.resetAt
    ? new Intl.DateTimeFormat(props.locale, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(props.resetAt))
    : "",
);

const expiryDate = computed(() =>
  props.proExpiresAt
    ? new Intl.DateTimeFormat(props.locale, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(new Date(props.proExpiresAt))
    : "",
);

// PRO whose auto-renew is off: access continues until proExpiresAt, flagged so
// the user knows it won't renew.
const proCancelled = computed(() => props.pro && props.status === "cancelled");
const proBadgeTitle = computed(() => {
  if (!props.pro || !props.proExpiresAt) return "";
  return proCancelled.value
    ? tr("proCancelledUntil", { date: expiryDate.value })
    : tr("proUntil", { date: expiryDate.value });
});

// Close the language menu on Escape for keyboard users.
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") langOpen.value = false;
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="tw-flex tw-w-full tw-flex-col tw-gap-[14px] tw-text-sm tw-text-[#16161f]">
    <!-- Top bar: logo + language dropdown -->
    <header class="tw-flex tw-items-center tw-justify-between tw-gap-3">
      <div class="tw-min-w-0 tw-truncate tw-text-[16px] tw-font-extrabold tw-tracking-[-0.01em] tw-text-[#16161f]">
        Amazon
        <span class="tw-font-bold tw-text-[#9a9aac]">Helper</span>
      </div>

      <div class="tw-relative tw-shrink-0">
        <button
          type="button"
          class="lz-cta tw-flex tw-items-center tw-gap-1.5 tw-rounded-full tw-border tw-border-[#ecedf3] tw-bg-white tw-px-2.5 tw-py-1.5 tw-text-xs tw-font-extrabold tw-text-[#4a4a5c]"
          @click="toggleLang"
        >
          <span class="tw-text-[14px] tw-leading-none">{{ currentLocale.flag }}</span>
          <span>{{ currentLocale.code.toUpperCase() }}</span>
          <ChevronDown class="tw-h-3 tw-w-3 tw-text-[#b4b4c4]" :stroke-width="2.4" />
        </button>
        <!-- backdrop: click anywhere outside to close -->
        <div v-if="langOpen" class="tw-fixed tw-inset-0 tw-z-40" @click="langOpen = false"></div>
        <div
          v-if="langOpen"
          class="tw-absolute tw-right-0 tw-top-[calc(100%+6px)] tw-z-50 tw-max-h-[260px] tw-min-w-[160px] tw-overflow-y-auto tw-rounded-[12px] tw-border tw-border-[#ececf3] tw-bg-white tw-p-1 tw-shadow-[0_12px_30px_rgba(20,20,40,0.13)]"
        >
          <button
            v-for="l in LOCALES"
            :key="l.code"
            type="button"
            class="tw-flex tw-w-full tw-items-center tw-gap-2.5 tw-rounded-lg tw-px-2.5 tw-py-2 tw-text-left tw-text-[13px] tw-font-bold tw-text-[#2a2540] tw-transition hover:tw-bg-[#f5f4ff]"
            :class="l.code === locale ? 'tw-bg-[#f1effe]' : ''"
            @click="pickLocale(l.code)"
          >
            <span class="tw-text-[15px] tw-leading-none">{{ l.flag }}</span>
            {{ l.label }}
          </button>
        </div>
      </div>
    </header>

    <!-- Transient message / error -->
    <div
      v-if="message"
      class="tw-rounded-lg tw-px-3 tw-py-2 tw-text-xs"
      :class="message.kind === 'ok' ? 'tw-bg-emerald-50 tw-text-emerald-700' : 'tw-bg-red-50 tw-text-red-700'"
    >
      {{ message.text }}
    </div>
    <div v-if="error" class="tw-rounded-lg tw-bg-red-50 tw-px-3 tw-py-2 tw-text-xs tw-text-red-700">
      {{ error }}
    </div>

    <!-- Account card -->
    <section>
      <div class="tw-rounded-[13px] tw-border tw-border-[#eeeef4] tw-bg-white tw-px-3 tw-py-2.5">
        <!-- Identity row -->
        <div class="tw-flex tw-items-center tw-gap-2.5">
          <span
            class="tw-flex tw-h-8 tw-w-8 tw-shrink-0 tw-items-center tw-justify-center tw-rounded-full"
            :class="email ? 'tw-bg-[#f0eefe] tw-text-[#5b4be6]' : 'tw-bg-[#f1f1f6] tw-text-[#a2a2b2]'"
          >
            <UserRound class="tw-h-[17px] tw-w-[17px]" :stroke-width="1.8" />
          </span>

          <button
            v-if="email"
            type="button"
            class="tw-flex tw-min-w-0 tw-flex-1 tw-flex-col tw-text-left"
            :title="tr('manageSubscription')"
            @click="onOpenAccount"
          >
            <span class="tw-flex tw-min-w-0 tw-items-center tw-gap-1.5">
              <span class="tw-min-w-0 tw-truncate tw-text-[13.5px] tw-font-bold tw-text-[#1c1c28]">{{ email }}</span>
              <span
                v-if="pro"
                class="tw-shrink-0 tw-rounded-full tw-border tw-border-[#f3dca0] tw-bg-[#fff6e5] tw-px-2 tw-py-px tw-text-[10px] tw-font-extrabold tw-text-[#b7791f]"
                :class="proCancelled ? 'tw-opacity-90' : ''"
                :title="proBadgeTitle"
                >PRO</span
              >
            </span>
            <span v-if="deviceName" class="tw-truncate tw-text-[11.5px] tw-font-semibold tw-text-[#9a9aac]">
              {{ tr("thisDevice") }}: {{ deviceName }}
            </span>
          </button>
          <div v-else class="tw-flex tw-min-w-0 tw-flex-1 tw-flex-col">
            <span class="tw-text-[13.5px] tw-font-bold tw-text-[#1c1c28]">{{ tr("guest") }}</span>
            <span class="tw-truncate tw-text-[11.5px] tw-font-semibold tw-text-[#9a9aac]">{{ tr("guestSub") }}</span>
          </div>

          <button
            v-if="email"
            type="button"
            class="tw-flex tw-shrink-0 tw-items-center tw-gap-1 tw-rounded-md tw-px-1 tw-py-0.5 tw-text-xs tw-font-bold tw-text-[#9a9aac] tw-transition hover:tw-text-[#5b5b6b]"
            @click="onLogout"
          >
            <LogOut class="tw-h-3.5 tw-w-3.5" :stroke-width="2" />
            {{ tr("logout") }}
          </button>
          <button
            v-else
            type="button"
            class="lz-cta tw-flex tw-shrink-0 tw-items-center tw-gap-1.5 tw-rounded-full tw-bg-[#5b4be6] tw-px-3 tw-py-1.5 tw-text-xs tw-font-bold tw-text-white"
            @click="onOpenAccount"
          >
            <ExternalLink class="tw-h-3.5 tw-w-3.5" :stroke-width="2" />
            {{ tr("signIn") }}
          </button>
        </div>

        <!-- Plan row (free only): hidden entirely on PRO -->
        <template v-if="!pro">
          <div class="tw-my-2.5 tw-h-px tw-bg-[#ececf3]"></div>
          <div class="tw-flex tw-items-center tw-justify-between tw-gap-2">
            <div class="tw-flex tw-min-w-0 tw-items-center tw-gap-2">
              <span class="tw-shrink-0 tw-rounded-full tw-bg-[#ececf2] tw-px-2 tw-py-0.5 tw-text-[10.5px] tw-font-extrabold tw-text-[#5a5a6e]">{{ tr("free") }}</span>
              <span v-if="resetTime" class="tw-truncate tw-text-[11.5px] tw-font-semibold tw-text-[#a6a6b8]">{{ tr("resetShort", { time: resetTime }) }}</span>
              <button
                type="button"
                class="tw-shrink-0 tw-text-[#c0c0cc] tw-transition hover:tw-text-[#8f8fa0]"
                :title="tr('refreshStatus')"
                @click="onRefreshStatus"
              >
                <RotateCw class="tw-h-3 tw-w-3" :stroke-width="2" />
              </button>
            </div>
            <button
              type="button"
              class="lz-cta tw-flex tw-shrink-0 tw-items-center tw-gap-1 tw-rounded-full tw-border tw-border-[#f3dca0] tw-bg-[#fff6e5] tw-px-3 tw-py-1 tw-text-[11.5px] tw-font-extrabold tw-text-[#b7791f]"
              @click="onUpgrade"
            >
              <ChevronsUp class="tw-h-3 tw-w-3" :stroke-width="2.4" />
              {{ tr("buyPro") }}
            </button>
          </div>
        </template>
      </div>

      <!-- Guest info banner -->
      <div
        v-if="!email"
        class="tw-mt-2 tw-flex tw-items-start tw-gap-2 tw-rounded-[12px] tw-border tw-border-[#e6e3fb] tw-bg-[#f4f3ff] tw-px-3 tw-py-2 tw-text-[11.5px] tw-leading-4 tw-text-[#5b5b78]"
      >
        <Info class="tw-mt-px tw-h-3.5 tw-w-3.5 tw-shrink-0 tw-text-[#5b4be6]" :stroke-width="2" />
        <span>{{ tr("guestBanner") }}</span>
      </div>
    </section>

    <!-- All-limits-exhausted banner -->
    <div
      v-if="allExhausted"
      class="tw-flex tw-items-center tw-gap-3 tw-rounded-[14px] tw-bg-gradient-to-br tw-from-[#6354ff] tw-to-[#4b3fd6] tw-px-3.5 tw-py-3 tw-text-white tw-shadow-[0_8px_20px_rgba(83,75,224,0.28)]"
    >
      <span class="tw-flex tw-h-8 tw-w-8 tw-shrink-0 tw-items-center tw-justify-center tw-rounded-[10px] tw-bg-white/[0.18]">
        <Zap class="tw-h-[18px] tw-w-[18px]" :stroke-width="2" />
      </span>
      <div class="tw-min-w-0 tw-flex-1">
        <div class="tw-text-[13px] tw-font-extrabold tw-leading-tight">{{ tr("allLimitsTitle") }}</div>
        <div class="tw-text-[11.5px] tw-font-semibold tw-text-white/[0.85]">{{ tr("allLimitsSub", { time: resetTime }) }}</div>
      </div>
      <button
        type="button"
        class="lz-cta tw-shrink-0 tw-rounded-full tw-bg-white tw-px-3 tw-py-1.5 tw-text-[11.5px] tw-font-extrabold tw-text-[#5b4be6]"
        @click="onUpgrade"
      >
        PRO
      </button>
    </div>

    <!-- Offline notice -->
    <div
      v-if="!online"
      class="tw-flex tw-items-start tw-gap-2 tw-rounded-[12px] tw-border tw-border-amber-200 tw-bg-amber-50 tw-px-3 tw-py-2 tw-text-xs tw-leading-5 tw-text-amber-800"
    >
      <TriangleAlert class="tw-mt-0.5 tw-h-3.5 tw-w-3.5 tw-shrink-0" />
      <span>{{ tr("backendOffline") }}</span>
    </div>

    <!-- Stage 1 -->
    <div>
      <div class="tw-mb-2 tw-flex tw-items-center tw-gap-2 tw-px-0.5">
        <span class="tw-text-[11px] tw-font-extrabold tw-text-[#5b4be6]">{{ tr("stage1") }}</span>
        <span class="tw-text-[11px] tw-font-bold tw-tracking-[0.03em] tw-text-[#aeaebe]">{{ tr("stageEval") }}</span>
        <span class="tw-h-px tw-flex-1 tw-bg-[#eff0f4]"></span>
      </div>
      <div class="tw-flex tw-flex-col tw-gap-[9px]">
        <button
          v-for="s in stage1"
          :key="s.id"
          type="button"
          class="lz-step tw-flex tw-w-full tw-items-center tw-gap-[11px] tw-rounded-[14px] tw-border-[1.5px] tw-px-3.5 tw-py-3 tw-text-left tw-transition"
          :class="BTN[stateOf(s)]"
          @click="onStepClick(s)"
        >
          <span
            class="tw-flex tw-h-[34px] tw-w-[34px] tw-shrink-0 tw-items-center tw-justify-center tw-rounded-[10px]"
            :class="TILE[stateOf(s)]"
          >
            <LoaderCircle v-if="s.loading" class="tw-h-[19px] tw-w-[19px] tw-animate-spin" :stroke-width="2" />
            <component v-else :is="s.icon" class="tw-h-[19px] tw-w-[19px]" :stroke-width="1.9" />
          </span>
          <span class="tw-min-w-0 tw-flex-1">
            <span class="tw-block tw-text-[15px] tw-leading-tight" :class="s.bold ? 'tw-font-extrabold' : 'tw-font-bold'">{{ s.title }}</span>
            <span class="tw-mt-px tw-block tw-text-[12px] tw-font-semibold" :class="SUB[stateOf(s)]">
              {{ stateOf(s) === "exhausted" ? tr("limitReachedSub") : s.sub }}
            </span>
          </span>
          <span
            v-if="s.feature && !pro"
            class="tw-shrink-0 tw-rounded-full tw-px-2.5 tw-py-[5px] tw-text-[13px] tw-font-extrabold"
            :class="BADGE[stateOf(s)]"
            >{{ badgeText(s) }}</span
          >
        </button>
      </div>
    </div>

    <!-- Stage 2 -->
    <div>
      <div class="tw-mb-2 tw-flex tw-items-center tw-gap-2 tw-px-0.5">
        <span class="tw-text-[11px] tw-font-extrabold tw-text-[#5b4be6]">{{ tr("stage2") }}</span>
        <span class="tw-text-[11px] tw-font-bold tw-tracking-[0.03em] tw-text-[#aeaebe]">{{ tr("stageCard") }}</span>
        <span class="tw-h-px tw-flex-1 tw-bg-[#eff0f4]"></span>
      </div>
      <div class="tw-flex tw-flex-col tw-gap-[9px]">
        <button
          v-for="s in stage2"
          :key="s.id"
          type="button"
          class="lz-step tw-flex tw-w-full tw-items-center tw-gap-[11px] tw-rounded-[14px] tw-border-[1.5px] tw-px-3.5 tw-py-3 tw-text-left tw-transition"
          :class="BTN[stateOf(s)]"
          @click="onStepClick(s)"
        >
          <span
            class="tw-flex tw-h-[34px] tw-w-[34px] tw-shrink-0 tw-items-center tw-justify-center tw-rounded-[10px]"
            :class="TILE[stateOf(s)]"
          >
            <LoaderCircle v-if="s.loading" class="tw-h-[19px] tw-w-[19px] tw-animate-spin" :stroke-width="2" />
            <component v-else :is="s.icon" class="tw-h-[19px] tw-w-[19px]" :stroke-width="1.9" />
          </span>
          <span class="tw-min-w-0 tw-flex-1">
            <span class="tw-block tw-text-[15px] tw-font-bold tw-leading-tight">
              {{ s.title }}<span v-if="s.id === 'media'" class="tw-text-[11px] tw-font-bold tw-opacity-50"> (ZIP)</span>
            </span>
            <span class="tw-mt-px tw-block tw-text-[12px] tw-font-semibold" :class="SUB[stateOf(s)]">
              {{ stateOf(s) === "exhausted" ? tr("limitReachedSub") : s.sub }}
            </span>
          </span>
          <span
            v-if="s.feature && !pro"
            class="tw-shrink-0 tw-rounded-full tw-px-2.5 tw-py-[5px] tw-text-[13px] tw-font-extrabold"
            :class="BADGE[stateOf(s)]"
            >{{ badgeText(s) }}</span
          >
        </button>
      </div>
    </div>

    <!-- History -->
    <section v-if="showHistory">
      <div class="tw-mb-2.5 tw-flex tw-items-center tw-gap-2">
        <span class="tw-text-[11px] tw-font-extrabold tw-tracking-[0.09em] tw-text-[#aeaebe]">{{ tr("activityHistory").toUpperCase() }}</span>
        <span class="tw-h-px tw-flex-1 tw-bg-[#eff0f4]"></span>
      </div>

      <!-- Store tabs: only when more than one source -->
      <div v-if="storeTabs.length > 1" class="tw-relative tw-mb-3">
        <div class="lz-tabs tw-flex tw-gap-4 tw-overflow-x-auto tw-pr-7 tw-text-[13px]">
          <button
            v-for="key in storeTabs"
            :key="key"
            type="button"
            class="tw-flex tw-shrink-0 tw-items-center tw-gap-1.5 tw-whitespace-nowrap tw-pb-1.5"
            :class="key === activeStore ? 'tw-border-b-2 tw-border-[#5b4be6] tw-font-extrabold tw-text-[#5b4be6]' : 'tw-font-bold tw-text-[#a2a2b2]'"
            @click="selectStore(key)"
          >
            {{ key }}
            <span
              class="tw-rounded-full tw-px-1.5 tw-py-px tw-text-[11px] tw-font-extrabold"
              :class="key === activeStore ? 'tw-bg-[#f1effe] tw-text-[#5b4be6]' : 'tw-bg-[#f1f1f6] tw-text-[#a2a2b2]'"
              >{{ storeProductCount(key) }}</span
            >
          </button>
        </div>
        <div class="tw-pointer-events-none tw-absolute tw-inset-y-0 tw-right-0 tw-flex tw-w-12 tw-items-center tw-justify-end tw-bg-gradient-to-l tw-from-white tw-from-60% tw-to-transparent">
          <span class="tw-mb-1.5 tw-flex tw-h-6 tw-w-6 tw-items-center tw-justify-center tw-rounded-full tw-border tw-border-[#e7e7ef] tw-bg-white tw-text-[#5b4be6] tw-shadow-[0_2px_6px_rgba(20,20,40,0.12)]">
            <ChevronRight class="tw-h-4 tw-w-4" :stroke-width="2.6" />
          </span>
        </div>
      </div>

      <!-- Product cards -->
      <div v-if="productGroups.length" class="tw-grid tw-max-h-[320px] tw-gap-2 tw-overflow-y-auto tw-pr-0.5">
        <article
          v-for="g in productGroups"
          :key="g.productId"
          class="tw-flex tw-gap-3 tw-rounded-[13px] tw-border tw-border-[#eeeef4] tw-p-3"
        >
          <img
            v-if="g.imageUrl"
            :src="g.imageUrl"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
            class="tw-h-[54px] tw-w-[54px] tw-shrink-0 tw-rounded-[10px] tw-border tw-border-[#eeeef4] tw-bg-white tw-object-cover"
            @error="($event.target as HTMLImageElement).style.display = 'none'"
          />
          <div
            v-else
            class="tw-h-[54px] tw-w-[54px] tw-shrink-0 tw-rounded-[10px]"
            style="background: repeating-linear-gradient(45deg, #f2f2f7, #f2f2f7 6px, #e9e9f0 6px, #e9e9f0 12px)"
          ></div>
          <div class="tw-min-w-0 tw-flex-1">
            <a
              class="tw-line-clamp-2 tw-text-[13px] tw-font-bold tw-leading-snug tw-text-[#1e1e2a] hover:tw-text-[#5b4be6]"
              :href="g.url"
              target="_blank"
              rel="noreferrer"
            >
              {{ g.title || g.url }}
            </a>
            <div class="tw-mt-1 tw-text-[11px] tw-font-semibold tw-text-[#aeaebe]">{{ historyTime(g.createdAt) }}</div>
            <div class="tw-mt-1.5 tw-flex tw-flex-wrap tw-items-center tw-gap-1.5">
              <button
                v-for="e in g.entries"
                :key="e.key"
                type="button"
                class="tw-rounded-full tw-px-2.5 tw-py-[3px] tw-text-[11px] tw-font-bold tw-transition hover:tw-brightness-95"
                :class="chipClass(e.type)"
                :title="e.type === 'download' ? tr('histOpen') : tr('histView')"
                @click="emit('viewEntry', e)"
              >
                {{ entryLabel(e) }}<span v-if="e.locale" class="tw-opacity-70"> · {{ langTag(e.locale) }}</span>
              </button>
            </div>
          </div>
        </article>
      </div>

      <!-- Empty history -->
      <div
        v-else
        class="tw-flex tw-flex-col tw-items-center tw-gap-2 tw-rounded-[14px] tw-border-[1.5px] tw-border-dashed tw-border-[#e6e6ef] tw-px-4 tw-py-5 tw-text-center"
      >
        <span class="tw-flex tw-h-9 tw-w-9 tw-items-center tw-justify-center tw-rounded-[10px] tw-bg-[#f4f4f9] tw-text-[#a8a8b8]">
          <HistoryIcon class="tw-h-[18px] tw-w-[18px]" :stroke-width="2" />
        </span>
        <div class="tw-text-[14px] tw-font-bold tw-text-[#5b5b6b]">{{ tr("emptyHistTitle") }}</div>
        <div class="tw-text-[12.5px] tw-font-semibold tw-text-[#a6a6b8]">{{ tr("emptyHistHint") }}</div>
      </div>
    </section>

    <!-- Floating-button toggle (popup only) -->
    <label
      v-if="showFloatingToggle"
      class="tw-flex tw-items-center tw-gap-2.5 tw-rounded-[12px] tw-border tw-border-[#eeeef4] tw-px-3 tw-py-2.5"
    >
      <Settings class="tw-h-4 tw-w-4 tw-shrink-0 tw-text-[#a8a8b8]" />
      <span class="tw-flex-1 tw-text-[13px] tw-font-semibold tw-text-[#5b5b6b]">{{ tr("showFloatingButton") }}</span>
      <input class="tw-h-4 tw-w-4 tw-accent-[#5b4be6]" type="checkbox" :checked="floatingEnabled" @change="changeFloating" />
    </label>

    <!-- Footer links -->
    <footer class="tw-mt-0.5 tw-mb-2 tw-flex tw-items-center tw-justify-center tw-gap-3.5 tw-border-t tw-border-[#f0f0f5] tw-pt-3.5">
      <a
        class="tw-inline-flex tw-items-center tw-gap-1.5 tw-text-[13px] tw-font-bold tw-text-[#7c8696] hover:tw-text-[#5b4be6]"
        :href="OFFICIAL_SITE_URL"
        target="_blank"
        rel="noreferrer"
      >
        <Globe class="tw-h-[15px] tw-w-[15px]" :stroke-width="1.8" />
        helptools.org
      </a>
      <span class="tw-h-[3px] tw-w-[3px] tw-rounded-full tw-bg-[#cfd3da]"></span>
      <a
        class="tw-inline-flex tw-items-center tw-gap-1.5 tw-text-[13px] tw-font-bold tw-text-[#7c8696] hover:tw-text-[#5b4be6]"
        :href="WEB_STORE_URL"
        target="_blank"
        rel="noreferrer"
      >
        <Store class="tw-h-[15px] tw-w-[15px]" :stroke-width="1.8" />
        Chrome Web Store
      </a>
    </footer>
  </div>
</template>
