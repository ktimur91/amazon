const FLOATING_PANEL_KEY = "lz_show_floating_panel_v1";

export async function getFloatingPanelEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(FLOATING_PANEL_KEY);
  const value = stored[FLOATING_PANEL_KEY];
  return typeof value === "boolean" ? value : true;
}

export async function setFloatingPanelEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [FLOATING_PANEL_KEY]: enabled });
}

export function onFloatingPanelChanged(cb: (enabled: boolean) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = changes[FLOATING_PANEL_KEY]?.newValue;
    if (typeof next === "boolean") cb(next);
  });
}
