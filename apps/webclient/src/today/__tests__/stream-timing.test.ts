/** D-340 ruling 13 (the owner, 2026-11-15) — Today says when the message went after it started preparing,
 *  and how its AI suggestions did, so "Starts preparing at" can be set to the owner's habit. */
import { describe, expect, it } from 'vitest';
import { runTimingText } from '../stream-panel.js';

const at = Date.parse('2026-11-16T08:00:00Z');
describe('D-340 ruling 13 — the message\'s timing on Today', () => {
  it('says how long after it started preparing it went, and how its suggestions did', () => {
    expect(runTimingText({ at: at + 2 * 60_000, prepared_at: at, suggestions: 'included' }))
      .toBe('Went 2 min after it started preparing · AI suggestions included');
    expect(runTimingText({ at: at + 20_000, prepared_at: at, suggestions: 'stuck' }))
      .toBe('Went as soon as it started preparing · AI suggestions missing: the AI stopped responding');
    expect(runTimingText({ at, prepared_at: at })).toBe('Went as soon as it started preparing');
    expect(runTimingText({ at, prepared_at: at, suggestions: 'failed' })).toContain('the AI service did not respond');
  });

  it('says nothing for a run before it, or none', () => {
    expect(runTimingText({ at })).toBe('');
    expect(runTimingText(null)).toBe('');
  });
});
