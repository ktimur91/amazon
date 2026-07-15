<script setup lang="ts">
import { onMounted, ref } from "vue";
import HelperPanel from "../components/HelperPanel.vue";
import {
  getHistory,
  onHistoryChanged,
  productIdFromUrl,
  setPendingAnalysisAction,
  wasMediaDownloaded,
  type HistoryEntry,
} from "../lib/analysisCache";
import {
  getStoredLocale,
  onStoredLocaleChanged,
  setStoredLocale,
  t,
  type LocaleCode,
} from "../lib/i18n";
import {
  getFloatingPanelEnabled,
  onFloatingPanelChanged,
  setFloatingPanelEnabled,
} from "../lib/settings";
import { ensureInstallId } from "../lib/api/backend";
import type { FeatureQuotas, RequestMessage, ResponseMessage } from "../lib/messages";

// This extension's own landing page; #pricing scrolls to its Free/PRO plans.
const UPGRADE_URL = "https://helptools.org/extensions/amazon#pricing";

type PanelMessage = { kind: "ok" | "err"; text: string } | null;
type TabCommand = {
  type:
    | "UI_DOWNLOAD_MEDIA"
    | "UI_ANALYZE_REVIEWS"
    | "UI_ANALYZE_REVIEWS_FORCE"
    | "UI_GENERATE_LISTING"
    | "UI_ANALYZE_DEMAND"
    | "UI_OPEN_CACHED_ANALYSIS";
};
type TabCommandResponse = { ok: true } | { ok: false; error: string };

const message = ref<PanelMessage>(null);
const pro = ref(false);
const quotas = ref<FeatureQuotas>({
  analysis: { used: 0, limit: 10 },
  listing: { used: 0, limit: 3 },
  demand: { used: 0, limit: 2 },
});
const resetAt = ref<number | null>(null);
const proExpiresAt = ref<number | null>(null);
const subStatus = ref<string | null>(null);
const customerPortalUrl = ref<string | null>(null);
const accountEmail = ref<string | null>(null);
const deviceName = ref<string | null>(null);
const online = ref(true);
const locale = ref<LocaleCode>("en");
const downloading = ref(false);
const analyzing = ref(false);
const generatingListing = ref(false);
const analyzingDemand = ref(false);
const downloaded = ref(false);
const floatingEnabled = ref(true);
const history = ref<HistoryEntry[]>([]);
// Active tab's product (for the "done" stepper state in HelperPanel).
const currentProductId = ref<string | null>(null);

const tr = (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) =>
  t(locale.value, key, params);

function sendRuntime<T extends ResponseMessage = ResponseMessage>(
  msg: RequestMessage,
): Promise<T> {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (response: T) => resolve(response)),
  );
}

async function sendToActiveTab(msg: TabCommand): Promise<TabCommandResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: tr("openProductPage") };

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id!, msg, (response: TabCommandResponse) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve({ ok: false, error: tr("openProductPage") });
        return;
      }
      resolve(response ?? { ok: true });
    });
  });
}

async function loadState(): Promise<void> {
  locale.value = await getStoredLocale();
  floatingEnabled.value = await getFloatingPanelEnabled();
  history.value = await getHistory();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  downloaded.value = tab?.url ? await wasMediaDownloaded(tab.url) : false;
  currentProductId.value = tab?.url ? productIdFromUrl(tab.url) : null;
  const response = await sendRuntime({ type: "LICENSE_CHECK" });
  if (response.ok && "quotas" in response) {
    pro.value = response.pro;
    quotas.value = response.quotas;
    resetAt.value = response.resetAt;
    proExpiresAt.value = response.proExpiresAt;
    subStatus.value = response.status;
    customerPortalUrl.value = response.customerPortalUrl;
    accountEmail.value = response.email;
    deviceName.value = response.deviceName;
    online.value = response.online;
  }
}

// The popup can't render the in-page result modal, so re-viewing opens the
// product page. For an analysis entry we queue a pending "open" so the panel
// auto-shows the saved result on load; listing/media just open the product.
async function viewEntry(entry: HistoryEntry): Promise<void> {
  message.value = null;
  if (entry.type === "analysis") {
    await setPendingAnalysisAction({
      productId: entry.productId,
      action: "open",
      createdAt: Date.now(),
    });
  }
  await chrome.tabs.create({ url: entry.url, active: true });
}

async function openUpgrade(): Promise<void> {
  // ensure (not just read) so the checkout always carries an install id, even
  // if the user upgrades before their first analysis registers the install.
  const installId = await ensureInstallId();
  const url = new URL(UPGRADE_URL);
  url.searchParams.set("src", "ext-popup");
  if (installId) url.searchParams.set("install", installId);
  await chrome.tabs.create({ url: url.toString(), active: true });
}

async function changeLocale(next: LocaleCode): Promise<void> {
  locale.value = next;
  await setStoredLocale(next);
}

async function changeFloatingEnabled(enabled: boolean): Promise<void> {
  floatingEnabled.value = enabled;
  await setFloatingPanelEnabled(enabled);
}

async function runTabAction(
  command: TabCommand,
  kind: "media" | "reviews" | "listing" | "demand",
): Promise<void> {
  message.value = null;
  const flag =
    kind === "media"
      ? downloading
      : kind === "listing"
        ? generatingListing
        : kind === "demand"
          ? analyzingDemand
          : analyzing;
  flag.value = true;
  try {
    const response = await sendToActiveTab(command);
    if (!response.ok) {
      message.value = { kind: "err", text: response.error };
    }
    await loadState();
  } finally {
    flag.value = false;
  }
}

onMounted(() => {
  void loadState();
  onStoredLocaleChanged((next) => {
    locale.value = next;
  });
  onFloatingPanelChanged((enabled) => {
    floatingEnabled.value = enabled;
  });
  onHistoryChanged(() => {
    void getHistory().then((items) => {
      history.value = items;
    });
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        downloaded.value = tab?.url ? await wasMediaDownloaded(tab.url) : false;
        currentProductId.value = tab?.url ? productIdFromUrl(tab.url) : null;
      });
  });
});
</script>

<template>
  <HelperPanel
    :locale="locale"
    :pro="pro"
    :quotas="quotas"
    :reset-at="resetAt"
    :pro-expires-at="proExpiresAt"
    :status="subStatus"
    :customer-portal-url="customerPortalUrl"
    :email="accountEmail"
    :device-name="deviceName"
    :online="online"
    :downloading="downloading"
    :analyzing="analyzing"
    :generating-listing="generatingListing"
    :analyzing-demand="analyzingDemand"
    :downloaded="downloaded"
    :message="message"
    :floating-enabled="floatingEnabled"
    :show-history="true"
    :history="history"
    :current-product-id="currentProductId"
    @update:locale="changeLocale"
    @update:floating-enabled="changeFloatingEnabled"
    @upgrade="openUpgrade"
    @refresh-status="loadState"
    @auth-changed="loadState"
    @download-media="runTabAction({ type: 'UI_DOWNLOAD_MEDIA' }, 'media')"
    @analyze-reviews="runTabAction({ type: 'UI_ANALYZE_REVIEWS' }, 'reviews')"
    @generate-listing="runTabAction({ type: 'UI_GENERATE_LISTING' }, 'listing')"
    @analyze-demand="runTabAction({ type: 'UI_ANALYZE_DEMAND' }, 'demand')"
    @view-entry="viewEntry"
  />
</template>
