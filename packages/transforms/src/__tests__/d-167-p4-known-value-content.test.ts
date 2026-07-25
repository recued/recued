import { describe, it, expect } from 'vitest';
import {
  createLedger,
  createCounters,
  getOrAllocate,
  scanContent,
  restoreInString,
  buildKnownValueIndex,
  aliasKnownValuesInContent,
  type KnownValueSeed,
} from '../pii-alias.js';

const index = (seeds: readonly KnownValueSeed[]) => buildKnownValueIndex(seeds);

describe('buildKnownValueIndex — dedup', () => {
  it('collapses case variants of the same kind to one canonical pattern (first wins)', () => {
    const idx = index([
      { value: 'Acme', kind: 'org' },
      { value: 'ACME', kind: 'org' },
      { value: 'acme', kind: 'org' },
    ]);
    expect(idx.meta).toEqual([{ value: 'Acme', kind: 'org' }]);
  });

  it('keeps BOTH a name and an org that share a value (kind is in the dedup key)', () => {
    const idx = index([
      { value: 'Acme Labs', kind: 'name' },
      { value: 'Acme Labs', kind: 'org' },
    ]);
    expect(idx.meta).toEqual([
      { value: 'Acme Labs', kind: 'name' },
      { value: 'Acme Labs', kind: 'org' },
    ]);
  });

  it('drops empty / whitespace-only values and trims edges', () => {
    const idx = index([
      { value: '   ', kind: 'name' },
      { value: '  Pat Lee  ', kind: 'name' },
    ]);
    expect(idx.meta).toEqual([{ value: 'Pat Lee', kind: 'name' }]);
  });

  it('does NOT collapse an expansion fold across distinct values (ß vs ss)', () => {
    // `Straße` and `Strasse` both UPPER-fold to STRASSE but take DIFFERENT automaton
    // paths, so the dedup must keep BOTH (else the dropped one never matches).
    const idx = index([
      { value: 'Straße GmbH', kind: 'org' },
      { value: 'Strasse GmbH', kind: 'org' },
    ]);
    expect(idx.meta).toHaveLength(2);
  });
});

