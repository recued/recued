/** D-169 bridge security hunt, F1 — matched-tab screenshot confinement.
 *
 *  `chrome.tabs.captureVisibleTab(windowId)` captures whatever tab is ACTIVE
 *  in the window, NOT the tab `findTabByUrlPattern` resolved for the command's
 *  domain pattern. So a `screenshot` BridgeCommand for granted domain A would,
 *  without this, leak whatever (host-permitted) tab the user happens to have
 *  foregrounded in that window — escaping the command's per-ingredient /
 *  per-domain grant. This brings the matched tab to the front, then re-confirms
 *  via chrome's OWN match engine (`query({active, windowId, url})`) that the
 *  active tab in the window IS the matched tab AND still satisfies the
 *  command's domain pattern (defends a navigate/close race between match and
 *  capture), and only then captures. Fail-closed: any miss returns null and the
 *  executor maps it to a blocked-capture error — it never captures a tab the
 *  command's grant did not name.
 *
 *  Pure over an injected chrome.tabs seam so the confinement logic is
 *  unit-testable without a real `chrome` (and importable without triggering the
 *  service-worker-entry boot).
 */

/** The chrome.tabs subset `captureMatchedVisibleTab` needs. */
export interface ChromeTabsForCapture {
  update(tabId: number, opts: { active?: boolean }): Promise<unknown>;
  query(opts: {
    active?: boolean;
    windowId?: number;
    url?: string;
  }): Promise<Array<{ id?: number; url?: string }>>;
  captureVisibleTab(windowId: number | undefined, opts: { format: string }): Promise<string>;
}

export const captureMatchedVisibleTab = async (
  tabs: ChromeTabsForCapture,
  args: { tab_id: number; window_id: number; url_pattern: string },
): Promise<string | null> => {
  try {
    await tabs.update(args.tab_id, { active: true });
    const confirmed = await tabs.query({
      active: true,
      windowId: args.window_id,
      url: args.url_pattern,
    });
    if (!confirmed.some((tab) => tab.id === args.tab_id)) return null;
    return await tabs.captureVisibleTab(args.window_id, { format: 'png' });
  } catch {
    return null;
  }
};
