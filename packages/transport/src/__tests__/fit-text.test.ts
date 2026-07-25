/** Vendor message-length fitting — trim to fit, and say so.
 *
 *  The failure this prevents: a messenger rejects an over-long send, the
 *  D-158 block catches the channel's throw (delivery is best-effort), and
 *  the ask silently never arrives on that channel while the others succeed.
 *  The owner never learns a decision is waiting.
 */
import { describe, expect, it } from 'vitest';
import { fitText } from '../fit-text.js';

describe('fitText', () => {
  it('leaves text that already fits completely untouched', () => {
    expect(fitText('short', 4000, 'Telegram')).toBe('short');
    // Exactly at the budget is a fit, not an overflow.
    const exact = 'x'.repeat(4000);
    expect(fitText(exact, 4000, 'Telegram')).toBe(exact);
  });

  it('never returns text over the budget — the whole point', () => {
    for (const len of [3001, 4097, 10_000, 100_000]) {
      for (const budget of [2900, 4000]) {
        const out = fitText('y'.repeat(len), budget, 'Slack');
        expect(out.length).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('discloses the trim and names how much went', () => {
    const out = fitText('z'.repeat(10_000), 4000, 'Telegram');
    expect(out).toContain('characters trimmed to fit Telegram');
    // The count is real, not decorative: head + marker + tail = 10_000.
    const dropped = Number(/\[… (\d+) characters/.exec(out)?.[1]);
    expect(dropped).toBeGreaterThan(0);
    expect(out.length - `\n\n[… ${dropped} characters trimmed to fit Telegram — open Recued for the full request …]\n\n`.length + dropped)
      .toBe(10_000);
  });

  it('keeps BOTH ends — the ask keeps its opening AND its question', () => {
    // A tail cut would leave an [Approve] button under a sentence that no
    // longer asks anything.
    const ask =
      'Recipe sync-deals wants to run 40 core.crm.deal.update actions on hubspot-prod.\n'
      + 'Write actions change data outside Recued, so Recued held them for you.\n\n'
      + `${'  1. object_id: 9114872331 · properties.amount: 48000\n'.repeat(200)}`
      + '\nApprove all 40?';

    const out = fitText(ask, 4000, 'Telegram');

    expect(out.startsWith('Recipe sync-deals wants to run 40')).toBe(true);
    expect(out.endsWith('Approve all 40?')).toBe(true);
    expect(out).toContain('trimmed to fit Telegram');
    expect(out.length).toBeLessThanOrEqual(4000);
  });

  it('stays total when the budget cannot even hold the marker', () => {
    // No real vendor is this tight; returning over-budget text would defeat
    // the purpose, so a hard cut is the only honest answer left.
    expect(fitText('w'.repeat(500), 10, 'Telegram')).toHaveLength(10);
    expect(fitText('w'.repeat(500), 0, 'Telegram')).toHaveLength(0);
  });
});
