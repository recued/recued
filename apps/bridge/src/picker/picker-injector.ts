/** "Watch this element" — picker injector (brick 3).
 *
 *  Injects the bundled picker content script (`build/picker/picker.js`)
 *  into the active tab when the side-panel "Watch this element" action
 *  fires. The picker then runs in the page (brick 2) and reports its
 *  outcome back over `chrome.runtime.sendMessage` (handled SW-side).
 *
 *  The chrome surface is injected (`PickerInjectorChromeApi`) so the
 *  query/scheme-check/inject logic is unit-testable with no real chrome.
 *  No manifest change is needed — `scripting` + `optional_host_permissions`
 *  are present; `executeScript({files})` runs a classic script (no
 *  `web_accessible_resources`). */

/** The injectable picker bundle, relative to the extension root. */
export const PICKER_SCRIPT_FILE = 'picker/picker.js';

/** Minimal active-tab view the injector needs. */
export interface PickerInjectorActiveTab {
  id?: number;
  url?: string;
}

/** The two chrome calls the injector makes, narrowed + injected for tests. */
export interface PickerInjectorChromeApi {
  /** `chrome.tabs.query({active:true, currentWindow:true})` → first tab. */
  queryActiveTab(): Promise<PickerInjectorActiveTab | null>;
  /** `chrome.scripting.executeScript({ target:{tabId}, files:[file] })`. */
  injectFile(tab_id: number, file: string): Promise<void>;
}

export type PickerInjectOutcome =
  | { ok: true }
  | {
      ok: false;
      /** `no_active_tab` — no usable active tab (or the query failed).
       *  `unsupported_page` — not an http/https page (chrome://, the New
       *  Tab page, the web store, a file://, …) where the picker can't run.
       *  `inject_failed` — executeScript rejected (host permission not
       *  granted for this origin, the page blocks injection, etc.). */
      reason: 'no_active_tab' | 'unsupported_page' | 'inject_failed';
      detail?: string;
    };

export interface BridgePickerInjector {
  injectIntoActiveTab(): Promise<PickerInjectOutcome>;
}

/** A page the picker can run on. Chrome refuses `executeScript` on
 *  privileged surfaces (`chrome://`, `chrome-extension://`, the web store,
 *  the New Tab page); restricting to http/https up front gives a clear
 *  message instead of an opaque inject rejection. */
export const isInjectableUrl = (url: string | undefined | null): boolean =>
  typeof url === 'string' &&
  (url.startsWith('http://') || url.startsWith('https://'));

export const createPickerInjector = (
  api: PickerInjectorChromeApi,
): BridgePickerInjector => ({
  async injectIntoActiveTab() {
    let tab: PickerInjectorActiveTab | null;
    try {
      tab = await api.queryActiveTab();
    } catch (err) {
      return {
        ok: false,
        reason: 'no_active_tab',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (tab === null || typeof tab.id !== 'number') {
      return { ok: false, reason: 'no_active_tab' };
    }
    if (!isInjectableUrl(tab.url)) {
      return { ok: false, reason: 'unsupported_page' };
    }
    try {
      await api.injectFile(tab.id, PICKER_SCRIPT_FILE);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: 'inject_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
