import { describe, it, expect } from 'vitest';
import {
  createLedger,
  createCounters,
  getOrAllocate,
  aliasIdentifierField,
  isAlreadyAliased,
  scanContent,
  restoreInString,
  restoreArgs,
  restoreArgsAndKeys,
  restoreArgKeys,
  aliasArgs,
  preScanReservePii,
  summarizeRedactions,
  splitEmail,
  splitUrl,
  parsePhoneCountryIso,
  nationalPhoneDigits,
  phoneMatchDigits,
  parseAddressComponents,
  ledgerKindForAlias,
  buildKnownValueIndex,
  seedKnownValuesFromContent,
  aliasKnownValuesInContent,
  decorateOverlapReveal,
  tokenizeForOverlap,
  containsPotentialPiiAliasLiteral,
  derivePiiRestoreAuthority,
  restoreInStringWithAuthority,
} from '../pii-alias.js';

/* ──────────────── ledgerKindForAlias (D-167 B3) ──────────────── */

describe('ledgerKindForAlias — alias-shape → ledger kind (B3 boundary routing)', () => {
  it('maps each readable-family alias to its kind', () => {
    expect(ledgerKindForAlias('pii.Person1')).toBe('name');
    expect(ledgerKindForAlias('pii.Org1')).toBe('org');
    expect(ledgerKindForAlias('pii.Phone1')).toBe('phone');
    expect(ledgerKindForAlias('pii.Phone1.gb')).toBe('phone'); // geo/iso suffix stripped
    expect(ledgerKindForAlias('pii.Address1')).toBe('address');
  });
  it('maps the email composite (drops the @domain half) + a casing sibling', () => {
    expect(ledgerKindForAlias('m1@d1.invalid')).toBe('email_local');
    expect(ledgerKindForAlias('cap_pii.Org2')).toBe('org');
  });
  it('is CASE-INSENSITIVE like restore — a case-mutated echo still resolves', () => {
    expect(ledgerKindForAlias('pii.org1')).toBe('org');
    expect(ledgerKindForAlias('PII.PERSON1')).toBe('name');
    expect(ledgerKindForAlias('pii.phone1.GB')).toBe('phone');
  });
  it('returns undefined for a BARE un-prefixed word a user might type (NOT an alias)', () => {
    // The whole point of the pii. prefix (Slice 2): a bare Org1/Person1 is a real
    // value, never routed.
    expect(ledgerKindForAlias('Org1')).toBeUndefined();
    expect(ledgerKindForAlias('Person1')).toBeUndefined();
    expect(ledgerKindForAlias('Acme Corp')).toBeUndefined();
    expect(ledgerKindForAlias('Phone1')).toBeUndefined();
  });
  it('returns undefined for non-routable / empty / non-string inputs', () => {
    expect(ledgerKindForAlias('')).toBeUndefined();
    expect(ledgerKindForAlias(undefined as unknown as string)).toBeUndefined();
    expect(ledgerKindForAlias('hello world')).toBeUndefined();
    // address/url/id ARE aliases but have no contact-search field — they still
    // return their kind (the caller's arg-map drops them); a bare domain → domain.
    expect(ledgerKindForAlias('d1.invalid')).toBe('domain');
  });
  it('does NOT false-route a raw string that merely CONTAINS an alias-ish shape', () => {
    // The gate is shape-SPECIFIC: a `pii.`-prefixed non-kind word, or a raw value
    // carrying `.invalid` that is not the exact m<N>@d<M>.invalid / d<N>.invalid
    // shape, must NOT route (else routeEntityRefSearchArgs would mis-move it).
    expect(ledgerKindForAlias('pii.hello')).toBeUndefined();
    expect(ledgerKindForAlias('Org1.invalid')).toBeUndefined();
    expect(ledgerKindForAlias('m1@foo.invalid')).toBeUndefined();
    expect(ledgerKindForAlias('pii.Org')).toBeUndefined();        // no digits
    expect(ledgerKindForAlias('notpii.Org1')).toBeUndefined();    // prefix not anchored
  });
});

/* ──────────────── Allocation primitives ──────────────── */

describe('getOrAllocate — lookup-or-allocate', () => {
  it('allocates monotonic IDs per kind within a scope', () => {
    const l = createLedger('s1');
    const a = getOrAllocate(l, 'name', 'Alice');
    const b = getOrAllocate(l, 'name', 'Bob');
    expect(a.alias_value).toBe('pii.Person1');
    expect(b.alias_value).toBe('pii.Person2');
  });

  it('reuses the same alias on repeat lookup', () => {
    const l = createLedger('s1');
    const a = getOrAllocate(l, 'org', 'Acme');
    const a2 = getOrAllocate(l, 'org', 'Acme');
    expect(a.alias_value).toBe('pii.Org1');
    expect(a2.alias_value).toBe('pii.Org1');
    expect(a).toBe(a2);
  });

  it('composite-key idempotency: same string under two kinds gets two independent aliases', () => {
    const l = createLedger('s1');
    const asName = getOrAllocate(l, 'name', 'Philip Moores');
    const asOrg = getOrAllocate(l, 'org', 'Philip Moores');
    expect(asName.alias_value).toBe('pii.Person1');
    expect(asOrg.alias_value).toBe('pii.Org1');
    expect(asName).not.toBe(asOrg);
  });

  it('counters increment per-kind independently', () => {
    const l = createLedger('s1');
    getOrAllocate(l, 'name', 'A');
    getOrAllocate(l, 'org', 'X');
    getOrAllocate(l, 'name', 'B');
    expect(getOrAllocate(l, 'name', 'C').alias_value).toBe('pii.Person3');
    expect(getOrAllocate(l, 'org', 'Y').alias_value).toBe('pii.Org2');
  });
});

/* ──────────────── Email + domain side-effect ──────────────── */

describe('aliasIdentifierField — email + domain side-effect', () => {
  it('first email allocates m1 + d1.invalid', () => {
    const l = createLedger('s1');
    const out = aliasIdentifierField(l, 'email', 'alice@acme.com');
    expect(out).toBe('m1@d1.invalid');
  });

  it('second email at the same host reuses d1.invalid, allocates m2', () => {
    const l = createLedger('s1');
    expect(aliasIdentifierField(l, 'email', 'alice@acme.com')).toBe('m1@d1.invalid');
    expect(aliasIdentifierField(l, 'email', 'bob@acme.com')).toBe('m2@d1.invalid');
  });

  it('email on a new host allocates m3 + d2.invalid', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    aliasIdentifierField(l, 'email', 'bob@acme.com');
    expect(aliasIdentifierField(l, 'email', 'john@xyz.com')).toBe('m3@d2.invalid');
  });

  it('email field aliasing is idempotent', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    expect(aliasIdentifierField(l, 'email', 'alice@acme.com')).toBe('m1@d1.invalid');
  });

  it('email is case-normalized (Alice@Acme.com === alice@acme.com)', () => {
    const l = createLedger('s1');
    expect(aliasIdentifierField(l, 'email', 'Alice@Acme.com')).toBe('m1@d1.invalid');
    expect(aliasIdentifierField(l, 'email', 'alice@acme.com')).toBe('m1@d1.invalid');
  });
});

describe('aliasIdentifierField — P0 already-alias idempotence guard', () => {
  it('returns an aliased email/name/org/phone/domain/url unchanged', () => {
    const l = createLedger('s1');
    expect(aliasIdentifierField(l, 'email', 'm1@d1.invalid')).toBe('m1@d1.invalid');
    expect(aliasIdentifierField(l, 'name', 'pii.Person1')).toBe('pii.Person1');
    expect(aliasIdentifierField(l, 'org', 'pii.Org2')).toBe('pii.Org2');
    expect(aliasIdentifierField(l, 'phone', 'pii.Phone1.gb')).toBe('pii.Phone1.gb');
    expect(aliasIdentifierField(l, 'url', 'https://d1.invalid/portal')).toBe('https://d1.invalid/portal');
  });

  it('does not consume an alias number for a skipped value', () => {
    const l = createLedger('s1');
    // Without the guard this aliased input would be treated as real and take m1/d1.
    aliasIdentifierField(l, 'email', 'm5@d3.invalid');
    expect(aliasIdentifierField(l, 'email', 'alice@acme.com')).toBe('m1@d1.invalid');
  });

  it('does not bump counters for a skipped alias', () => {
    const l = createLedger('s1');
    const counters = createCounters();
    aliasIdentifierField(l, 'name', 'pii.Person1', counters);
    expect(counters.name).toBe(0);
  });

  it('is idempotent — re-aliasing a real-value alias is a no-op', () => {
    const l = createLedger('s1');
    const emailOnce = aliasIdentifierField(l, 'email', 'alice@acme.com');
    expect(aliasIdentifierField(l, 'email', emailOnce)).toBe(emailOnce);
    const nameOnce = aliasIdentifierField(l, 'name', 'Alice Smith');
    expect(aliasIdentifierField(l, 'name', nameOnce)).toBe(nameOnce);
  });

  it('aliases a real external_id / account_id that looks like an alias (no false-positive skip)', () => {
    const l = createLedger('s1');
    // A real id (`Id123` / `Account9`) is the user's own raw value — never an
    // alias surface (Slice 2 aliases are `pii.Id<N>` / `pii.Account<N>`, and the
    // idempotence guard excludes those kinds besides). It MUST be aliased, never
    // skipped (skipping would egress it raw).
    expect(aliasIdentifierField(l, 'external_id', 'Id123')).not.toBe('Id123');
    expect(aliasIdentifierField(l, 'account_id', 'Account9')).not.toBe('Account9');
  });

  it('isAlreadyAliased — true for `pii.`-prefixed alias surfaces, false for real values', () => {
    for (const a of [
      'm1@d1.invalid', 'cap_m1@d1.invalid', 'd1.invalid', 'cap_d1.invalid',
      'pii.Person1', 'pii.Org12', 'pii.Phone1.gb', 'pii.Address1.san-francisco.ca.usa',
      'cap_pii.Person1', 'cap2_pii.Org3', 'https://d2.invalid/x',
    ]) {
      expect(isAlreadyAliased(a)).toBe(true);
    }
    for (const real of [
      'alice@acme.com', 'acme.com', 'Alice Smith', 'Acme Inc', '+14155550123',
      'https://acme.com/portal', '', 'Person',
      // Slice 2 collision-proofing — a BARE readable shape (no `pii.` prefix) is a
      // value a user types (anonymization labels, account refs), NOT an alias the
      // substrate emitted. Recognizing it would wrongly skip aliasing → raw leak.
      'Person1', 'Org12', 'Phone1.gb', 'cap_Person1',
      // external_id / account_id / fallback surfaces stay DELIBERATELY excluded
      // from recognition (never double-passed); a real id is always raw input.
      'Id123', 'Account1', 'Email3', 'Url7',
    ]) {
      expect(isAlreadyAliased(real)).toBe(false);
    }
  });
});

