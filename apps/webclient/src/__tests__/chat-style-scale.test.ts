/** Keep the pane-clearance regression; cosmetic radius and height-token
 * choices are reviewed with the UI rather than asserted as CSS strings. */
import { describe, expect, it } from 'vitest';
import { CHAT_ROUTE_CHROME_STYLES } from '../chat/bootstrap-chat-route.js';
import { CONNECTION_BANNER_HEIGHT_VAR } from '../shell/connection-indicator.js';

describe('chat panes keep clear of the connection banner', () => {
  /** ⛔ The banner is fixed to the bottom of the viewport and full width.
   *  Measured with it up and the panes bounded only by the viewport: they
   *  ended at 846 and the banner began at 840, so the last 6px of both sat
   *  underneath it — and that edge is where the composer is pinned, so a
   *  wrapped 86px banner clips the Send row. Both panes subtract the published
   *  height, which is 0px whenever the banner is not showing. */
  it('subtracts the published banner height from both pane heights', () => {
    const bounds = [...CHAT_ROUTE_CHROME_STYLES.matchAll(
      /height:\s*min\(720px,[^;]*;/g,
    )].map((m) => m[0]!);
    // Both panes, and they must agree — they sit side by side and a mismatch
    // would leave them ending at different heights.
    const desktopBounds = bounds.filter(bound => bound.includes('100vh'));
    expect(desktopBounds).toHaveLength(2);
    expect(new Set(desktopBounds).size).toBe(1);
    for (const bound of bounds) expect(bound).toContain(`var(${CONNECTION_BANNER_HEIGHT_VAR}, 0px)`);
  });
});
