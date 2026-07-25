/** D-126 Phase 4.3 / 5.1 — manifest validator error codes graduated.
 *
 *  Asserts the 5 new `INGREDIENT_KIND_*` codes (P4.3) are registered
 *  in the typed `RecipeErrorCode` registry alongside the pre-existing
 *  `KIND_NOT_YET_IMPLEMENTED` (P2.1), and that severity + user-facing
 *  copy are wired for each. Catches silent drift if a future commit
 *  adds a new validator code without a matching `ERR` / `ERROR_MESSAGES`
 *  entry. */

import { describe, it, expect } from 'vitest';
import { ERR, ERROR_MESSAGES, defaultErrorMessage, type RecipeErrorCode } from '../errors.js';

const KIND_FAMILY: readonly RecipeErrorCode[] = [
  'INGREDIENT_KIND_MISSING',
  'INGREDIENT_KIND_INVALID',
  'INGREDIENT_KIND_MISSING_FIELD',
  'INGREDIENT_KIND_FIELD_FORBIDDEN',
  'INGREDIENT_KIND_TIER_MISMATCH',
  'KIND_NOT_YET_IMPLEMENTED',
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