describe('aliasIdentifierField — URL + shared domain side-effect', () => {
  it('URL alias decomposes into d<N>.invalid host + preserved path', () => {
    const l = createLedger('s1');
    const out = aliasIdentifierField(l, 'url', 'https://acme.com/portal?id=42');
    expect(out).toBe('https://d1.invalid/portal?id=42');
  });

  it('email then URL share the same d1.invalid row (composite-key idempotency)', () => {
    const l = createLedger('s1');
    expect(aliasIdentifierField(l, 'email', 'alice@acme.com')).toBe('m1@d1.invalid');
    expect(aliasIdentifierField(l, 'url', 'https://acme.com/about'))
      .toBe('https://d1.invalid/about');
  });

  it('URL then email also share d1.invalid (order-independent side-effect)', () => {
    const l = createLedger('s1');
    expect(aliasIdentifierField(l, 'url', 'https://acme.com/about'))
      .toBe('https://d1.invalid/about');
    expect(aliasIdentifierField(l, 'email', 'alice@acme.com'))
      .toBe('m1@d1.invalid');
  });

  it('URL parse failure falls back to bare Url<N>', () => {
    const l = createLedger('s1');
    expect(aliasIdentifierField(l, 'url', 'not-a-url')).toBe('pii.Url1');
  });
});

/* ──────────────── Phone — suffix composition + parse-fail fallback ──────────────── */

describe('aliasIdentifierField — phone suffix composition', () => {
  it('US E.164 → pii.Phone1.us', () => {
    const l = createLedger('s1');
    expect(aliasIdentifierField(l, 'phone', '+1-415-555-0123')).toBe('pii.Phone1.us');
  });

  it('UK E.164 → pii.Phone1.gb', () => {
    const l = createLedger('s1');
    expect(aliasIdentifierField(l, 'phone', '+44-20-7946-0958')).toBe('pii.Phone1.gb');
  });

  it('parse-fail input (non-E.164) → bare pii.Phone1', () => {
    const l = createLedger('s1');
    expect(aliasIdentifierField(l, 'phone', '555-0123')).toBe('pii.Phone1');
  });

  it('three phones: monotonic IDs, distinct suffixes', () => {
    const l = createLedger('s1');
    expect(aliasIdentifierField(l, 'phone', '+1-415-555-0123')).toBe('pii.Phone1.us');
    expect(aliasIdentifierField(l, 'phone', '+44-20-7946-0958')).toBe('pii.Phone2.gb');
    expect(aliasIdentifierField(l, 'phone', '+49-30-1234-5678')).toBe('pii.Phone3.de');
  });
});

/* ──────────────── Address — structured input + parse-fail fallback ──────────────── */

describe('aliasIdentifierField — address suffix composition', () => {
  it('structured US address → pii.Address1.san-francisco.ca.usa', () => {
    const l = createLedger('s1');
    const out = aliasIdentifierField(l, 'address', '1 Main St, San Francisco, CA 94102, USA');
    expect(out).toBe('pii.Address1.san-francisco.ca.usa');
  });

  it('structured UK address → pii.Address1.london.gb (no state)', () => {
    const l = createLedger('s1');
    const out = aliasIdentifierField(l, 'address', 'Some Office, London, UK');
    expect(out).toBe('pii.Address1.london.gb');
  });

  it('unparseable single-blob address → bare pii.Address1', () => {
    const l = createLedger('s1');
    const out = aliasIdentifierField(l, 'address', 'somewhere in nowhere');
    expect(out).toBe('pii.Address1');
  });

  it('non-Latin script address → bare pii.Address1', () => {
    const l = createLedger('s1');
    const out = aliasIdentifierField(l, 'address', '東京都新宿区西新宿2-8-1');
    expect(out).toBe('pii.Address1');
  });
});

/* ──────────────── Cross-field alignment ──────────────── */

describe('cross-field alignment', () => {
  it('email + url + content all share the same d1.invalid row', () => {
    const l = createLedger('s1');
    const c = createCounters();
    aliasIdentifierField(l, 'email', 'alice@acme.com', c);
    aliasIdentifierField(l, 'url', 'https://acme.com/portal', c);
    const scan = scanContent(l, 'See the acme.com homepage', c);
    expect(scan.text).toContain('d1.invalid');
  });

  it('worked example from spec — full alignment across structured + content fields', () => {
    const l = createLedger('s1');
    const counters = createCounters();

    const packet = {
      owner_email: aliasIdentifierField(l, 'email', 'alice@acme.com', counters),
      owner_name:  aliasIdentifierField(l, 'name',  'Alice Chen',    counters),
      company_name: aliasIdentifierField(l, 'org',  'Acme',          counters),
      notes: scanContent(
        l,
        'Alice Chen confirmed renewal; Acme will sign by Friday. CC bob@acme.com on the contract email and ping acme.com/portal for the renewal page.',
        counters,
      ).text,
    };

    expect(packet.owner_email).toBe('m1@d1.invalid');
    expect(packet.owner_name).toBe('pii.Person1');
    expect(packet.company_name).toBe('pii.Org1');
    expect(packet.notes).toContain('pii.Person1 confirmed renewal');
    expect(packet.notes).toContain('pii.Org1 will sign by Friday');
    expect(packet.notes).toContain('CC m2@d1.invalid on the contract email');
    expect(packet.notes).toContain('ping d1.invalid/portal');

    const summary = summarizeRedactions(counters);
    expect(summary.email).toBe(1);
    expect(summary.name).toBe(1);
    expect(summary.org).toBe(1);
    expect(summary.content_text_replacements).toBeGreaterThanOrEqual(4);
    expect(summary).not.toHaveProperty('phone');     // no phone field in this packet
  });
});

/* ──────────────── Content-scan case-discipline ──────────────── */

describe('scanContent — case-discipline', () => {
  it('exact-case match reuses canonical alias', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'org', 'Acme');
    const out = scanContent(l, 'Acme will sign');
    expect(out.text).toBe('pii.Org1 will sign');
  });

  it('casing variant allocates cap_<canonical> sibling row', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'org', 'Acme');
    const out = scanContent(l, 'ACME announced today');
    expect(out.text).toBe('cap_pii.Org1 announced today');
  });

  it('canonical + casing variant emit distinct aliases in one packet', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'org', 'Acme');
    const out = scanContent(l, 'Acme prefers ACME branding in headlines.');
    expect(out.text).toBe('pii.Org1 prefers cap_pii.Org1 branding in headlines.');
  });

  it('two distinct casing variants → cap_ then cap2_', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'org', 'Acme');
    const out = scanContent(l, 'ACME and acme are the same brand');
    expect(out.text).toBe('cap_pii.Org1 and cap2_pii.Org1 are the same brand');
  });

  it('does NOT fresh-allocate unanchored spans (no NER, no regex extraction)', () => {
    const l = createLedger('s1');
    // No ledger anchor for "carol@otherorg.com" — must pass through raw.
    const out = scanContent(l, 'CC carol@otherorg.com on the follow-up');
    expect(out.text).toBe('CC carol@otherorg.com on the follow-up');
    expect(out.replacements).toBe(0);
  });
});

/* ──────────────── Domain-anchored email completion ──────────────── */

describe('scanContent — domain-anchored email completion', () => {
  it('aliased domain anchors a fresh email_local for new local-part mention', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');                     // m1, d1
    const out = scanContent(l, 'CC bob@acme.com on the contract');
    expect(out.text).toBe('CC m2@d1.invalid on the contract');
  });

  it('two new local-parts under a known domain get distinct email_local aliases', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');                     // m1, d1
    const out = scanContent(l, 'bob@acme.com and carol@acme.com');
    expect(out.text).toMatch(/^m\d+@d1\.invalid and m\d+@d1\.invalid$/);
    const matches = out.text.match(/m(\d+)@d1\.invalid/g)!;
    expect(matches).toHaveLength(2);
    expect(matches[0]).not.toBe(matches[1]);
  });

  it('does NOT alias emails at unknown domains (no ledger anchor)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    const out = scanContent(l, 'plus carol@unrelated.io for context');
    expect(out.text).toBe('plus carol@unrelated.io for context');
  });

  it('idempotent — same email mentioned twice gets one alias number', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    const out = scanContent(l, 'CC bob@acme.com and also bob@acme.com again');
    const matches = out.text.match(/m(\d+)@d1\.invalid/g)!;
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe(matches[1]);
  });
});

describe('scanContent — domain-anchored email completion boundaries', () => {
  const scanWithAcmeAnchor = (text: string) => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');                     // m1, d1
    return { l, text: scanContent(l, text).text };
  };

  it('completes sentence-final period before trailing text', () => {
    const out = scanWithAcmeAnchor('CC bob@acme.com. Thanks');
    expect(out.text).toBe('CC m2@d1.invalid. Thanks');
  });

  it('completes sentence-final period at end of string', () => {
    const out = scanWithAcmeAnchor('CC bob@acme.com.');
    expect(out.text).toBe('CC m2@d1.invalid.');
  });

  it('does not alias across an ASCII country-code suffix', () => {
    const out = scanWithAcmeAnchor('CC bob@acme.com.au today');
    expect(out.text).toBe('CC bob@acme.com.au today');
  });

  it('does not alias across a longer ASCII domain label', () => {
    const out = scanWithAcmeAnchor('CC bob@acme.community today');
    expect(out.text).toBe('CC bob@acme.community today');
  });

  it('does not alias across a Cyrillic domain label after a dot', () => {
    const out = scanWithAcmeAnchor('CC bob@acme.com.рф today');
    expect(out.text).toBe('CC bob@acme.com.рф today');
  });

  it('does not alias across a CJK domain label after a dot', () => {
    const out = scanWithAcmeAnchor('CC bob@acme.com.中文 today');
    expect(out.text).toBe('CC bob@acme.com.中文 today');
  });

  it('completes with no trailing punctuation', () => {
    const out = scanWithAcmeAnchor('CC bob@acme.com today');
    expect(out.text).toBe('CC m2@d1.invalid today');
  });

  it('completes before a trailing comma', () => {
    const out = scanWithAcmeAnchor('CC bob@acme.com, then Alice');
    expect(out.text).toBe('CC m2@d1.invalid, then Alice');
  });

  it('completes inside wrapping parentheses', () => {
    const out = scanWithAcmeAnchor('CC (bob@acme.com)');
    expect(out.text).toBe('CC (m2@d1.invalid)');
  });

  it('restores a completed sentence-final-period email exactly', () => {
    const original = 'CC bob@acme.com.';
    const out = scanWithAcmeAnchor(original);
    expect(out.text).toBe('CC m2@d1.invalid.');
    expect(restoreInString(out.l, out.text)).toBe(original);
  });
});

