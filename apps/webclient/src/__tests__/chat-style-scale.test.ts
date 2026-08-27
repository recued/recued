/** The chat surface's radius and control-height scales, as a ratchet.
 *
 *  ⛔ THIS EXISTS BECAUSE A PER-SELECTOR SWEEP HAS NO COMPLETION CRITERION.
 *  internal design notes measured the last one circling
 *  rather than converging: 575 commits over 83 files, one file touched 71
 *  times, "done" files about 5% done — because each pass only closed the
 *  selectors that pass happened to look at. A sweep with no test is a sweep
 *  that has to be redone.
 *
 *  So the scale is asserted rather than described. Nine ad-hoc radii collapsed
 *  to three roles, and nine hand-written control heights to the shell knob; a
 *  new literal fails here instead of being found by eye six weeks later.
 */

import { describe, expect, it } from 'vitest';

import { CHAT_ROUTE_CHROME_STYLES } from '../chat/bootstrap-chat-route.js';
import { CONNECTION_BANNER_HEIGHT_VAR } from '../shell/connection-indicator.js';

/** ⛔ THIS ROUTE'S OWN CHROME, not the combined `CHAT_ROUTE_STYLES`. That one
 *  concatenates the primitives and provenance sheets, whose radii are their
 *  packages' business — asserting over them would both fail on values this
 *  file cannot fix and pass on ones it can. */
const css = CHAT_ROUTE_CHROME_STYLES;

/** 3px and 4px are focus rings and hairlines, not surfaces. Rounding a 1px
 *  rule like a card is how a scale starts lying, so they stay out of it — and
 *  stay listed here, so an unexplained fourth value cannot join them quietly. */
const ALLOWED_MICRO_RADII = ['3px', '4px'];

describe('chat route — one radius scale', () => {
  it('uses the role tokens for every surface radius', () => {
    const literals = [...css.matchAll(/border-radius:\s*([0-9]+px)/g)]
      .map((match) => match[1]!)
      .filter((value) => !ALLOWED_MICRO_RADII.includes(value));
    expect(literals).toEqual([]);
  });

  it('declares the three roles it aliases, and aliases the shell where it can', () => {
    expect(css).toContain('--chat-radius-panel: var(--wc-radius,');
    expect(css).toContain('--chat-radius-pill: var(--wc-radius-pill,');
    // The control radius has no shell knob to alias yet; when one lands, this
    // is the single line that changes.
    expect(css).toContain('--chat-radius-control:');
  });

  it('still rounds things — the tokens are used, not merely declared', () => {
    // ⚠ Without this the suite would pass on a stylesheet that had simply
    // deleted every radius, which is the shape a careless "fix" takes.
    const uses = [...css.matchAll(/border-radius:\s*var\(--chat-radius-/g)];
    expect(uses.length).toBeGreaterThan(30);
  });
});

describe('chat route — control heights come from the shell knob', () => {
  /** Heights that are deliberately NOT the control knob. Each is a different
   *  KIND of thing, which is the point — the knob answers "how tall is a
   *  button", and these are not buttons:
   *
   *    26px — a toolbar ROW's floor, reserving space so the strip cannot
   *           collapse when its contents are absent;
   *    42px — the composer TEXT AREA, one comfortable line of prose plus room
   *           to grow. Reconciling it would leave the composer shorter than
   *           the Send button beside it;
   *    44px — mobile TAP TARGETS, deliberately ABOVE the knob, carrying the
   *           shell's hit-target assertions.
   *
   *  ⛔ An allow-list rather than a permitted band, so each exception has to be
   *  named and reasoned. A band quietly admits the next unexplained value. */
  const ALLOWED_NON_CONTROL_HEIGHTS = ['26px', '42px', '44px'];

  it('hand-writes no control-sized min-height', () => {
    // The knob is 38px (40px under 640px). Literals at 36/38/40 were three
    // different answers to "how tall is a button" in one file, and the 36s sat
    // below the knob AND below the 44px mobile tap-target assertions.
    const literals = [...css.matchAll(/min-height:\s*([0-9]+px)/g)]
      .map((match) => match[1]!)
      .filter((value) => {
        const px = Number.parseInt(value, 10);
        // Above 44 is layout (a pane's floor), not a control.
        return px <= 44 && !ALLOWED_NON_CONTROL_HEIGHTS.includes(value);
      });
    expect(literals).toEqual([]);
  });

  it('keeps the composer taller than the button beside it', () => {
    // The exception with the most obvious failure mode if it is ever
    // "reconciled": a text area shorter than its own Send button.
    expect(css).toContain('min-height: 42px');
  });

  it('leaves deliberate 44px tap targets alone', () => {
    // ⛔ NOT a stray literal. 44px is ABOVE the knob on purpose, for the
    // controls that carry the mobile hit-target assertions — reconciling
    // these to the knob would shrink them and break those.
    expect(css).toContain('min-height: 44px');
  });
});

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
    expect(bounds).toHaveLength(2);
    expect(new Set(bounds).size).toBe(1);
    expect(bounds[0]).toContain(`var(${CONNECTION_BANNER_HEIGHT_VAR}, 0px)`);
  });
});
