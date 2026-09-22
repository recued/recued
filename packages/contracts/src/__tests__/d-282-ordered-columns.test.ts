/** D-282 B2 — the ordered vocabulary, and the one thing that keeps it honest.
 *
 *  ⛔⛔ A STRING FIELD CANNOT BE SORTED. `records/store.ts` refuses any other kind with
 *  `sort field '<name>' is not ordered`, so "sort by Name" is not a control anyone can
 *  offer — it is a run that fails. A surface drawing a sort affordance on a column the
 *  store will refuse has made a promise the next press breaks.
 *
 *  🔑 THE TEST THAT MATTERS IS THE LAST ONE. The list used to live inline in the store,
 *  and any UI wanting to know which columns are clickable would have restated it. This
 *  asserts the store reads the SHARED constant rather than a copy that agrees today —
 *  the drift `OUTPUT_TYPES`' own header warns about, where a second hand-written copy of
 *  a closed vocabulary typechecks fine and is quietly wrong. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ORDERED_FIELD_KINDS,
  ORDERED_RECORD_KEYS,
  isOrderedRecordColumn,
} from '../record-fields.js';

const STORE = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../backend/server/src/records/store.ts',
);

describe('the ordered vocabulary', () => {
  it('admits the kinds a store can compare and refuses the ones it cannot', () => {
    for (const kind of ['number', 'decimal', 'date', 'datetime', 'boolean']) {
      expect(isOrderedRecordColumn({ field: 'whatever', kind }), kind).toBe(true);
    }
    for (const kind of ['string', 'json', 'ref', 'id', 'text']) {
      expect(isOrderedRecordColumn({ field: 'whatever', kind }), kind).toBe(false);
    }
  });

  /** ⚠ These are admitted by NAME, not by kind — they are not entity fields, so a kind
   *  lookup finds nothing for them. */
  it('admits id and the two record stamps by name, whatever kind arrives', () => {
    for (const field of ['id', '_record.created_at', '_record.updated_at']) {
      expect(isOrderedRecordColumn({ field }), field).toBe(true);
      expect(isOrderedRecordColumn({ field, kind: 'string' }), field).toBe(true);
    }
  });

  it('is false for a column with no declared kind', () => {
    expect(isOrderedRecordColumn({ field: 'name' })).toBe(false);
  });

  /** ⛔ The anti-drift check. If someone re-inlines the list in the store, the UI and the
   *  store can disagree about which columns are clickable — and the UI's copy is the one
   *  that draws the affordance, so the disagreement surfaces as a failing run. */
  it('the records store reads THIS constant, not a copy of it', () => {
    const store = readFileSync(STORE, 'utf8');
    expect(store).toContain('ORDERED_FIELD_KINDS');
    expect(store).toContain('ORDERED_RECORD_KEYS');
    // The literal list must not have come back.
    expect(store).not.toContain("['number','decimal','date','datetime','boolean']");
    expect(store).not.toContain("'_record.created_at' && sortName !== '_record.updated_at'");
  });

  it('the two sets are what the store admits, and nothing more', () => {
    expect([...ORDERED_FIELD_KINDS].sort())
      .toEqual(['boolean', 'date', 'datetime', 'decimal', 'number']);
    expect([...ORDERED_RECORD_KEYS].sort())
      .toEqual(['_record.created_at', '_record.updated_at', 'id']);
  });
});