describe('scanContent - D-167 sentence-final periods and Unicode guards', () => {
  it('aliases a name before a sentence-final period', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Bob');
    const out = scanContent(l, 'talked to Bob.');
    expect(out.text).toBe('talked to pii.Person1.');
  });

  it('aliases an org before a sentence-final period', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'org', 'Acme');
    const out = scanContent(l, 'works at Acme.');
    expect(out.text).toBe('works at pii.Org1.');
  });

  it('aliases a bare domain before a sentence-final period', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'x@acme.com');
    const out = scanContent(l, 'visit acme.com.');
    expect(out.text).toBe('visit d1.invalid.');
  });

  it('does not alias a name inside a longer word', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Bob');
    const out = scanContent(l, 'meet Bobby');
    expect(out.text).toBe('meet Bobby');
  });

  it('does not partial-match a shorter ledger name inside a distinct longer token (no "John"→alias inside "Johnam")', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'John'); // pii.Person1
    // "Johnam" is a DIFFERENT value, not in the ledger → the word boundary blocks a
    // partial "John" replacement, so it rides through raw (NOT "pii.Person1am").
    expect(scanContent(l, 'tell Johnam now').text).toBe('tell Johnam now');
    // The standalone "John" still aliases.
    expect(scanContent(l, 'tell John now').text).toBe('tell pii.Person1 now');
  });

  it('gives a longer name its OWN alias when both are ledger values (longest-first)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'John'); // pii.Person1
    aliasIdentifierField(l, 'name', 'Johnam'); // pii.Person2
    // Longest-first: "Johnam" matches whole → pii.Person2; "John" then matches the
    // standalone token → pii.Person1. No "pii.Person1am" corruption.
    expect(scanContent(l, 'John and Johnam').text).toBe('pii.Person1 and pii.Person2');
  });

  it('does not alias a domain before an ASCII label continuation', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'x@acme.com');
    const out = scanContent(l, 'go to acme.com.au now');
    expect(out.text).toBe('go to acme.com.au now');
  });

  it('does not alias a domain before a Unicode label after a dot', () => {
    const cyrillicLabel = String.fromCodePoint(0x0440, 0x0444);
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'x@acme.com');
    const out = scanContent(l, `go to acme.com.${cyrillicLabel} now`);
    expect(out.text).toBe(`go to acme.com.${cyrillicLabel} now`);
  });

  it('does not alias a domain before an immediate Unicode continuation', () => {
    const cyrillicLabel = String.fromCodePoint(0x0440, 0x0444);
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'x@acme.com');
    const out = scanContent(l, `see acme.com${cyrillicLabel} now`);
    expect(out.text).toBe(`see acme.com${cyrillicLabel} now`);
  });

  it('does not Unicode-case-fold an ASCII account id literal', () => {
    const kelvin = String.fromCodePoint(0x212a);
    const l = createLedger('s1');
    aliasIdentifierField(l, 'account_id', 'K');
    const out = scanContent(l, `Use ${kelvin} today`);
    expect(out.text).toBe(`Use ${kelvin} today`);
  });

  it('still aliases an ASCII-case-insensitive account id literal', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'account_id', 'K');
    const out = scanContent(l, 'Use K today');
    expect(out.text).toBe('Use pii.Account1 today');
  });

  it('preserves a name match before a space boundary', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Bob');
    const out = scanContent(l, 'Bob went home');
    expect(out.text).toBe('pii.Person1 went home');
  });

  it('preserves a name match before a comma boundary', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Bob');
    const out = scanContent(l, 'hi Bob, ok');
    expect(out.text).toBe('hi pii.Person1, ok');
  });

  it('round-trips a name before a sentence-final period through restore', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Bob');
    const out = scanContent(l, 'talked to Bob.');
    expect(out.text).toBe('talked to pii.Person1.');
    expect(restoreInString(l, out.text)).toBe('talked to Bob.');
  });
});

/* ──────────────── Restore symmetry ──────────────── */

describe('restoreInString — round-trip', () => {
  it('restores canonical aliases for all kinds', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    aliasIdentifierField(l, 'name', 'Alice Chen');
    aliasIdentifierField(l, 'org', 'Acme');
    aliasIdentifierField(l, 'phone', '+44-20-7946-0958');
    aliasIdentifierField(l, 'address', '1 Main St, San Francisco, CA 94102, USA');

    const aliased = 'pii.Person1 at pii.Org1 (m1@d1.invalid, pii.Phone1.gb, pii.Address1.san-francisco.ca.usa)';
    const restored = restoreInString(l, aliased);
    expect(restored).toBe(
      'Alice Chen at Acme (alice@acme.com, +44-20-7946-0958, 1 Main St, San Francisco, CA 94102, USA)',
    );
  });

  it('suffix tolerance — pii.Phone1 (bare) restores even when ledger stored pii.Phone1.gb', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'phone', '+44-20-7946-0958');
    expect(restoreInString(l, 'Call pii.Phone1 tomorrow')).toBe('Call +44-20-7946-0958 tomorrow');
  });

  it('wrong-suffix tolerance — pii.Phone1.us restores when ledger stored pii.Phone1.gb', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'phone', '+44-20-7946-0958');
    expect(restoreInString(l, 'Call pii.Phone1.us tomorrow'))
      .toBe('Call +44-20-7946-0958 tomorrow');
  });

  it('bare-Address tolerance — pii.Address1 restores without geo suffix', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'address', '1 Main St, San Francisco, CA 94102, USA');
    expect(restoreInString(l, 'Mail to pii.Address1 today'))
      .toBe('Mail to 1 Main St, San Francisco, CA 94102, USA today');
  });

  it('case-insensitive fallback — pii.person1 / PII.PERSON1 still restore (prefix case-folded too)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Alice Chen');
    expect(restoreInString(l, 'pii.person1 confirmed')).toBe('Alice Chen confirmed');
    expect(restoreInString(l, 'PII.PERSON1 confirmed')).toBe('Alice Chen confirmed');
  });

  it('sibling aliases restore variant casing distinct from canonical', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'org', 'Acme');
    scanContent(l, 'Acme prefers ACME branding');         // allocates pii.Org1 + cap_pii.Org1
    const restored = restoreInString(l, 'pii.Org1 vs cap_pii.Org1');
    expect(restored).toBe('Acme vs ACME');
  });

  it('unknown aliases pass through unchanged (no rejection)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Alice Chen');
    expect(restoreInString(l, 'pii.Person1 and pii.Person99 disagreed'))
      .toBe('Alice Chen and pii.Person99 disagreed');
  });

  it('Slice 2 collision-proofing — a bare user-typed Person1 does NOT restore to an allocated alias', () => {
    const l = createLedger('s1');
    // Turn 1 allocates pii.Person1 ↔ Pat Lee.
    expect(aliasIdentifierField(l, 'name', 'Pat Lee')).toBe('pii.Person1');
    // Turn 2: the user writes a note anonymizing a FRIEND as the literal "Person1".
    // Pre-Slice-2 the bare alias surface collided — restore mapped every `Person1`
    // → Pat Lee, corrupting the friend's label AND leaking Pat Lee into the note.
    // With the `pii.` prefix a bare `Person1`/`Account5`/`Id9` is not an alias, so
    // it rides through restore untouched.
    expect(restoreInString(l, "let's call my friend Person1 — and CC Account5, ref Id9"))
      .toBe("let's call my friend Person1 — and CC Account5, ref Id9");
    // The real alias the substrate DID emit still restores.
    expect(restoreInString(l, 'pii.Person1 owns the deal')).toBe('Pat Lee owns the deal');
  });

  it('does not fuzzy-restore mutated alias shapes (`Person 1`, `person_1`)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Alice Chen');
    expect(restoreInString(l, 'Person 1 and person_1 spoke'))
      .toBe('Person 1 and person_1 spoke');
  });
});

/* ──────────────── Emitted-alias completeness (domain + bare-m) ──────────────── */

// The hard invariant: EVERY alias the substrate emits must round-trip, and a
// token the substrate never emits must pass through untouched. These guard two
// restore-path bugs found adopting pii-protect/pii-restore into the mail
// extractors (whose restored output feeds DURABLE work-entity writes, so a
// survived-or-corrupted alias is worse than the transient triage notification).
describe('restoreInString — emitted-alias completeness (domain + bare-m guards)', () => {
  it('a content-scanned bare domain (d<N>.invalid) restores to the real domain', () => {
    // The sender email seeds domain acme.com → d1.invalid; a bare-domain
    // mention in content is aliased to d1.invalid, so restore is OBLIGATED to
    // reverse it (the substrate emitted it). Guards the `stripAliasSuffix`
    // domain carve-out — without it `d1.invalid` strips to `d1`, kindFromBase
    // misses, and the emitted alias survives restore unchanged.
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');               // m1 + d1.invalid
    const scanned = scanContent(l, 'Portal lives at acme.com today').text;
    expect(scanned).toBe('Portal lives at d1.invalid today');         // emitted
    expect(restoreInString(l, scanned)).toBe('Portal lives at acme.com today');
  });

  it('a URL alias host (https://d<N>.invalid/...) restores to the real host', () => {
    // Same domain-restore bug surfaced through a URL's aliased host.
    const l = createLedger('s1');
    aliasIdentifierField(l, 'url', 'https://acme.com/portal?id=42');   // domain → d1.invalid
    expect(restoreInString(l, 'see https://d1.invalid/portal?id=42'))
      .toBe('see https://acme.com/portal?id=42');
  });

  it('a bare "M1"/"m1" token is an ambiguous surface and passes through restore unchanged', () => {
    // No emitted email alias is ever a standalone bare m<N>: a well-formed email
    // emits the composite m<N>@d<M>.invalid, a malformed email emits the
    // unambiguous Email<N> (D-167 restore-completeness). A bare m<N> is therefore
    // indistinguishable from a literal "M1"/"m1" token, so the case-insensitive
    // restore fallback must not corrupt those legitimate non-alias tokens (model
    // codes, milestones) into the sender's real email. Guards keeping `m` out of
    // the CI-fallback alternation.
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');               // m1@d1.invalid in ledger
    expect(restoreInString(l, 'Buy the M1 MacBook and review m1 budget'))
      .toBe('Buy the M1 MacBook and review m1 budget');
    // …while the composite the substrate DID emit still restores.
    expect(restoreInString(l, 'mail m1@d1.invalid')).toBe('mail alice@acme.com');
  });
});

