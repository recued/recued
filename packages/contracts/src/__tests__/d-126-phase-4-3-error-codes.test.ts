/** D-126 Phase 4.3 / 5.1 — manifest validator error codes graduated.
 *
 *  Asserts the 5 `INGREDIENT_KIND_*` codes (P4.3) are registered in the
 *  typed `RecipeErrorCode` registry and that severity + user-facing copy
 *  are wired for each. Catches silent drift if a future commit adds a
 *  new validator code without a matching `ERR` / `ERROR_MESSAGES` entry.
 *
 *  ⛔ `KIND_NOT_YET_IMPLEMENTED` (P2.1) was in this family and was REMOVED
 *  2026-08-11 — D-125 P3 + P4.1/4.2/4.3 all shipped, leaving it with zero
 *  producers while its copy still told operators to update Recued. Do not
 *  re-add it here; the case it named is now the kind-named
 *  `unsupported('connection')` default (`INGREDIENT_ADAPTER_ALL_FAILED`). */

import { describe, it, expect } from 'vitest';
import { ERR, ERROR_MESSAGES, defaultErrorMessage, type RecipeErrorCode } from '../errors.js';

const KIND_FAMILY: readonly RecipeErrorCode[] = [
  'INGREDIENT_KIND_MISSING',
  'INGREDIENT_KIND_INVALID',
  'INGREDIENT_KIND_MISSING_FIELD',
  'INGREDIENT_KIND_FIELD_FORBIDDEN',
  'INGREDIENT_KIND_TIER_MISMATCH',
];

describe('D-126 P5.1 — INGREDIENT_KIND_* codes graduated to RecipeErrorCode', () => {
  it('every code in the kind family has an ERR severity entry', () => {
    for (const code of KIND_FAMILY) {
      expect(ERR[code], `ERR missing entry for ${code}`).toBeDefined();
    }
  });

  it('every kind-family code is fatal (manifest shape errors are not runtime-recoverable)', () => {
    for (const code of KIND_FAMILY) {
      expect(ERR[code], `${code} should be fatal`).toBe('fatal');
    }
  });

  it('every kind-family code has a user-facing ERROR_MESSAGES entry', () => {
    for (const code of KIND_FAMILY) {
      const msg = ERROR_MESSAGES[code];
      expect(msg, `ERROR_MESSAGES missing entry for ${code}`).toBeDefined();
      expect(msg.length, `${code} message should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('defaultErrorMessage returns a non-fallback string for every kind-family code', () => {
    for (const code of KIND_FAMILY) {
      const msg = defaultErrorMessage(code);
      // Fallback path is "Recipe stopped (CODE)." — every entry in
      // KIND_FAMILY should resolve via ERROR_MESSAGES, not the fallback.
      expect(msg, `${code} should resolve via ERROR_MESSAGES, not fallback`).not.toMatch(
        /^Recipe stopped \(/,
      );
    }
  });
});
