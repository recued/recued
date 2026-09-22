/** D-282 B4 — when a `records` broadcast should redraw the open pack view.
 *
 *  ⛔⛔ THE SINK THIS SLICE EXISTS TO FILL. `packs-panel.ts` has declared AND
 *  implemented `refreshAppView()` since the Use tab shipped, and nothing ever called
 *  it — `refresh()`'s own doc comment even anticipated the gap ("a future broadcast
 *  subscription lands"). So a write by a schedule, a webhook, the AI, a peer or the
 *  owner's other device left the page showing yesterday's rows until its tab was
 *  re-selected. An optional seam nobody wires is not an error; it is silence.
 *
 *  🔑 THE DECISION IS EXTRACTED so it can be tested without mounting a route, the
 *  same shape `shouldRefreshDisplayedBoard` already uses for the recipes route's
 *  broadcast refresh. The route keeps only the coalescing timer. */

import { describe, expect, it } from 'vitest';

import {
  shouldRefreshOpenPackView,
  type OpenPackViewState,
} from '../packs/bootstrap-packs-route.js';

const OPEN: OpenPackViewState = {
  selected_slug: 'rental-book',
  publisher: 'recued-core',
  unsaved: false,
  in_flight: false,
};
const EVENT = { publisher: 'recued-core', pack_slug: 'rental-book' };

describe('shouldRefreshOpenPackView', () => {
  it('redraws when the open pack is the one that changed', () => {
    expect(shouldRefreshOpenPackView(EVENT, OPEN)).toBe(true);
  });

  it('ignores a write to some other pack', () => {
    expect(shouldRefreshOpenPackView({ ...EVENT, pack_slug: 'ledger-book' }, OPEN)).toBe(false);
  });

  /** ⛔ Slug alone is not identity — two publishers may ship the same slug, and a
   *  write to one would otherwise redraw a view of the other's data. */
  it('ignores a same-slug pack from a different publisher', () => {
    expect(shouldRefreshOpenPackView({ ...EVENT, publisher: 'someone-else' }, OPEN)).toBe(false);
  });

  /** ⚠ A missing roster entry is not evidence of a DIFFERENT pack, so the slug match
   *  stands rather than refusing — refusing would make the feature vanish whenever the
   *  roster had not landed yet. */
  it('still redraws when the roster does not know the publisher', () => {
    expect(shouldRefreshOpenPackView(EVENT, { ...OPEN, publisher: null })).toBe(true);
  });

  /** ⛔⛔ THE ONE THAT MATTERS. A refresh RE-RUNS the view recipe and replaces the
   *  rendered result, so refreshing over a half-typed grid discards it — data loss
   *  caused by somebody ELSE'S write, which is worse than a stale page. */
  it('never redraws over unsaved grid rows', () => {
    expect(shouldRefreshOpenPackView(EVENT, { ...OPEN, unsaved: true })).toBe(false);
  });

  it('never redraws while a pack action is still in flight', () => {
    expect(shouldRefreshOpenPackView(EVENT, { ...OPEN, in_flight: true })).toBe(false);
  });

  it('does nothing when no pack is open, or the panel is not mounted', () => {
    expect(shouldRefreshOpenPackView(EVENT, { ...OPEN, selected_slug: null })).toBe(false);
    expect(shouldRefreshOpenPackView(EVENT, null)).toBe(false);
  });
});