describe('aliasKnownValuesInContent — discover + seed + replace', () => {
  it('aliases BOTH forms of an expansion collision distinctly (the dedup-leak regression)', () => {
    // With the NUL separator both are kept, so each ß-/ss-form aliases to its OWN
    // slot and round-trips — neither is silently dropped (the under-seed leak).
    const ledger = createLedger('s');
    const idx = index([
      { value: 'Strasse GmbH', kind: 'org' },
      { value: 'Straße GmbH', kind: 'org' },
    ]);
    const { text } = aliasKnownValuesInContent(ledger, 'pay Strasse GmbH and Straße GmbH', idx);
    expect(text).toBe('pay pii.Org1 and pii.Org2');
    expect(restoreInString(ledger, text)).toBe('pay Strasse GmbH and Straße GmbH');
  });

  it('seeds BOTH kinds on a name/org value collision; aliases deterministically + restores', () => {
    const ledger = createLedger('s');
    // Same string is a person name AND an org name (across two contacts). Name is
    // seeded first, so scanContent's longest-first (stable) replace picks it — the
    // kind is decided by seed order, never left ambiguous; both restore.
    const idx = index([
      { value: 'Acme Labs', kind: 'name' },
      { value: 'Acme Labs', kind: 'org' },
    ]);
    const { text } = aliasKnownValuesInContent(ledger, 'visit Acme Labs today', idx);
    expect(text).toBe('visit pii.Person1 today'); // name wins (seeded first)
    expect(restoreInString(ledger, text)).toBe('visit Acme Labs today');
  });

  it('seeds a registry name present in the text and aliases it; restore round-trips', () => {
    const ledger = createLedger('s');
    const idx = index([{ value: 'Lucía Castellanos', kind: 'name' }]);
    const { text, replacements } = aliasKnownValuesInContent(
      ledger,
      'ping Lucía Castellanos about the deal',
      idx,
    );
    expect(replacements).toBe(1);
    expect(text).toBe('ping pii.Person1 about the deal');
    expect(restoreInString(ledger, text)).toBe('ping Lucía Castellanos about the deal');
  });

  it('is a STRICT SUPERSET of the session-only scan (the leak the registry closes)', () => {
    // Empty session ledger: `scanContent` alone has nothing to match, so the value
    // egresses raw — exactly the cross-session recall leak. The registry index
    // seeds it, so `aliasKnownValuesInContent` aliases it (I3: A-C seeds ⊇ scan).
    const text = 'note from Diego Okafor';
    const sessionOnly = scanContent(createLedger('a'), text);
    expect(sessionOnly).toEqual({ text, replacements: 0 }); // raw — the leak

    const ledger = createLedger('b');
    const withRegistry = aliasKnownValuesInContent(ledger, text, index([{ value: 'Diego Okafor', kind: 'name' }]));
    expect(withRegistry.replacements).toBe(1);
    expect(restoreInString(ledger, withRegistry.text)).toBe(text);
  });

  it('respects scanContent boundary parity — a substring-only hit never seeds', () => {
    const idx = index([{ value: 'Son', kind: 'org' }]);
    // `son` inside `comparison` is preceded by a word char → leading boundary rejects.
    const interior = aliasKnownValuesInContent(createLedger('a'), 'a comparison of plans', idx);
    expect(interior).toEqual({ text: 'a comparison of plans', replacements: 0 });
    // A standalone, word-bounded `Son` DOES alias.
    const standalone = aliasKnownValuesInContent(createLedger('b'), 'my Son arrived', idx);
    expect(standalone.text).toBe('my pii.Org1 arrived');
  });

  it('aliases a CASING variant via a scanContent sibling; restore returns the variant', () => {
    const ledger = createLedger('s');
    const { text } = aliasKnownValuesInContent(ledger, 'PAT LEE called', index([{ value: 'Pat Lee', kind: 'name' }]));
    expect(text).toBe('cap_pii.Person1 called'); // casing sibling
    expect(restoreInString(ledger, text)).toBe('PAT LEE called'); // exact variant restored
  });

  it('aliases the SESSION ledger AND the registry values in ONE pass (the union)', () => {
    const ledger = createLedger('s');
    getOrAllocate(ledger, 'name', 'Bob Stone'); // a value the prefetch already seeded → pii.Person1
    const idx = index([{ value: 'Carol Diaz', kind: 'name' }]); // a registry-only value → pii.Person2
    const { text } = aliasKnownValuesInContent(ledger, 'Bob Stone met Carol Diaz', idx);
    expect(text).toBe('pii.Person1 met pii.Person2');
    expect(restoreInString(ledger, text)).toBe('Bob Stone met Carol Diaz');
  });

  it('seeds registry-resolved phone + email identifiers; restore round-trips to canonical', () => {
    const ledger = createLedger('s');
    const { text } = aliasKnownValuesInContent(
      ledger,
      'reach alice@acme.com or +1 415 555 0199',
      index([]), // identifiers do not go through the A-C
      [
        { kind: 'email', value: 'alice@acme.com' },
        { kind: 'phone', value: '+14155550199' },
      ],
    );
    expect(text).not.toContain('alice@acme.com');
    expect(text).not.toContain('0199');
    expect(text).toContain('@d1.invalid');
    expect(text).toContain('pii.Phone1');
    const restored = restoreInString(ledger, text);
    expect(restored).toContain('alice@acme.com');
    expect(restored).toContain('+14155550199'); // canonical E.164, not the typed spacing
  });

  it('counts ONLY content replacements (seeding is ledger prep, never double-counted)', () => {
    const ledger = createLedger('s');
    const counters = createCounters();
    aliasKnownValuesInContent(
      ledger,
      'hi Pat Lee and alice@acme.com',
      index([{ value: 'Pat Lee', kind: 'name' }]),
      [{ kind: 'email', value: 'alice@acme.com' }],
      counters,
    );
    expect(counters.content_text_replacements).toBeGreaterThan(0);
    expect(counters.name).toBe(0); // the name seed did not bump the identifier kinds
    expect(counters.email).toBe(0);
  });

  it('empty text / empty index is a clean no-op (the session-only fallback shape)', () => {
    expect(aliasKnownValuesInContent(createLedger('a'), '', index([]))).toEqual({ text: '', replacements: 0 });
    const ledger = createLedger('b');
    const text = 'nothing known here';
    expect(aliasKnownValuesInContent(ledger, text, index([]))).toEqual(
      scanContent(createLedger('c'), text), // byte-identical to a session-only scan over an empty ledger
    );
  });
});