describe('restoreInString — D-167 PII-alias restore-completeness edges', () => {
  it('restores malformed-email pii.Email<N> aliases without colliding with composite email aliases', () => {
    const l = createLedger('s1');

    expect(aliasIdentifierField(l, 'email', 'alice (at) acme dot com')).toBe('pii.Email1');
    expect(restoreInString(l, 'Reach pii.Email1 today'))
      .toBe('Reach alice (at) acme dot com today');
    expect(restoreInString(l, 'reach PII.EMAIL1 today'))
      .toBe('reach alice (at) acme dot com today');

    expect(aliasIdentifierField(l, 'email', 'alice@acme.com')).toBe('m1@d1.invalid');
    expect(restoreInString(l, 'Use pii.Email1 and m1@d1.invalid'))
      .toBe('Use alice (at) acme dot com and alice@acme.com');
  });

  it('restores a content-scanned casing-sibling domain alias to the matched variant', () => {
    const l = createLedger('s1');

    aliasIdentifierField(l, 'email', 'alice@acme.com');
    const scanned = scanContent(l, 'visit ACME.COM now').text;

    expect(scanned).toBe('visit cap_d1.invalid now');
    expect(restoreInString(l, scanned)).toBe('visit ACME.COM now');
  });

  it('restores case-mutated composite email aliases and standalone domains', () => {
    const l = createLedger('s1');

    aliasIdentifierField(l, 'email', 'alice@acme.com');

    const restoredComposite = restoreInString(l, 'M1@d1.invalid');
    expect(restoredComposite).toBe('alice@acme.com');
    expect(restoreInString(l, 'm1@D1.INVALID')).toBe('alice@acme.com');
    expect(restoreInString(l, 'M1@D1.INVALID')).toBe('alice@acme.com');
    expect(restoredComposite.startsWith('M1@')).toBe(false);
    expect(restoredComposite).not.toBe('M1@acme.com');
    expect(restoreInString(l, 'go to D1.INVALID')).toBe('go to acme.com');
  });

  it('restores a domain alias inside a non-composite email shape (restores anywhere — not corruption)', () => {
    // The domain alias d<N>.invalid is a standalone emitted token; restoring it
    // wherever it appears — bare, as a URL host, or as the host of an email the
    // LLM constructed at the aliased domain — IS the round-trip invariant (same
    // as the URL-host case). The local part here is not an m<N> alias, so only
    // the domain half restores. Pins the resolution of the pass-2 domain-alt
    // review lead: intended behavior, NOT a literal-token corruption.
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');               // d1.invalid = acme.com
    expect(restoreInString(l, 'admin@d1.invalid')).toBe('admin@acme.com');
  });

  it('does not restore literal or unknown non-alias tokens into real PII', () => {
    const l = createLedger('s1');

    aliasIdentifierField(l, 'email', 'alice@acme.com');

    expect(restoreInString(l, 'Buy the M1 MacBook and review m1 budget'))
      .toBe('Buy the M1 MacBook and review m1 budget');
    expect(restoreInString(l, 'M99@d99.invalid')).toBe('M99@d99.invalid');
  });

  it('still restores pre-existing bare alias kinds', () => {
    const l = createLedger('s1');

    aliasIdentifierField(l, 'name', 'Alice Chen');
    aliasIdentifierField(l, 'org', 'Acme');
    aliasIdentifierField(l, 'phone', '+44-20-7946-0958');

    expect(restoreInString(l, 'pii.Person1 at pii.Org1 on pii.Phone1.gb'))
      .toBe('Alice Chen at Acme on +44-20-7946-0958');
  });
});

describe('restoreInString — D-167 suffixed casing-sibling aliases', () => {
  it('round-trips an address casing sibling through restore', () => {
    const l = createLedger('s1');
    const seeded = aliasIdentifierField(l, 'address', '1 Main St, San Francisco, CA 94102, USA');
    const variant = '1 main st, san francisco, ca 94102, usa';
    const text = `Ship to ${variant} please`;
    const scanned = scanContent(l, text).text;

    expect({
      seeded,
      scanned,
      restored: restoreInString(l, scanned),
    }).toEqual({
      seeded: 'pii.Address1.san-francisco.ca.usa',
      scanned: 'Ship to cap_pii.Address1.san-francisco.ca.usa please',
      restored: text,
    });
  });

  it('round-trips distinct address casing siblings through cap and cap2 aliases', () => {
    const l = createLedger('s1');
    const seeded = aliasIdentifierField(l, 'address', '1 Main St, San Francisco, CA 94102, USA');
    const upperVariant = '1 MAIN ST, SAN FRANCISCO, CA 94102, USA';
    const lowerVariant = '1 main st, san francisco, ca 94102, usa';
    const text = `Ship to ${upperVariant}; backup ${lowerVariant}`;
    const scanned = scanContent(l, text).text;

    expect({
      seeded,
      scanned,
      restored: restoreInString(l, scanned),
    }).toEqual({
      seeded: 'pii.Address1.san-francisco.ca.usa',
      scanned: 'Ship to cap_pii.Address1.san-francisco.ca.usa; backup cap2_pii.Address1.san-francisco.ca.usa',
      restored: text,
    });
  });

  it('keeps non-suffixed org sibling restore behavior unchanged', () => {
    const l = createLedger('s1');
    const seeded = aliasIdentifierField(l, 'org', 'Acme');
    const scanned = scanContent(l, 'ACME and acme').text;

    expect({
      seeded,
      scanned,
      restored: restoreInString(l, scanned),
    }).toEqual({
      seeded: 'pii.Org1',
      scanned: 'cap_pii.Org1 and cap2_pii.Org1',
      restored: 'ACME and acme',
    });
  });

  it('keeps domain sibling restore behavior on the suffix carve-out path', () => {
    const l = createLedger('s1');
    const seeded = aliasIdentifierField(l, 'email', 'alice@acme.com');
    const scanned = scanContent(l, 'visit ACME.COM now').text;

    expect({
      seeded,
      scanned,
      restored: restoreInString(l, scanned),
    }).toEqual({
      seeded: 'm1@d1.invalid',
      scanned: 'visit cap_d1.invalid now',
      restored: 'visit ACME.COM now',
    });
  });
});

/* ──────────────── Outbound-write arg restore ──────────────── */

describe('restoreArgs — outbound write paths (VALUE-only; keys preserved)', () => {
  it('does NOT rewrite an object KEY that merely looks like an alias (shared restore stays key-blind)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com'); // m1@d1.invalid ↔ alice@acme.com
    aliasIdentifierField(l, 'name', 'Alice Chen'); // pii.Person1 ↔ Alice Chen
    // A legitimate approval-preview / recipe map keyed by these literals must NOT be
    // rewritten — only string VALUES restore.
    const out = restoreArgs(l, { 'pii.Person1': 1, 'm1@d1.invalid': 2, label: 'pii.Person1' }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['label', 'm1@d1.invalid', 'pii.Person1']);
    expect(out.label).toBe('Alice Chen'); // the VALUE still restores
  });

  it('restores aliases inside nested args structure', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    aliasIdentifierField(l, 'name', 'Alice Chen');

    const args = {
      to: 'm1@d1.invalid',
      subject: 'Quick word with pii.Person1',
      payload: { recipient: 'pii.Person1', cc: ['m1@d1.invalid'] },
    };
    const restored = restoreArgs(l, args);
    expect(restored).toEqual({
      to: 'alice@acme.com',
      subject: 'Quick word with Alice Chen',
      payload: { recipient: 'Alice Chen', cc: ['alice@acme.com'] },
    });
  });

  it('unknown alias in outbound args passes through unchanged (comfort, no rejection)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    const args = { to: 'm99@d99.invalid', subject: 'Unknown alias passes through' };
    expect(restoreArgs(l, args)).toEqual(args);
  });

  it('does not pollute object prototype during nested restore', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Alice Chen');
    const data = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad","subject":"Hello pii.Person1"}',
    );
    const out = restoreArgs(l, data) as Record<string, unknown>;
    expect(out.subject).toBe('Hello Alice Chen');
    expect(Object.prototype.hasOwnProperty.call(out, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'prototype')).toBe(false);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('preserves primitive (non-string) values verbatim', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Alice Chen');
    const args = { count: 42, active: true, ratio: 0.5, when: null, recipient: 'pii.Person1' };
    expect(restoreArgs(l, args)).toEqual({ ...args, recipient: 'Alice Chen' });
  });
});

describe('restoreArgsAndKeys — KEY-AWARE restore (scoped to model tool-call args)', () => {
  it('restores an alias in an object KEY (the model copied an aliased result-map key)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    const out = restoreArgsAndKeys(l, { 'm1@d1.invalid': 'done', note: 'see m1@d1.invalid' }) as Record<string, unknown>;
    expect(Object.keys(out)).toContain('alice@acme.com');
    expect(Object.keys(out)).not.toContain('m1@d1.invalid');
    expect(out.note).toBe('see alice@acme.com');
  });

  it('round-trips a PII key through aliasArgs → restoreArgsAndKeys', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    const real = { 'alice@acme.com': { stage: 'open' } };
    expect(restoreArgsAndKeys(l, aliasArgs(l, real))).toEqual(real);
  });
});

describe('aliasArgs — forward re-alias of restored args (the inverse of restoreArgs)', () => {
  it('re-aliases ledger-known real values across a nested args structure', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    aliasIdentifierField(l, 'name', 'Alice Chen');

    const realArgs = {
      to: 'alice@acme.com',
      subject: 'Quick word with Alice Chen',
      payload: { recipient: 'Alice Chen', cc: ['alice@acme.com'] },
    };
    expect(aliasArgs(l, realArgs)).toEqual({
      to: 'm1@d1.invalid',
      subject: 'Quick word with pii.Person1',
      payload: { recipient: 'pii.Person1', cc: ['m1@d1.invalid'] },
    });
  });

  it('round-trips with restoreArgs (alias→restore returns the original)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    aliasIdentifierField(l, 'name', 'Alice Chen');
    const realArgs = { to: 'alice@acme.com', note: 'ping Alice Chen', n: 3 };
    expect(restoreArgs(l, aliasArgs(l, realArgs))).toEqual(realArgs);
  });

  it('aliases a value under a key that CONTAINS a literal dot (value-based, not dot-path)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    const out = aliasArgs(l, { 'filter.contact.email': 'alice@acme.com' }) as Record<string, unknown>;
    // The dotted key survives intact; only the VALUE is aliased.
    expect(out['filter.contact.email']).toBe('m1@d1.invalid');
  });

  it('leaves an unknown value untouched (ledger-anchored, no NER / fresh allocation)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    const args = { to: 'zoe@elsewhere.com', n: 1 };
    expect(aliasArgs(l, args)).toEqual(args);
  });

  it('counts content replacements when a counters bag is supplied', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Alice Chen');
    const counters = createCounters();
    aliasArgs(l, { a: 'hi Alice Chen', b: 'and Alice Chen again' }, counters);
    expect(counters.content_text_replacements).toBe(2);
  });

  it('does not pollute object prototype during a nested re-alias', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Alice Chen');
    const data = JSON.parse('{"__proto__":{"polluted":true},"subject":"Hello Alice Chen"}');
    const out = aliasArgs(l, data) as Record<string, unknown>;
    expect(out.subject).toBe('Hello pii.Person1');
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('aliases ledger-known PII in object KEYS, not just values (egress is key-aware)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    // A result map keyed by the contact email — the key is PII too.
    const out = aliasArgs(l, { 'alice@acme.com': { stage: 'open' }, note: 'ping alice@acme.com' }) as Record<string, unknown>;
    expect(Object.keys(out)).toContain('m1@d1.invalid');
    expect(Object.keys(out)).not.toContain('alice@acme.com');
    expect(out.note).toBe('ping m1@d1.invalid');
  });

  it('aliases distinct PII keys to distinct aliases (no collision for real data)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    aliasIdentifierField(l, 'email', 'bob@acme.com');
    const out = aliasArgs(l, { 'alice@acme.com': 1, 'bob@acme.com': 2 }) as Record<string, unknown>;
    expect(out).toEqual({ 'm1@d1.invalid': 1, 'm2@d1.invalid': 2 });
  });

  it('aliases a non-email value EMBEDDED in a machine-style key (after an identifier separator)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'Alice Chen');
    aliasIdentifierField(l, 'external_id', 'CONTACT-77');
    // The prose word boundary treats `_` as part of the identifier; the key pass
    // uses alphanumeric boundaries so the separator-embedded value is caught.
    const out = aliasArgs(l, { 'owner_Alice Chen': 1, 'x_CONTACT-77': 2 }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['owner_pii.Person1', 'x_pii.Id1']);
  });

  it('does NOT alias a value that is a mid-alphanumeric substring of a key (no over-alias)', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'name', 'John'); // pii.Person1
    // "John" is a substring of "Johnam" with no separator → not a whole identifier token.
    const out = aliasArgs(l, { Johnam_id: 1 }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['Johnam_id']);
  });

  it('round-trips a separator-embedded PII key through aliasArgs → restoreArgsAndKeys', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'external_id', 'CONTACT-77');
    const real = { 'owner_CONTACT-77': { stage: 'open' } };
    expect(restoreArgsAndKeys(l, aliasArgs(l, real))).toEqual(real);
  });
});

