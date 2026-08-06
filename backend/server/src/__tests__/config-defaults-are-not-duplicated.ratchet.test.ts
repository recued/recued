/** A config default has ONE writer: the schema.
 *
 *  ⛔ WHY THIS RATCHET EXISTS. `compose-storage-context.ts` retyped the schema
 *  defaults as literals inside `catch` fallbacks. They were correct the day
 *  they were written. D-230 raised `audit.quota.bytes` from 50 MB to 5 GB and
 *  the copy stayed at 50 MB, so a server whose config read threw would prune
 *  its audit trail to a hundredth of its configured ceiling — silently,
 *  oldest-first, on a surface with no upstream to re-sync from.
 *
 *  🔑 A DUPLICATED DEFAULT IS A RULE THAT GOES STALE IN PLACE. Nothing fails
 *  when the schema moves and the copy does not; the copy just starts
 *  disagreeing, and it disagrees on the failure path — the one nobody exercises.
 *  A test comparing the two values would only catch the drift that already
 *  happened; this catches the SHAPE that lets it happen again.
 *
 *  ⚠ Scoped to the fallbacks that mirror a schema key. `MEMORY_RETENTION_
 *  DEFAULT_DAYS` is deliberately its own constant — it is the contract for the
 *  no-expiry sentinel, not a copy of a schema number — so it is allowed. */

import { readFileSync } from 'node:fs';

import { RUNTIME_SCHEMA_MAP } from '@recued/config';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../serve/compose-storage-context.ts', import.meta.url),
  'utf8',
);

describe('runtime-config fallbacks', () => {
  it('⛔ no `catch` fallback returns a bare numeric literal', () => {
    // The defect shape verbatim: `catch { return 50 * 1024 * 1024; }`.
    // Arithmetic on literals counts — that is exactly how the stale value was
    // written — so the pattern allows digits, `_`, `*` and whitespace only.
    const literalFallbacks = [
      ...source.matchAll(/catch\s*\{\s*return\s+([0-9][0-9_\s*]*)\s*;?\s*\}/g),
    ].map((m) => m[0].replace(/\s+/g, ' '));

    expect(literalFallbacks).toEqual([]);
  });

  it('the fallbacks it does use resolve to the schema value', () => {
    // Equivalence, not just shape: `schemaFallback` must actually read the key
    // it is passed. A helper that ignored its argument would satisfy the test
    // above and still be wrong.
    const keys = [...source.matchAll(/schemaFallback\('([^']+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0); // else this asserts nothing

    for (const key of keys) {
      expect(RUNTIME_SCHEMA_MAP[key], `${key} is not a schema key`).toBeDefined();
      expect(typeof RUNTIME_SCHEMA_MAP[key].default, key).toBe('number');
    }
  });

  it('⛔ the ultimate-fallback literals agree with the schema TODAY', () => {
    // `schemaFallback(key, ifMissing)` carries a last-resort literal for the
    // case where the key vanishes from the schema entirely. That literal is
    // itself a copy — so pin it. If a re-scale moves the schema and leaves this
    // behind, the failure path drifts again, quietly.
    for (const [, key, raw] of source.matchAll(
      /schemaFallback\('([^']+)',\s*([0-9][0-9_\s*]*)\)/g,
    )) {
      const literal = Number(
        raw.replace(/_/g, '').split('*').map((p) => Number(p.trim()))
          .reduce((a, b) => a * b, 1),
      );
      expect(literal, `${key}: last-resort literal disagrees with the schema`)
        .toBe(RUNTIME_SCHEMA_MAP[key].default);
    }
  });
});
