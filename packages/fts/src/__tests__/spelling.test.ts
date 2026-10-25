/** "Did you mean", from the index's own words.
 *
 *  ⛔ THE CASE THAT MATTERS IS A PRIVATE NAME. A dictionary cannot correct
 *  "Castelanos" — only the index knows the owner's client is "Castellanos".
 *  Every suggestion asserted here is a word some indexed record holds, written
 *  the way that record writes it. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  absentFromAll,
  applySpellingCorrections,
  boundedEditDistance,
  checkQuerySpelling,
  createFtsTable,
  indexRecord,
  mergeSpellingChecks,
  spellingMaxDistance,
  type FtsWordCheck,
} from '../index.js';

let db: Database.Database;
const T = 'mail_fts';

const index = (records: Record<string, string>, table = T): void => {
  for (const [key, text] of Object.entries(records)) indexRecord(db, table, key, text);
};

beforeEach(() => {
  db = new Database(':memory:');
  createFtsTable(db, T);
});

afterEach(() => {
  db.close();
});

describe('checkQuerySpelling', () => {
  it('⛔ suggests the owner\'s own spelling of a misspelled name, and leaves real words alone', () => {
    index({
      m1: 'Invoice from Ana Castellanos for the renewal',
      m2: 'Castellanos replied about the meeting',
    });
    expect(checkQuerySpelling(db, T, 'Castelanos invoice')).toEqual([
      {
        typed: 'Castelanos',
        present: false,
        suggestion: { word: 'Castellanos', distance: 1, records: 2 },
      },
      { typed: 'invoice', present: true },
    ]);
  });

  it('gives the word as the record writes it, not the stem a porter index stores', () => {
    createFtsTable(db, 'notes_fts', { tokenizer: 'porter unicode61 remove_diacritics 2' });
    index({ n1: 'Call Castellanos about the organizations list' }, 'notes_fts');
    const [check] = checkQuerySpelling(db, 'notes_fts', 'Castelanos');
    // The index holds `castellano`; the owner wrote `Castellanos`.
    expect(check?.suggestion?.word).toBe('Castellanos');
  });

  it('prefers the capitalised form a record writes over a lower-case subject or an address', () => {
    index({ m1: 'castellanos\nInvoice from Ana Castellanos\ncastellanos@lease.test' });
    expect(checkQuerySpelling(db, T, 'Castelanos')[0]?.suggestion?.word).toBe('Castellanos');
  });

  it('keeps an accented spelling, which is how the record has it', () => {
    index({ m1: 'Offer from Müller GmbH' });
    const [check] = checkQuerySpelling(db, T, 'Mueller');
    expect(check?.suggestion).toEqual({ word: 'Müller', distance: 1, records: 1 });
  });

  it('⛔ never corrects a word some record holds, however rare', () => {
    index({ a: 'Marta', b: 'Martha', c: 'Martha', d: 'Martha' });
    expect(checkQuerySpelling(db, T, 'Marta')).toEqual([{ typed: 'Marta', present: true }]);
  });

  it('counts the start of an indexed word as present, as relaxation does', () => {
    index({ m1: 'Castellanos' });
    expect(checkQuerySpelling(db, T, 'Castel')).toEqual([{ typed: 'Castel', present: true }]);
  });

  it('checks only words worth correcting: four letters or more, no digits, no stopwords', () => {
    index({ m1: 'invoice 2024 from the vendor' });
    const checks = checkQuerySpelling(db, T, 'teh invoce 2025 from');
    expect(checks.map((c) => c.typed)).toEqual(['invoce']);
    expect(checks[0]?.suggestion?.word).toBe('invoice');
  });

  it('allows one edit below six letters and two from six', () => {
    index({ m1: 'Flights to Lisbon', m2: 'Castellanos' });
    expect(checkQuerySpelling(db, T, 'Lisbn')[0]?.suggestion?.word).toBe('Lisbon');
    // Four letters, two edits away: too far to be a correction.
    expect(checkQuerySpelling(db, T, 'Lsbn')[0]).toEqual({ typed: 'Lsbn', present: false });
    expect(checkQuerySpelling(db, T, 'Castelanso')[0]?.suggestion?.word).toBe('Castellanos');
    expect(spellingMaxDistance(3)).toBe(0);
    expect(spellingMaxDistance(5)).toBe(1);
    expect(spellingMaxDistance(6)).toBe(2);
  });

  it('prefers fewer edits, then the word more records hold', () => {
    index({ a: 'Carver', b: 'Carter', c: 'Carter', d: 'Carter' });
    // One substitution from each; Carter is in three records, Carver in one.
    expect(checkQuerySpelling(db, T, 'Carser')[0]?.suggestion).toEqual({
      word: 'Carter', distance: 1, records: 3,
    });
  });

  it('⛔ never suggests an indexed word with a digit in it — that is a token, not a word', () => {
    index({ m1: 'tracking c4stellanos', m2: 'tracking c4stellanos' });
    expect(checkQuerySpelling(db, T, 'Castelanos')).toEqual([{ typed: 'Castelanos', present: false }]);
    index({ m3: 'Castellanos' });
    expect(checkQuerySpelling(db, T, 'Castelanos')[0]?.suggestion?.word).toBe('Castellanos');
  });

  it('⚠ makes no suggestion for a typo in the first letter — the stated cost of the range scan', () => {
    index({ m1: 'Castellanos' });
    expect(checkQuerySpelling(db, T, 'Kastellanos')).toEqual([
      { typed: 'Kastellanos', present: false },
    ]);
  });

  it('stays out of a query written in FTS5 syntax', () => {
    index({ m1: 'Castellanos invoice' });
    for (const q of ['"Castelanos"', 'Castelanos*', 'Castelanos OR invoice', 'body:Castelanos']) {
      expect(checkQuerySpelling(db, T, q)).toEqual([]);
    }
  });

  it('keeps its word list in TEMP, so nothing is written to the database file', () => {
    index({ m1: 'Castellanos' });
    checkQuerySpelling(db, T, 'Castelanos');
    checkQuerySpelling(db, T, 'Castelanos');
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%spelling%'`).all())
      .toEqual([]);
    expect(db.prepare(`SELECT name FROM sqlite_temp_master WHERE name LIKE '%spelling%'`).all())
      .toEqual([{ name: 'mail_fts_spelling_vocab' }]);
  });
});

describe('mergeSpellingChecks', () => {
  const absent = (typed: string, word: string, distance: number, records: number): FtsWordCheck =>
    ({ typed, present: false, suggestion: { word, distance, records } });

  it('⛔ leaves a word as typed when ANY index holds it', () => {
    // Absent from mail, present in files: a real word with a home elsewhere.
    expect(mergeSpellingChecks([
      [absent('Kestral', 'Kestrel', 1, 4)],
      [{ typed: 'Kestral', present: true }],
    ])).toEqual([]);
  });

  it('sums the records of one suggested word across indexes and keeps the fewest edits', () => {
    expect(mergeSpellingChecks([
      [absent('Castelanos', 'Castellanos', 1, 2), absent('invoce', 'invoice', 1, 9)],
      [absent('Castelanos', 'Castellanos', 1, 3)],
      [absent('Castelanos', 'Castelano', 1, 40)],
    ])).toEqual([
      { typed: 'Castelanos', word: 'Castelano', distance: 1, records: 40 },
      { typed: 'invoce', word: 'invoice', distance: 1, records: 9 },
    ]);
  });

  it('prefers fewer edits over more records', () => {
    expect(mergeSpellingChecks([
      [absent('Carser', 'Carter', 1, 1)],
      [absent('Carser', 'Caesar', 2, 100)],
    ])[0]?.word).toBe('Carter');
  });

  it('ignores an index that did not check the word', () => {
    expect(mergeSpellingChecks([[absent('Lisbn', 'Lisbon', 1, 2)], []])).toEqual([
      { typed: 'Lisbn', word: 'Lisbon', distance: 1, records: 2 },
    ]);
  });
});

describe('absentFromAll', () => {
  it('lists the words no index holds, in the order typed — with or without anything close', () => {
    expect(absentFromAll([
      [{ typed: 'Zylberstein', present: false }, { typed: 'invoice', present: true },
        { typed: 'Castelanos', present: false, suggestion: { word: 'Castellanos', distance: 1, records: 2 } }],
      [{ typed: 'Zylberstein', present: false }, { typed: 'Castelanos', present: false }],
    ])).toEqual(['Zylberstein', 'Castelanos']);
  });

  it('⛔ never lists a word any index holds, nor one no index checked', () => {
    expect(absentFromAll([
      [{ typed: 'Kestral', present: false }],
      [{ typed: 'kestral', present: true }],
      [],
    ])).toEqual([]);
  });
});

describe('applySpellingCorrections', () => {
  it('replaces whole words where they stand and leaves everything else as typed', () => {
    expect(applySpellingCorrections(
      'Castelanos\'s invoce, from XCastelanos?',
      [{ typed: 'Castelanos', word: 'Castellanos' }, { typed: 'invoce', word: 'invoice' }],
    )).toBe('Castellanos\'s invoice, from XCastelanos?');
  });

  it('takes a suggestion literally, even one holding replacement syntax', () => {
    expect(applySpellingCorrections('pay $1', [{ typed: 'pay', word: '$&$&' }])).toBe('$&$& $1');
  });
});

describe('boundedEditDistance', () => {
  it('counts a swap of two neighbouring letters as one edit', () => {
    expect(boundedEditDistance('teh', 'the', 2)).toBe(1);
  });

  it('counts an accented letter as one character', () => {
    expect(boundedEditDistance('café', 'cafe', 1)).toBe(1);
  });

  it('stops at the bound', () => {
    expect(boundedEditDistance('castellanos', 'zzz', 2)).toBe(3);
    expect(boundedEditDistance('abcdef', 'uvwxyz', 2)).toBe(3);
  });
});
