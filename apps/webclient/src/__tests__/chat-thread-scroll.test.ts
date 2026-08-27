/** Where the transcript sits after a re-render.
 *
 *  The route rebuilds wholesale on every broadcast — including every streamed
 *  token — so the scroller is a fresh element each time and starts at zero.
 *  Restoring it is not one behaviour but two, and the whole point of this file
 *  is that they must not be collapsed: hold the offset for someone reading
 *  back, follow the bottom for someone watching an answer arrive.
 */

import { describe, expect, it } from 'vitest';

import {
  nextThreadScrollTop,
  STICK_TO_BOTTOM_TOLERANCE_PX,
} from '../chat/bootstrap-chat-route.js';

const at = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('nextThreadScrollTop', () => {
  it('follows the bottom while an answer grows', () => {
    // Pinned to the bottom (1000 - 600 - 400 === 0), and the answer added 200px.
    expect(nextThreadScrollTop(at(600), 1200, 400)).toBe(800);
  });

  it('holds the exact offset for someone reading back through history', () => {
    // ⛔ THE REGRESSION THIS EXISTS FOR: without it every streamed token
    // yanked the reader to wherever a fresh element starts.
    expect(nextThreadScrollTop(at(120), 1200, 400)).toBe(120);
  });

  it('treats near-bottom as bottom, because exact bottom is rare', () => {
    // Sub-pixel layout and zoom leave a scroller a few px short; an equality
    // test would read this as browsing and strand the reader mid-answer.
    const nearly = at(600 - (STICK_TO_BOTTOM_TOLERANCE_PX - 1));
    expect(nextThreadScrollTop(nearly, 1200, 400)).toBe(800);
  });

  it('does not steal the view back from someone just past the tolerance', () => {
    const away = at(600 - (STICK_TO_BOTTOM_TOLERANCE_PX + 1));
    expect(nextThreadScrollTop(away, 1200, 400)).toBe(575);
  });

  it('clamps a restored offset that the shrunken content can no longer reach', () => {
    // Content SHRINKS between renders — a plan card resolving, an activity
    // drawer closing. Restoring past the new end lands at the bottom while
    // claiming to have preserved the position.
    expect(nextThreadScrollTop(at(900, 2000, 400), 600, 400)).toBe(200);
  });

  it('returns zero when the content no longer overflows at all', () => {
    expect(nextThreadScrollTop(at(300, 1000, 400), 200, 400)).toBe(0);
  });
});