/* ──────────────── Parsers (sanity / direct exercise) ──────────────── */

describe('splitEmail', () => {
  it('lowercases + splits a canonical address', () => {
    expect(splitEmail('Alice@Acme.com')).toEqual({ local: 'alice', domain: 'acme.com' });
  });
  it('rejects malformed inputs', () => {
    expect(splitEmail('no-at-sign')).toBeUndefined();
    expect(splitEmail('@nolocal.com')).toBeUndefined();
    expect(splitEmail('local@')).toBeUndefined();
    expect(splitEmail('two@@signs.com')).toBeUndefined();
    expect(splitEmail('no.dot@hostpart')).toBeUndefined();
  });
});

describe('splitUrl', () => {
  it('splits scheme + host + rest', () => {
    expect(splitUrl('https://acme.com/portal?id=42')).toEqual({
      scheme: 'https', host: 'acme.com', rest: '/portal?id=42',
    });
  });
  it('returns undefined on malformed URL', () => {
    expect(splitUrl('not-a-url')).toBeUndefined();
  });
});

describe('parsePhoneCountryIso', () => {
  it('handles 1-digit, 2-digit, 3-digit country codes', () => {
    expect(parsePhoneCountryIso('+1-415-555-0123')).toBe('us');
    expect(parsePhoneCountryIso('+44-20-7946-0958')).toBe('gb');
    expect(parsePhoneCountryIso('+352-26-12-34-56')).toBe('lu');
  });
  it('rejects non-E.164', () => {
    expect(parsePhoneCountryIso('415-555-0123')).toBeUndefined();
    expect(parsePhoneCountryIso('+0-not-real')).toBeUndefined();
  });
});

describe('nationalPhoneDigits', () => {
  it('strips a known country code', () => {
    expect(nationalPhoneDigits('+14155550199')).toBe('4155550199');
    expect(nationalPhoneDigits('+44 20 7946 0958')).toBe('2079460958');
    expect(nationalPhoneDigits('+352-26-12-34-56')).toBe('26123456'); // 3-digit code
  });
  it('undefined for non-E.164 or unknown country code', () => {
    expect(nationalPhoneDigits('415-555-0199')).toBeUndefined();
    expect(nationalPhoneDigits('+9991234567')).toBeUndefined();
  });
});

describe('phoneMatchDigits', () => {
  it('full + national for a no-trunk country (NANP)', () => {
    expect(phoneMatchDigits('+14155550199')).toEqual({ full: '14155550199', national: ['4155550199'] });
  });
  it('adds the trunk-0 national form for a trunk-0 country', () => {
    expect(phoneMatchDigits('+442079460958'))
      .toEqual({ full: '442079460958', national: ['2079460958', '02079460958'] });
  });
  it('full only (no national) for a non-E.164 / unknown-country value', () => {
    expect(phoneMatchDigits('555-0199')).toEqual({ full: '5550199', national: [] });        // 7 digits, no +CC split
    expect(phoneMatchDigits('+9991234567')).toEqual({ full: '9991234567', national: [] });  // unknown code → no national
  });
  it('full undefined when no form reaches 7 digits', () => {
    expect(phoneMatchDigits('+1234')).toEqual({ full: undefined, national: [] });
    expect(phoneMatchDigits('')).toEqual({ full: undefined, national: [] });
  });
});

describe('parseAddressComponents', () => {
  it('splits US structured address', () => {
    expect(parseAddressComponents('1 Main St, San Francisco, CA 94102, USA')).toEqual({
      city: 'san-francisco', state: 'ca', country_iso: 'usa',
    });
  });
  it('UK structured address (no state)', () => {
    expect(parseAddressComponents('Some Office, London, UK')).toEqual({
      city: 'london', country_iso: 'gb',
    });
  });
  it('returns undefined on freeform blob', () => {
    expect(parseAddressComponents('somewhere in nowhere')).toBeUndefined();
  });
});

/* ──────────────── Counter / summary ──────────────── */

describe('summarizeRedactions', () => {
  it('emits only non-zero kinds in the audit summary', () => {
    const counters = createCounters();
    counters.email = 2;
    counters.name = 1;
    counters.content_text_replacements = 4;
    const out = summarizeRedactions(counters);
    expect(out).toEqual({ email: 2, name: 1, content_text_replacements: 4 });
  });
});

describe('scanContent — phone-variant matching (ledger-anchored, no NER)', () => {
  const seed = (): { l: ReturnType<typeof createLedger>; alias: string } => {
    const l = createLedger('s1');
    const alias = aliasIdentifierField(l, 'phone', '+14155550199'); // e.g. pii.Phone1.us
    return { l, alias };
  };

  it('aliases a known phone typed with different separators (same digit run)', () => {
    for (const variant of [
      'call me at 1-415-555-0199 tomorrow',
      'reach +1 (415) 555-0199 anytime',
      'dial 1.415.555.0199 now',
      'number is +14155550199',
    ]) {
      const { l, alias } = seed();
      const out = scanContent(l, variant).text;
      expect(out, variant).toContain(alias);
      expect(out, variant).not.toContain('0199');
    }
  });

  it('aliases the national form (known country code stripped)', () => {
    // 4155550199 is the national run of the stored +14155550199 (US `1` code) —
    // the layout a user typically types. The national pattern aliases it.
    for (const variant of [
      'try (415) 555-0199 instead',
      'her cell is 415-555-0199',
      'dial 415.555.0199 now',
      'reach (415) 555 0199 anytime',
    ]) {
      const { l, alias } = seed();
      const out = scanContent(l, variant).text;
      expect(out, variant).toContain(alias);
      expect(out, variant).not.toContain('0199');
    }
  });

  it('aliases an international national form with or without the trunk 0 (trunk-0 country)', () => {
    // E.164 drops the leading-0 trunk a UK user writes (`020…`), and `gb` is a
    // TRUNK_ZERO_ISO country, so the national pattern tolerates that optional 0.
    for (const variant of [
      'reach 020 7946 0958 anytime',   // trunk 0 present
      'reach 20 7946 0958 anytime',    // trunk 0 omitted
    ]) {
      const l = createLedger('s1');
      const alias = aliasIdentifierField(l, 'phone', '+442079460958'); // pii.Phone1.gb
      const out = scanContent(l, variant).text;
      expect(out, variant).toContain(alias);
      expect(out, variant).not.toContain('0958');
    }
  });

  it('does NOT accept a leading 0 for a no-trunk country (NANP)', () => {
    // NANP has no trunk prefix, so a stray `0` before a US contact's national
    // run is a DIFFERENT domestic number — it must stay raw, not alias to the US
    // contact. The bare national form (no leading 0) still aliases.
    const l = createLedger('s1');
    const alias = aliasIdentifierField(l, 'phone', '+14155550199'); // pii.Phone1.us
    expect(scanContent(l, 'ring 0415 555 0199 today').text).toBe('ring 0415 555 0199 today');
    expect(scanContent(l, 'ring 415 555 0199 today').text).toContain(alias);
  });

  it('does not touch a different number, a date, or a short numeric (digit-equality gate)', () => {
    const { l } = seed();
    expect(scanContent(l, 'meeting on 2024-01-02').text).toBe('meeting on 2024-01-02');
    expect(scanContent(l, 'call 1-415-555-0200 instead').text).toBe('call 1-415-555-0200 instead');
    expect(scanContent(l, 'order 5550199 shipped').text).toBe('order 5550199 shipped');
  });

  it('national pass does NOT match the tail of a different longer number', () => {
    // Only UK +442079460958 (national 2079460958) is known. A DIFFERENT number
    // that shares that national tail must stay raw — neither the +CC form nor the
    // plain leading-country-digit form may rewrite its tail to the UK alias
    // (which would mis-restore the UK contact into a value the user never typed).
    for (const text of [
      'call +1 207 946 0958 now',   // +CC prefix
      'call 1-207-946-0958 now',    // bare leading country digit (NANP)
    ]) {
      const l = createLedger('s1');
      const alias = aliasIdentifierField(l, 'phone', '+442079460958');
      const out = scanContent(l, text).text;
      expect(out, text).toBe(text);
      expect(out, text).not.toContain(alias);
    }
  });

  it('drops an ambiguous national run shared by two contacts (full forms still alias)', () => {
    // US +12079460958 and UK +442079460958 both reduce to national 2079460958.
    // A bare national mention is a coin-flip → left raw; the unambiguous FULL
    // E.164 forms still alias to their own contact.
    const l = createLedger('s1');
    const us = aliasIdentifierField(l, 'phone', '+12079460958');
    const uk = aliasIdentifierField(l, 'phone', '+442079460958');
    expect(scanContent(l, 'ring 207 946 0958 please').text).toBe('ring 207 946 0958 please');
    expect(scanContent(l, 'ring +12079460958').text).toContain(us);
    expect(scanContent(l, 'ring +442079460958').text).toContain(uk);
  });

  it('is a no-op when no phone is in the ledger', () => {
    const l = createLedger('s1');
    aliasIdentifierField(l, 'email', 'alice@acme.com');
    expect(scanContent(l, 'call 1-415-555-0199').text).toBe('call 1-415-555-0199');
  });

  it('is precise — sandwiched id, trailing number, adjacent number (no over-grab)', () => {
    const { l, alias } = seed();
    // Digits sandwiched inside an alphanumeric id → not the phone → preserved.
    expect(scanContent(l, 'order ABC14155550199XYZ shipped').text).toBe(
      'order ABC14155550199XYZ shipped',
    );
    // A known phone immediately followed by another number → phone aliased, the
    // trailing number kept (the pattern matches EXACTLY the phone's digits, so it
    // can't swallow the trailing `2` and miss).
    const t7 = scanContent(l, 'call 1-415-555-0199 2pm').text;
    expect(t7).not.toContain('0199');
    expect(t7).toContain('2pm');
    // A known phone adjacent to a DIFFERENT number → phone aliased, the other
    // number kept (no merge into one span).
    const t4 = scanContent(l, 'reach +1 415 555 0199 650 555 0100').text;
    expect(t4).toContain(alias);
    expect(t4).toContain('650 555 0100');
  });
});

