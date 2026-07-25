/** D-116 follow-up — auto-disabled summarizer hoisted into
 *  `@recued/scheduler`. The extension's options-template test already
 *  exercises end-to-end render; this test pins the pure projection so
 *  server (CLI status + /status mirror) consumers can rely on the
 *  same shape contracts. */

import { describe, it, expect } from 'vitest';
import {
  summarizeAutoDisabled,
  type AutoRunEntryLike,
} from '../auto-disabled.js';

const mkEntry = (
  o: Partial<AutoRunEntryLike> & Pick<AutoRunEntryLike, 'recipe_id'>,
): AutoRunEntryLike => ({
  publisher_id: 'recued-core',
  auto_disabled: false,
  consecutive_failures: 0,
  process_id: 'pid-' + o.recipe_id,
  ...o,
});

describe('summarizeAutoDisabled (hoisted)', () => {
  it('returns only auto_disabled entries', () => {
    const summary = summarizeAutoDisabled({
      roster: [
        mkEntry({ recipe_id: 'a', auto_disabled: true, consecutive_failures: 5 }),
        mkEntry({ recipe_id: 'b', auto_disabled: false, consecutive_failures: 1 }),
        mkEntry({ recipe_id: 'c', auto_disabled: true, consecutive_failures: 8 }),
      ],
    });
    expect(summary.map((s) => s.recipe_id)).toEqual(['a', 'c']);
  });

  it('resolves display name via lookupName, falling back to recipe_id', () => {
    const summary = summarizeAutoDisabled({
      roster: [
        mkEntry({ recipe_id: 'a', auto_disabled: true }),
        mkEntry({ recipe_id: 'b', auto_disabled: true }),
      ],
      lookupName: (id) => id === 'a' ? 'Recipe Alpha' : null,
    });
    expect(summary[0].name).toBe('Recipe Alpha');
    expect(summary[1].name).toBe('b');
  });

  it('threads consecutive_failures, last_finished_at, last_process_id', () => {
    const summary = summarizeAutoDisabled({
      roster: [
        mkEntry({
          recipe_id: 'x', auto_disabled: true,
          consecutive_failures: 9, last_finished_at: 1714_000_000_000,
        }),
      ],
    });
    expect(summary[0].consecutive_failures).toBe(9);
    expect(summary[0].last_finished_at).toBe(1714_000_000_000);
    expect(summary[0].last_process_id).toBe('pid-x');
  });

  it('orders entries deterministically by recipe_id', () => {
    const summary = summarizeAutoDisabled({
      roster: [
        mkEntry({ recipe_id: 'charlie', auto_disabled: true }),
        mkEntry({ recipe_id: 'alpha', auto_disabled: true }),
        mkEntry({ recipe_id: 'bravo', auto_disabled: true }),
      ],
    });
    expect(summary.map((s) => s.recipe_id)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('threads last_failure_reason from the lookup', () => {
    const summary = summarizeAutoDisabled({
      roster: [mkEntry({ recipe_id: 'a', auto_disabled: true })],
      lookupFailureReason: (id) => id === 'a' ? 'NETWORK_ERROR: refused' : undefined,
    });
    expect(summary[0].last_failure_reason).toBe('NETWORK_ERROR: refused');
  });

  it('treats missing last_finished_at as null in the output', () => {
    const summary = summarizeAutoDisabled({
      roster: [mkEntry({ recipe_id: 'a', auto_disabled: true })],
    });
    expect(summary[0].last_finished_at).toBeNull();
  });

  it('omits last_failure_reason when the lookup returns undefined', () => {
    const summary = summarizeAutoDisabled({
      roster: [mkEntry({ recipe_id: 'a', auto_disabled: true })],
      lookupFailureReason: () => undefined,
    });
    expect(summary[0].last_failure_reason).toBeUndefined();
  });
});
