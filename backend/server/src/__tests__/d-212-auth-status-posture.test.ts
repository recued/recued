/** D-212 §7.10 / §7.11 — the `recued auth-status` keyfile-posture block.
 *
 *  Two properties, both of which were unasserted until this file existed:
 *
 *   1. ⛔ `'none'` and `null` must not render the same. `null` is "the
 *      server said nothing" — an older daemon, or an unwired key store — and
 *      the command stays silent rather than implying either answer. `'none'`
 *      is a KNOWN unsealed keyfile and always speaks. They are the same width
 *      on screen and opposite in meaning; collapsing them deletes the only
 *      control that replaced the retracted §7.9 refusal.
 *
 *   2. §7.11 requires the unsealed remedy to name what it COSTS. Regenerating
 *      mints a NEW server identity — the keyfile also holds `server_identity`,
 *      `publisher_identity` and the D-175 account binding — so "set the
 *      passphrase and run recover-keyfile" reads far cheaper than it is. An
 *      operator who discovers the price afterwards has already de-paired
 *      their fleet.
 *
 *  ⚠ Tested through a pure function on purpose: this copy used to be a series
 *  of `console.log` calls, and a side effect nothing can read is a
 *  requirement nothing can enforce. */

import { describe, expect, it } from 'vitest';

import { keyfilePostureLines } from '../commands/auth.js';

const text = (sealing: Parameters<typeof keyfilePostureLines>[0]): string =>
  keyfilePostureLines(sealing).join('\n');

describe('D-212 §7.10 — auth-status keyfile posture', () => {
  it('says nothing when the server reported no posture', () => {
    // Not "unknown", not "—", not a warning: the command has no answer, and
    // inventing a line here would make an older daemon look either safe or
    // alarming on no evidence.
    expect(keyfilePostureLines(null)).toEqual([]);
  });

  it('names the factor when sealed, and warns about nothing', () => {
    for (const sealing of ['machine', 'passphrase'] as const) {
      const out = text(sealing);
      expect(out).toContain('sealed');
      expect(out).toContain(sealing);
      expect(out).not.toMatch(/UNSEALED/);
      // Must not cry wolf: a sealed keyfile gets no remediation.
      expect(out).not.toContain('recover-keyfile');
    }
  });

  it('⛔ renders `none` differently from `null`, in both directions', () => {
    const none = text('none');
    const unreported = text(null);
    expect(none).not.toBe(unreported);
    expect(none).toMatch(/UNSEALED/);
    expect(unreported).not.toMatch(/UNSEALED/);
    expect(unreported).toBe('');
  });

  it('states the FULL price of sealing an already-paired realm', () => {
    // Every part §7.11 says to name. A later "tidy" back to the one-liner
    // reds here.
    const out = text('none');
    expect(out).toContain('RECUED_IDENTITY_PASSPHRASE');
    expect(out).toContain('recover-keyfile');
    expect(out).toMatch(/24-word recovery key/i);
    expect(out).toMatch(/pair again/i);
    expect(out).toMatch(/publisher identity/i);
    expect(out).toMatch(/account binding/i);
    // …and that the data survives, or the warning reads like a threat to the
    // warehouse and nobody acts on it.
    expect(out).toMatch(/data is untouched/i);
  });

  it('says what unsealed actually exposes, not just that it is unsealed', () => {
    const out = text('none');
    expect(out).toMatch(/readable/i);
    expect(out).toMatch(/copies this directory/i);
  });
});