describe('D-167 Slice 2 alias prefix adversarial coverage', () => {
  it('generates pii-prefixed readable aliases while leaving composite email and domain aliases unprefixed', () => {
    const l = createLedger('s201');

    expect(aliasIdentifierField(l, 'name', 'Alice')).toBe('pii.Person1');
    expect(aliasIdentifierField(l, 'org', 'Acme')).toBe('pii.Org1');
    expect(aliasIdentifierField(l, 'phone', '+44-20-7946-0958')).toBe('pii.Phone1.gb');
    expect(aliasIdentifierField(l, 'address', '1 Main St, San Francisco, CA 94102, USA'))
      .toBe('pii.Address1.san-francisco.ca.usa');
    expect(aliasIdentifierField(l, 'external_id', 'CONTACT-7')).toBe('pii.Id1');
    expect(aliasIdentifierField(l, 'account_id', 'ACC-9')).toBe('pii.Account1');
    expect(aliasIdentifierField(l, 'email', 'a (at) b')).toBe('pii.Email1');

    expect(aliasIdentifierField(l, 'email', 'alice@acme.com')).toBe('m1@d1.invalid');
    expect(aliasIdentifierField(l, 'url', 'https://acme.com/portal?id=42'))
      .toBe('https://d1.invalid/portal?id=42');
    expect(scanContent(l, 'Visit acme.com').text).toBe('Visit d1.invalid');
  });

  it('generates a bare pii.Phone1 fallback for a non-E164 phone', () => {
    const l = createLedger('s206');

    expect(aliasIdentifierField(l, 'phone', '555')).toBe('pii.Phone1');
  });

  it('does not treat bare readable alias-shaped user literals as restore or idempotence surfaces', () => {
    const l = createLedger('s202');

    expect(aliasIdentifierField(l, 'name', 'Pat Lee')).toBe('pii.Person1');
    expect(scanContent(l, 'PAT LEE').text).toBe('cap_pii.Person1');
    expect(aliasIdentifierField(l, 'org', 'Acme')).toBe('pii.Org1');
    expect(aliasIdentifierField(l, 'phone', '+44-20-7946-0958')).toBe('pii.Phone1.gb');
    expect(aliasIdentifierField(l, 'address', '1 Main St, San Francisco, CA 94102, USA'))
      .toBe('pii.Address1.san-francisco.ca.usa');
    expect(aliasIdentifierField(l, 'url', 'not-a-url')).toBe('pii.Url1');
    expect(aliasIdentifierField(l, 'external_id', 'CONTACT-7')).toBe('pii.Id1');
    expect(aliasIdentifierField(l, 'account_id', 'ACC-9')).toBe('pii.Account1');
    expect(aliasIdentifierField(l, 'email', 'a (at) b')).toBe('pii.Email1');

    const bareForms = [
      'Person1',
      'Org1',
      'Phone1',
      'Phone1.gb',
      'Address1',
      'Url1',
      'Id1',
      'Account1',
      'Email1',
      'cap_Person1',
    ];
    for (const bare of bareForms) {
      expect(restoreInString(l, bare), bare).toBe(bare);
      expect(isAlreadyAliased(bare), bare).toBe(false);
    }

    // isAlreadyAliased (the idempotence guard) recognizes only the prefixed
    // Person/Org/Phone/Address surfaces (+ their cap_ siblings) — the subset the
    // entity-marker design can double-pass. RESTORE restores all 8 prefixed kinds
    // (see the round-trip test below); isAlreadyAliased deliberately does not.
    const guardedPrefixedForms = [
      'pii.Person1',
      'pii.Org1',
      'pii.Phone1',
      'pii.Phone1.gb',
      'pii.Address1',
      'cap_pii.Person1',
    ];
    for (const prefixed of guardedPrefixedForms) {
      expect(isAlreadyAliased(prefixed), prefixed).toBe(true);
    }

    // Url/Id/Account/Email stay excluded from the idempotence guard (never
    // double-passed) — false even in prefixed form. Their RAW values can look
    // like an id, so they were never recognized; the pii. prefix moots that but
    // they remain excluded as the no-op they always were.
    const unguardedPrefixedForms = ['pii.Url1', 'pii.Id1', 'pii.Account1', 'pii.Email1'];
    for (const prefixed of unguardedPrefixedForms) {
      expect(isAlreadyAliased(prefixed), prefixed).toBe(false);
    }
  });

  it('raw restore (no pre-scan) still maps a literal prefixed token — why Slice 3 pre-scans first', () => {
    const l = createLedger('s203');

    expect(aliasIdentifierField(l, 'name', 'Pat Lee')).toBe('pii.Person1');
    // restoreInString alone is shape-based: a literal `pii.Person1` maps to the
    // real value. That is WHY the egress seam runs `preScanReservePii` BEFORE the
    // packet ever reaches the model — see the Slice 3 block below, which escapes
    // such a literal so it round-trips to itself instead of colliding here.
    expect(restoreInString(l, 'pii.Person1')).toBe('Pat Lee');
  });

  it('round-trips emitted pii-prefixed aliases, casing siblings, suffix tolerance, and composites', () => {
    const l = createLedger('s204');

    expect(aliasIdentifierField(l, 'name', 'Alice Chen')).toBe('pii.Person1');
    expect(aliasIdentifierField(l, 'org', 'Acme')).toBe('pii.Org1');
    expect(scanContent(l, 'ACME').text).toBe('cap_pii.Org1');
    expect(aliasIdentifierField(l, 'phone', '+44-20-7946-0958')).toBe('pii.Phone1.gb');
    expect(aliasIdentifierField(l, 'address', '1 Main St, San Francisco, CA 94102, USA'))
      .toBe('pii.Address1.san-francisco.ca.usa');
    expect(aliasIdentifierField(l, 'url', 'not-a-url')).toBe('pii.Url1');
    expect(aliasIdentifierField(l, 'external_id', 'CONTACT-7')).toBe('pii.Id1');
    expect(aliasIdentifierField(l, 'account_id', 'ACC-9')).toBe('pii.Account1');
    expect(aliasIdentifierField(l, 'email', 'a (at) b')).toBe('pii.Email1');
    expect(aliasIdentifierField(l, 'email', 'alice@acme.com')).toBe('m1@d1.invalid');

    expect(restoreInString(
      l,
      'pii.Person1 / PII.PERSON1 / pii.person1 / pii.Org1 / cap_pii.Org1 / pii.Phone1.gb / pii.Phone1.us / pii.Phone1 / m1@d1.invalid / d1.invalid',
    )).toBe(
      'Alice Chen / Alice Chen / Alice Chen / Acme / ACME / +44-20-7946-0958 / +44-20-7946-0958 / +44-20-7946-0958 / alice@acme.com / acme.com',
    );
    expect(restoreInString(
      l,
      'pii.Address1 / pii.Url1 / pii.Id1 / pii.Account1 / pii.Email1',
    )).toBe(
      '1 Main St, San Francisco, CA 94102, USA / not-a-url / CONTACT-7 / ACC-9 / a (at) b',
    );
  });

  it('restores a mixed string by changing only emitted aliases and composites', () => {
    const l = createLedger('s205');

    expect(aliasIdentifierField(l, 'name', 'Pat Lee')).toBe('pii.Person1');
    expect(aliasIdentifierField(l, 'email', 'alice@acme.com')).toBe('m1@d1.invalid');

    const aliased = 'pii.Person1 handed Person1 the thread for m1@d1.invalid';
    const restored = 'Pat Lee handed Person1 the thread for alice@acme.com';
    expect(restoreInString(l, aliased)).toBe(restored);
    expect(restoreArgs(l, { note: aliased })).toEqual({ note: restored });
  });
});

