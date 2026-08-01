/** D-226 — the RESPONSE → PANEL-PROPS seam.
 *
 *  ⛔ The renderer is proved in `ui-shared`; what is provable only here is that
 *  the route actually HANDS it the rollups. `deriveEntityDetailProps`
 *  enumerates the response fields it forwards, so an omitted field arrives as
 *  `undefined` and the section silently never renders — with every unit test
 *  on both sides of the seam still green. That is precisely how this shipped
 *  the first time. */
import { describe, expect, it } from 'vitest';
import type { TimelineResponse, TimelineRollup } from '@recued/contracts';
import { contactRollupChips, deriveEntityDetailProps } from '../data/bootstrap-data-route.js';

const ROLLUPS: TimelineRollup[] = [{
  publisher: 'recued-core', pack_slug: 'billable-hours', label: 'Unbilled time',
  value: { unbilled_minutes: 135 }, complete: true,
}];

const derive = (response: TimelineResponse) =>
  deriveEntityDetailProps(response, 'contact', 'bob@acme.test', 1_800_000_000_000);

describe('deriveEntityDetailProps forwards rollups', () => {
  it('⛔ carries them from the response through to the panel props', () => {
    expect(derive({ entries: [], rollups: ROLLUPS }).rollups).toEqual(ROLLUPS);
  });

  it('preserves the absent/empty distinction the wire makes', () => {
    // absent ⇒ the panel omits the section entirely (no rollup surface);
    // [] ⇒ the panel says nothing tracks this contact. Collapsing the two here
    // would erase a distinction the resolver and the wire both keep.
    expect('rollups' in derive({ entries: [] })).toBe(false);
    expect(derive({ entries: [], rollups: [] }).rollups).toEqual([]);
  });

  it('still derives the rest of the props unchanged', () => {
    const props = derive({ entries: [], rollups: ROLLUPS });
    expect(props.scope).toBe('contact');
    expect(props.target_id).toBe('bob@acme.test');
    expect(props.timelineEntries).toEqual([]);
  });
});

// ── the LIST surface ────────────────────────────────────────────────────────
/** ⛔⛔ THE UI IS WHERE A SERVER GUARD GETS UNDONE. The batched read is careful
 *  to say `complete: false` when a pack's walk hit a bound; drawing that as a
 *  plain number presents a figure the server explicitly refused to vouch for as
 *  fact, and nothing on the server can stop it. Hence a pure, separately tested
 *  function rather than an expression buried in a template literal. */
describe('contactRollupChips — one contact, one row of chips', () => {
  const chip = (over: Partial<TimelineRollup> = {}): TimelineRollup => ({
    publisher: 'recued-core', pack_slug: 'invoice-book', label: 'Owes you',
    value: { open_invoices: 2, outstanding: '6912.3000' }, complete: true, ...over,
  });

  it('renders a pack that has something to say, under its own label', () => {
    expect(contactRollupChips([chip()])).toEqual([
      { label: 'Owes you', text: 'open invoices 2 · outstanding 6912.3000', complete: true },
    ]);
  });

  it('falls back to the pack slug when no label was declared', () => {
    const { label, ...rest } = chip();
    expect(contactRollupChips([rest as TimelineRollup])[0]!.label).toBe('invoice-book');
  });

  it('⛔⛔ an INCOMPLETE rollup says "at least" — the server said so', () => {
    // The whole point of the per-key bound is that a truncated walk admits it.
    // Rendering the number bare would launder a bounded scan into a total.
    const out = contactRollupChips([chip({ complete: false })]);
    expect(out[0]!.text).toBe('at least open invoices 2 · outstanding 6912.3000');
    expect(out[0]!.complete).toBe(false);
  });

  it('⚠ an incomplete rollup with NOTHING in it is still shown', () => {
    // The tempting symmetry — "empty means skip" — would hide exactly the case
    // where the walk gave up before finding anything, which is not "nothing".
    const out = contactRollupChips([chip({ complete: false, value: { open_invoices: 0 } })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('at least ');
  });

  it('skips a COMPLETE pack with nothing to say — zeros against every row are noise', () => {
    expect(contactRollupChips([chip({
      value: { open_invoices: 0, outstanding: '0.0000', oldest_due: null },
    })])).toEqual([]);
  });

  it('drops only the empty measures, keeping the ones that matter', () => {
    expect(contactRollupChips([chip({
      value: { open_invoices: 2, outstanding: '0.0000', oldest_due: null },
    })])[0]!.text).toBe('open invoices 2');
  });

  it('two packs are two chips, in the order the server sent them', () => {
    const out = contactRollupChips([
      chip({ pack_slug: 'billable-hours', label: 'Unbilled time',
             value: { unbilled_minutes: 90 } }),
      chip(),
    ]);
    expect(out.map(c => c.label)).toEqual(['Unbilled time', 'Owes you']);
  });

  it('a contact the batch had no entry for renders nothing, and does not throw', () => {
    expect(contactRollupChips(undefined)).toEqual([]);
    expect(contactRollupChips([])).toEqual([]);
  });
});
