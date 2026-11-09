/** The toolbar icon opens the side panel — the bridge's only page.
 *
 *  0.0.1 put a pairing popup on the icon and swapped it for the side panel
 *  once paired, with `chrome.action.setPopup`. Chrome does not keep that
 *  swap: every browser restart and extension reload put the popup back, so a
 *  paired bridge offered its pair form again and a second try at the spent
 *  code was refused. The manifest has no popup now; the side panel shows the
 *  pair form itself while the bridge is unpaired.
 *
 *  `setPanelBehavior({ openPanelOnActionClick: true })` makes a click open
 *  the panel in the browser, without this worker. Chrome keeps that setting
 *  across restarts (verified 2026-10-10: set on one launch, read back true
 *  on the next without being set again). It is set again on every worker
 *  start anyway, which costs nothing.
 *
 *  The `action.onClicked` listener is the fallback for a Chrome where the
 *  behaviour did not take: Chrome fires `onClicked` only when a click opens
 *  nothing else. It opens the panel straight from the event, so the click
 *  still counts as the user gesture `sidePanel.open` requires.
 *
 *  ⛔ CALL THIS AT MODULE LOAD, BEFORE ANYTHING AWAITS. A click that wakes
 *  the worker is delivered to the listeners registered during the script's
 *  first run; the bootstrap registers its listeners only after the
 *  IndexedDB open resolves. */

/** `chrome.action.onClicked`. */
export interface ChromeActionOnClickedApi {
  addListener(handler: (tab: { id?: number; windowId?: number }) => void): void;
}

/** The `chrome.sidePanel` calls used here. */
export interface ChromeSidePanelApi {
  open(opts: { tabId?: number; windowId?: number }): Promise<void> | void;
  setPanelBehavior?(behavior: { openPanelOnActionClick: boolean }): Promise<void> | void;
}

export interface ToolbarIconChrome {
  action?: { onClicked: ChromeActionOnClickedApi };
  sidePanel?: ChromeSidePanelApi;
}

const ignoreRejection = (out: Promise<void> | void): void => {
  if (out && typeof (out as Promise<void>).catch === 'function') {
    (out as Promise<void>).catch(() => {
      /* best-effort */
    });
  }
};

export const wireToolbarIconToSidePanel = (chrome: ToolbarIconChrome | undefined): void => {
  const sidePanel = chrome?.sidePanel;
  if (!sidePanel) return;
  try {
    ignoreRejection(sidePanel.setPanelBehavior?.({ openPanelOnActionClick: true }));
  } catch {
    /* the onClicked fallback below still opens the panel */
  }
  chrome.action?.onClicked.addListener((tab) => {
    const opts: { tabId?: number; windowId?: number } = {};
    if (typeof tab.id === 'number') opts.tabId = tab.id;
    else if (typeof tab.windowId === 'number') opts.windowId = tab.windowId;
    try {
      ignoreRejection(sidePanel.open(opts));
    } catch {
      /* a click without a tab or window id; Chrome always sends one */
    }
  });
};