describe('D-167 Slice 3 — pre-scan reserve/escape of user-typed pii.* literals', () => {
  it('RESERVE — a typed pii.Person1 (slot free) is left verbatim, restores to itself, and claims the slot', () => {
    const l = createLedger('s301');
    const { value, escaped } = preScanReservePii(l, 'note: call pii.Person1 later');
    expect(value).toBe('note: call pii.Person1 later'); // token unchanged
    expect(escaped).toBe(false);
    expect(restoreInString(l, value)).toBe('note: call pii.Person1 later'); // self-map
    // The reserved slot is claimed, so a real value is aliased PAST it.
    expect(aliasIdentifierField(l, 'name', 'Alice')).toBe('pii.Person2');
    expect(restoreInString(l, 'pii.Person1 and pii.Person2')).toBe('pii.Person1 and Alice');
  });

  it('ESCAPE (the headline residual fix) — a typed pii.Person1 colliding with a real alias is escaped, no leak', () => {
    const l = createLedger('s302');
    // Turn 1: a real value takes pii.Person1.
    expect(aliasIdentifierField(l, 'name', 'Pat Lee')).toBe('pii.Person1');
    // Turn 2: the user types the LITERAL pii.Person1 (e.g. anonymizing a friend).
    const { value, escaped } = preScanReservePii(l, "let's call pii.Person1 about it");
    expect(escaped).toBe(true);
    expect(value).toBe("let's call pii.Person2 about it"); // escaped to a fresh slot
    // Restore disambiguates: the escaped slot → the typed literal (NOT Pat Lee);
    // the real alias → Pat Lee. No corruption, no leak — the Slice 2 residual closed.
    expect(restoreInString(l, value)).toBe("let's call pii.Person1 about it");
    expect(restoreInString(l, 'pii.Person1 owns the deal')).toBe('Pat Lee owns the deal');
  });

  it('REUSE — the same reserved literal across two fields renders identically', () => {
    const l = createLedger('s303');
    const { value } = preScanReservePii(l, { a: 'pii.Person1 here', b: 'and pii.Person1 again' });
    expect(value).toEqual({ a: 'pii.Person1 here', b: 'and pii.Person1 again' });
    expect(restoreInString(l, 'pii.Person1')).toBe('pii.Person1');
  });

  it('REUSE — an escaped literal reuses the SAME fresh slot on a later occurrence (cross-turn)', () => {
    const l = createLedger('s304');
    aliasIdentifierField(l, 'name', 'Pat Lee'); // pii.Person1
    expect(preScanReservePii(l, 'pii.Person1').value).toBe('pii.Person2'); // escaped
    expect(preScanReservePii(l, 'again pii.Person1').value).toBe('again pii.Person2'); // SAME slot, not Person3
  });

  it('escapes cascade-free within one string when slots chain', () => {
    const l = createLedger('s305');
    aliasIdentifierField(l, 'name', 'Pat Lee'); // pii.Person1 occupied
    const { value } = preScanReservePii(l, 'pii.Person1 vs pii.Person2');
    // Person1 occupied → escape to Person2; the literal Person2 then sees Person2
    // (just claimed) → escape to Person3. Each escape claims its slot immediately.
    expect(value).toBe('pii.Person2 vs pii.Person3');
    expect(restoreInString(l, value)).toBe('pii.Person1 vs pii.Person2');
  });

  it('a reserved literal does not corrupt a real alias the content pass later emits', () => {
    const l = createLedger('s307');
    preScanReservePii(l, 'keep pii.Person1'); // reserve Person1 (NOT in byKindRealValue)
    expect(aliasIdentifierField(l, 'name', 'Alice')).toBe('pii.Person2'); // skip the reserved slot
    const scanned = scanContent(l, 'Alice met pii.Person1').text;
    expect(scanned).toBe('pii.Person2 met pii.Person1'); // Alice aliased; reserved literal untouched
    expect(restoreInString(l, scanned)).toBe('Alice met pii.Person1');
  });

  it('handles a suffixed phone literal — escape on the base, restore to the full typed literal', () => {
    const l = createLedger('s308');
    expect(aliasIdentifierField(l, 'phone', '+44-20-7946-0958')).toBe('pii.Phone1.gb');
    const { value, escaped } = preScanReservePii(l, 'ring pii.Phone1.gb now');
    expect(escaped).toBe(true);
    expect(value).toBe('ring pii.Phone2 now'); // base pii.Phone1 taken → escape
    expect(restoreInString(l, value)).toBe('ring pii.Phone1.gb now'); // back to the typed literal
    expect(restoreInString(l, 'pii.Phone1.gb')).toBe('+44-20-7946-0958'); // real phone still restores
  });

  it('reserves a typed literal of every readable kind (free slots)', () => {
    const literals = [
      'pii.Person1', 'pii.Org1', 'pii.Phone1', 'pii.Address1',
      'pii.Url1', 'pii.Id1', 'pii.Account1', 'pii.Email1',
    ];
    for (const lit of literals) {
      const l = createLedger('s309');
      const { value, escaped } = preScanReservePii(l, lit);
      expect(value, lit).toBe(lit);
      expect(escaped, lit).toBe(false);
      expect(restoreInString(l, lit), lit).toBe(lit);
    }
  });

  it('no pii.* token → deep-copy pass-through, escaped=false', () => {
    const l = createLedger('s310');
    const { value, escaped } = preScanReservePii(l, { msg: 'hello Alice at acme.com', n: 4 });
    expect(value).toEqual({ msg: 'hello Alice at acme.com', n: 4 });
    expect(escaped).toBe(false);
  });

  it('pre-scans a pii.*-shaped OBJECT KEY before key-aware egress authority is derived', () => {
    const l = createLedger('s311');
    aliasIdentifierField(l, 'name', 'Pat Lee'); // pii.Person1 occupied
    const { value, escaped } = preScanReservePii(l, { 'pii.Person1': 'real data' });
    expect(value).toEqual({ 'pii.Person2': 'real data' });
    expect(escaped).toBe(true);
    expect(restoreArgsAndKeys(l, value)).toEqual({ 'pii.Person1': 'real data' });
    expect(restoreInString(l, 'pii.Person1')).toBe('Pat Lee');
  });

  it('pre-scans an alias embedded after a machine-key separator', () => {
    const l = createLedger('s311a');
    aliasIdentifierField(l, 'name', 'Pat Lee'); // pii.Person1 occupied
    const { value, escaped } = preScanReservePii(l, {
      'owner_pii.Person1': 'real data',
    });
    expect(value).toEqual({ 'owner_pii.Person2': 'real data' });
    expect(escaped).toBe(true);
    expect(restoreArgKeys(l, value)).toEqual({
      'owner_pii.Person1': 'real data',
    });
    expect(restoreInString(l, 'pii.Person1')).toBe('Pat Lee');
  });

  it('key-only restore does not reprocess an already-restored escaped value', () => {
    const l = createLedger('s311b');
    aliasIdentifierField(l, 'name', 'Pat Lee'); // pii.Person1 occupied
    const { value } = preScanReservePii(l, {
      'pii.Person1': 'pii.Person1',
    });
    expect(value).toEqual({ 'pii.Person2': 'pii.Person2' });

    // The enclosing value pass has already turned Person2 back into the
    // user-authored Person1 literal. The subsequent key-only pass must restore
    // the key once while leaving that value untouched.
    expect(restoreArgKeys(l, { 'pii.Person2': 'pii.Person1' })).toEqual({
      'pii.Person1': 'pii.Person1',
    });
  });

  it('MIXED packet — occupied typed literal escapes while a free different kind reserves in place', () => {
    const l = createLedger('s312');
    expect(aliasIdentifierField(l, 'name', 'Alice')).toBe('pii.Person1');

    const { value, escaped } = preScanReservePii(l, {
      personLiteral: 'typed pii.Person1',
      orgLiteral: 'typed pii.Org1',
    });

    expect(escaped).toBe(true);
    expect(value).toEqual({
      personLiteral: 'typed pii.Person2',
      orgLiteral: 'typed pii.Org1',
    });
    expect(restoreInString(l, value.personLiteral)).toBe('typed pii.Person1');
    expect(restoreInString(l, value.orgLiteral)).toBe('typed pii.Org1');
    expect(restoreInString(l, 'pii.Person1')).toBe('Alice');
  });

  it('CROSS-TURN persistence — a free reserve is reused and real values skip it later', () => {
    const l = createLedger('s313');

    const first = preScanReservePii(l, 'pii.Person1');
    expect(first.value).toBe('pii.Person1');
    expect(first.escaped).toBe(false);

    expect(aliasIdentifierField(l, 'name', 'Bob')).toBe('pii.Person2');

    const second = preScanReservePii(l, 'pii.Person1');
    expect(second.value).toBe('pii.Person1'); // reuse the original self-map
    expect(second.escaped).toBe(false);
    expect(restoreInString(l, 'pii.Person1')).toBe('pii.Person1');
    expect(restoreInString(l, 'pii.Person2')).toBe('Bob');
  });

  it('RESERVE high slot — later real allocations skip the pre-claimed slot', () => {
    const l = createLedger('s314');
    const reserved = preScanReservePii(l, 'pii.Person5');
    expect(reserved.value).toBe('pii.Person5');
    expect(reserved.escaped).toBe(false);

    const aliases = ['Ada', 'Ben', 'Cora', 'Drew', 'Eve'].map(name =>
      aliasIdentifierField(l, 'name', name),
    );

    expect(aliases).toEqual([
      'pii.Person1',
      'pii.Person2',
      'pii.Person3',
      'pii.Person4',
      'pii.Person6',
    ]);
    expect(aliases).not.toContain('pii.Person5');
    expect(restoreInString(l, 'pii.Person5')).toBe('pii.Person5');
    expect(restoreInString(l, 'pii.Person6')).toBe('Eve');
  });

  it('does not re-restore an escaped token during the same restore pass', () => {
    const l = createLedger('s315');
    expect(aliasIdentifierField(l, 'name', 'Pat Lee')).toBe('pii.Person1');

    const { value, escaped } = preScanReservePii(l, 'typed pii.Person1');
    expect(escaped).toBe(true);
    expect(value).toBe('typed pii.Person2');

    // Person2 restores to the user's typed literal, and that literal is not
    // re-processed into Pat Lee during the same restoreInString call.
    expect(restoreInString(l, `${value}; real pii.Person1`))
      .toBe('typed pii.Person1; real Pat Lee');
  });

  it('case-MUTATED literal (pii.person1 / PII.PERSON1) is escaped and round-trips — no leak (CI pre-scan)', () => {
    const l = createLedger('s316');
    expect(aliasIdentifierField(l, 'name', 'Alice')).toBe('pii.Person1');

    // A user types the prefixed literal in NON-canonical case. The pre-scan is
    // case-insensitive (symmetric with restore), so it escapes the colliding slot
    // instead of letting restore un-alias the literal into Alice.
    const lower = preScanReservePii(l, 'note pii.person1 here');
    expect(lower.escaped).toBe(true);
    expect(lower.value).toBe('note pii.Person2 here'); // escaped to a fresh canonical slot
    expect(restoreInString(l, lower.value)).toBe('note pii.person1 here'); // exact typed casing
    expect(restoreInString(l, 'pii.Person1')).toBe('Alice'); // the real alias is untouched

    // Uppercase mutation likewise.
    const upper = preScanReservePii(l, 'or PII.PERSON1');
    expect(upper.escaped).toBe(true);
    expect(restoreInString(l, upper.value)).toBe('or PII.PERSON1');
  });

  it('a cap_ casing-sibling literal is escaped to a BARE slot and round-trips — no leak', () => {
    const l = createLedger('s316b');
    expect(aliasIdentifierField(l, 'org', 'Acme')).toBe('pii.Org1');
    expect(scanContent(l, 'ACME').text).toBe('cap_pii.Org1'); // a real casing sibling

    // A user types the sibling-shaped literal. The pre-scan ALWAYS escapes a cap_
    // literal to a fresh BARE slot (never reserves it under the cap_ base, which a
    // later allocSibling could clobber), so it round-trips instead of un-aliasing
    // into the sibling's real value.
    const cap = preScanReservePii(l, 'ping cap_pii.Org1 too');
    expect(cap.escaped).toBe(true);
    expect(cap.value).toBe('ping pii.Org2 too'); // escaped to a bare slot, past pii.Org1
    expect(restoreInString(l, cap.value)).toBe('ping cap_pii.Org1 too'); // back to the literal
    expect(restoreInString(l, 'cap_pii.Org1')).toBe('ACME'); // the real sibling is untouched
  });

  it('a PREFIX-case-mutated cap_/pii literal (CAP_PII.Org1) is fail-safe — restore cannot map it either', () => {
    const l = createLedger('s316c');
    expect(aliasIdentifierField(l, 'org', 'Acme')).toBe('pii.Org1');
    expect(scanContent(l, 'ACME').text).toBe('cap_pii.Org1');

    // The cap_/pii prefix canonicalization is case-sensitive in BOTH the pre-scan
    // and restore, so a mutated PREFIX (CAP_/PII.) is recognized by neither — it
    // passes through unchanged on both sides. Not handled, but NOT a leak.
    const out = preScanReservePii(l, 'CAP_PII.Org1');
    expect(out.value).toBe('CAP_PII.Org1');
    expect(out.escaped).toBe(false);
    expect(restoreInString(l, 'CAP_PII.Org1')).toBe('CAP_PII.Org1');
  });

  it('reserves a free email composite and domain so later real aliases skip both slots', () => {
    const l = createLedger('s317');
    const { value, escaped } = preScanReservePii(l, 'mail m1@d1.invalid via d1.invalid');

    expect(value).toBe('mail m1@d1.invalid via d1.invalid');
    expect(escaped).toBe(false);
    expect(restoreInString(l, value)).toBe(value);
    expect(aliasIdentifierField(l, 'email', 'alice@acme.com'))
      .toBe('m2@d2.invalid');
  });

  it('escapes colliding email and domain literals without restoring them into real PII', () => {
    const l = createLedger('s318');
    expect(aliasIdentifierField(l, 'email', 'alice@acme.com'))
      .toBe('m1@d1.invalid');

    const email = preScanReservePii(l, 'mail m1@d1.invalid');
    expect(email).toEqual({
      value: 'mail m2@d2.invalid',
      escaped: true,
    });
    expect(restoreInString(l, email.value)).toBe('mail m1@d1.invalid');

    const domain = preScanReservePii(l, 'visit d1.invalid');
    expect(domain).toEqual({
      value: 'visit d2.invalid',
      escaped: true,
    });
    expect(restoreInString(l, domain.value)).toBe('visit d1.invalid');
    expect(restoreInString(l, 'm1@d1.invalid')).toBe('alice@acme.com');
  });
});

describe('P1 — seed and replace consult ONE rule', () => {
  // ⛔ `scanContent` withholds an all-digit value from blind prose replacement
  // (`94043` is indistinguishable from an invoice number). The SEED half did
  // not consult that rule, so it allocated an alias the packet would never
  // carry — a P1 violation, contained one layer down by D-167 P3's per-request
  // restore authority. The outcome was safe; the named enforcement point did
  // no work. Both halves now derive from `isBlindReplaceableKnownValue`.
  const indexOf = (value: string, kind: 'name' | 'org' | 'address') =>
    buildKnownValueIndex([{ value, kind }]);

  it('allocates nothing for a value the content pass will refuse to replace', () => {
    const ledger = createLedger('p1');
    seedKnownValuesFromContent(ledger, 'invoice 94043 paid', indexOf('94043', 'address'));
    expect([...ledger.byKindRealValue.keys()]).toEqual([]);
    expect([...ledger.byKindBaseAlias.keys()]).toEqual([]);
  });

  it('leaves that value untouched end to end, and consumes no alias number', () => {
    const ledger = createLedger('p1');
    const out = aliasKnownValuesInContent(
      ledger, 'invoice 94043 paid', indexOf('94043', 'address'),
    );
    expect(out.text).toBe('invoice 94043 paid');
    // The next REAL address still takes Address1 — a withheld value must not
    // burn a slot the model then sees skipped.
    expect(aliasIdentifierField(ledger, 'address', '1 Main Street'))
      .toBe('pii.Address1');
  });

  it('still seeds and replaces a value the content pass WILL replace', () => {
    const ledger = createLedger('p1');
    const out = aliasKnownValuesInContent(
      ledger, 'ship to 1 Main Street today', indexOf('1 Main Street', 'address'),
    );
    expect(out.text).toBe('ship to pii.Address1 today');
    expect([...ledger.byKindRealValue.keys()]).toEqual(['address::1 Main Street']);
  });

  it('keeps the phone exemption — all-digit by construction, own matching logic', () => {
    const ledger = createLedger('p1');
    aliasIdentifierField(ledger, 'phone', '+14155550199');
    const out = scanContent(ledger, 'call 4155550199 now');
    expect(out.text).not.toContain('4155550199');
  });
});

describe('D-167 overlap-reveal — email composite (2026-07-30)', () => {
  /** The failure this closes, observed live: the model held the owner's own
   *  "Northwind Traders" AND a bare `m1@d1.invalid`, could not join them, and
   *  gave up — "it looks like the name and email were redacted". Name/org
   *  aliases had carried a disclosed-overlap tail since D-167; email composites
   *  were excluded, so the one coreference that mattered stayed severed. */
  const seeded = () => {
    const ledger = createLedger('email-overlap-reveal');
    const real = 'pat.lee@northwind-traders.com';
    const alias = aliasIdentifierField(ledger, 'email', real);
    return { ledger, real, alias };
  };

  it('puts the disclosed tail on the LOCAL part', () => {
    const { ledger, alias } = seeded();
    const out = decorateOverlapReveal(
      ledger, `Mail from ${alias}.`, tokenizeForOverlap('Northwind Traders'),
    );
    expect(out).toContain('m1.northwind.traders@d1.invalid');
  });

  it('⛔ keeps `.invalid` TERMINAL — the non-resolving guarantee', () => {
    // RFC 2606 reserves `.invalid` so an escaped alias can never resolve, and it
    // is the ONLY reason this family skips the `pii.` prefix. A trailing tail
    // (`d1.invalid.northwind`) would make the effective TLD the tail — and brand
    // gTLDs are real (`.bmw`, `.ford`), so an escaped alias could RESOLVE and a
    // send could actually deliver. This assertion is that property, not cosmetics.
    const { ledger, alias } = seeded();
    const out = decorateOverlapReveal(
      ledger, `Mail from ${alias}.`, tokenizeForOverlap('Northwind Traders'),
    );
    const token = out.match(/\S*invalid/)![0];
    expect(token.endsWith('.invalid')).toBe(true);
    expect(token).not.toMatch(/\.invalid\./);
  });

  it('⛔ ROUND-TRIPS — the hard zero-failure-restore invariant', () => {
    const { ledger, real, alias } = seeded();
    const decorated = decorateOverlapReveal(
      ledger, `Mail from ${alias} today.`, tokenizeForOverlap('Northwind Traders'),
    );
    const restored = restoreInString(ledger, decorated);
    expect(restored).toBe(`Mail from ${real} today.`);
    expect(restored).not.toContain('invalid');
  });

  it('stays recognisable to the kind resolver and the cheap literal gate', () => {
    // Five regexes encode the composite shape; a missed one fails SILENTLY —
    // the decorated alias stops being recognised and survives restore unchanged.
    const { ledger, alias } = seeded();
    const decorated = decorateOverlapReveal(
      ledger, alias, tokenizeForOverlap('Northwind Traders'),
    );
    expect(ledgerKindForAlias(decorated)).toBe('email_local');
    expect(containsPotentialPiiAliasLiteral(decorated)).toBe(true);
  });

  it('is idempotent, and reveals nothing when nothing was disclosed', () => {
    const { ledger, alias } = seeded();
    const disclosed = tokenizeForOverlap('Northwind Traders');
    const once = decorateOverlapReveal(ledger, alias, disclosed);
    expect(decorateOverlapReveal(ledger, once, disclosed)).toBe(once);
    // The permitting witness: an unrelated disclosure leaves the alias opaque,
    // so this cannot pass by decorating unconditionally.
    expect(decorateOverlapReveal(ledger, alias, tokenizeForOverlap('Globex')))
      .toBe(alias);
  });
});

describe('D-227 — an email whose local part renders a known name carries that person', () => {
  /** `m1@d1.invalid` says nothing about WHOSE address it is, and the counters do
   *  not even correlate: with two contacts, Alice can be `pii.Person1` while her
   *  address is `m2`. Where the local part RENDERS the name, the composite can
   *  say so — `pii.Person1@d1.invalid` — disclosing nothing the alias did not
   *  already carry, and making the person↔email link the design always claimed. */
  const seeded = () => {
    const ledger = createLedger('known-name-email');
    getOrAllocate(ledger, 'name', 'Sarah Chen');
    return ledger;
  };

  it('⛔ requires a MULTI-TOKEN name — a bare first name earns nothing', () => {
    // The Slice-2 prefix test caught this: it seeds the contact "Alice" and
    // expects `alice@acme.com` to stay `m1@d1.invalid`. A single common first
    // name could be anyone; a full name rendered as a local part could not.
    const ledger = createLedger('single-name-email');
    getOrAllocate(ledger, 'name', 'Alice');
    expect(aliasIdentifierField(ledger, 'email', 'alice@acme.com'))
      .toMatch(/^m\d+@d\d+\.invalid$/);
  });

  it('links the four renderings of the name, and nothing else', () => {
    for (const local of ['sarah.chen', 'sarah_chen', 'sarah-chen', 'sarahchen']) {
      expect(aliasIdentifierField(seeded(), 'email', `${local}@acme.com`))
        .toBe('pii.Person1@d1.invalid');
    }
    // ⛔ The permitting witness, and the reason the rule is narrow: these are
    // PROBABLY Sarah too, and "probably" asserted inside an alias is an invented
    // fact whose failure mode is addressing the wrong person.
    for (const local of ['sc', 'sarah.s', 'chen.sarah', 's.chen', 'sarah.chen2']) {
      expect(aliasIdentifierField(seeded(), 'email', `${local}@acme.com`))
        .toMatch(/^m\d+@d\d+\.invalid$/);
    }
  });

  it('⛔ mints the link ONCE — a second earner falls back, at ANY domain', () => {
    // `byKindBaseAlias` keys on the BASE alone, so two composites sharing
    // `pii.Person1` collapse to one row and restore returns whichever was
    // written last. A first cut scoped this per-DOMAIN and a round-trip probe
    // caught it: `sarah.chen@acme.com` restored to `sarah-chen@other.com`.
    const ledger = seeded();
    expect(aliasIdentifierField(ledger, 'email', 'sarah.chen@acme.com'))
      .toBe('pii.Person1@d1.invalid');
    expect(aliasIdentifierField(ledger, 'email', 'sarahchen@acme.com'))
      .toMatch(/^m\d+@d1\.invalid$/);
    expect(aliasIdentifierField(ledger, 'email', 'sarah-chen@other.com'))
      .toMatch(/^m\d+@d2\.invalid$/);
  });

  it('⛔ ROUND-TRIPS every form — the hard zero-failure-restore invariant', () => {
    const ledger = seeded();
    const reals = [
      'sarah.chen@acme.com', 'sc@acme.com', 'sarahchen@acme.com', 'sarah-chen@other.com',
    ];
    const aliased = reals.map((r) => aliasIdentifierField(ledger, 'email', r));
    expect(restoreInString(ledger, aliased.join(' | '))).toBe(reals.join(' | '));
  });

  it('⛔ types the composite by its `@`, never by the local part', () => {
    // `kindFromBase('pii.Person1')` answers `'name'`. Typing the composite by its
    // local half would resolve an EMAIL token to the NAME row and restore
    // "Sarah Chen" into a `mail.send(to:)`.
    expect(ledgerKindForAlias('pii.Person1@d1.invalid')).toBe('email_local');
    expect(ledgerKindForAlias('pii.Person1')).toBe('name');
    expect(ledgerKindForAlias('m1@d1.invalid')).toBe('email_local');
  });

  it('⛔ is RESTORABLE — the authority derivation must type it as an email too', () => {
    // ⛔⛔ THE BUG THIS PINS REACHED THE OWNER. `reverseKeyForAliasToken` is a
    // THIRD site that typed a composite by its LOCAL part, and it is the one
    // that decides whether an alias may be restored AT ALL:
    // `kindFromBase('pii.Person2')` answers 'name', so the person-linked
    // composite resolved to the NAME key, authority was granted for the name
    // instead of the email, and the token reached the user verbatim —
    // "loop in Sarah Chen (pii.Person2@d1.invalid)".
    //
    // ⚠ `restoreInString` round-tripped it perfectly in isolation, which is why
    // the unit tests were green. Only a bench task reading the USER-VISIBLE
    // output caught it. An alias that reaches the model but fails to restore is
    // worse than no aliasing at all.
    const ledger = createLedger('person-linked-email-restore');
    getOrAllocate(ledger, 'name', 'Theo Marsh');
    getOrAllocate(ledger, 'name', 'Sarah Chen');
    const theo = aliasIdentifierField(ledger, 'email', 'tm@northwind-bench.example');
    const sarah = aliasIdentifierField(ledger, 'email', 'sarah.chen@northwind-bench.example');
    expect(sarah).toBe('pii.Person2@d1.invalid');
    const authority = derivePiiRestoreAuthority(
      ledger, JSON.stringify({ prefetch: [theo, sarah] }),
    );
    // ⚠ signature is (authority, text) — the authority CARRIES its ledger, which
    // is the point: a restricted authority cannot reach rows it was not granted.
    expect(restoreInStringWithAuthority(authority, `loop in ${theo} and ${sarah}`))
      .toBe('loop in tm@northwind-bench.example and sarah.chen@northwind-bench.example');
  });

  it('keeps the domain half shared, so "same company" survives', () => {
    const ledger = seeded();
    getOrAllocate(ledger, 'name', 'Dana Okonkwo');
    const a = aliasIdentifierField(ledger, 'email', 'sarah.chen@acme.com');
    const b = aliasIdentifierField(ledger, 'email', 'dana.okonkwo@acme.com');
    expect(a.split('@')[1]).toBe(b.split('@')[1]);
  });
});
