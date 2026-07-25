/** D-167 P1 - aliasFields tests for spec §"Runtime flow" and §"Alias vocabulary". */

import type { PiiFieldTag } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import {
  addressMatchForms,
  aliasFields,
  createCounters,
  createLedger,
  PII_UNALIASABLE,
  restoreArgs,
  restoreInString,
  summarizeRedactions,
} from '../pii-alias.js';

describe('aliasFields - identifier vocabulary', () => {
  it('aliases every identifier kind to the D-167 vocabulary shape', () => {
    const ledger = createLedger('s1');
    const counters = createCounters();
    const packet = {
      email: 'alice@acme.com',
      name: 'Alice Chen',
      org: 'Acme',
      phone_gb: '+44-20-7946-0958',
      phone_bad: 'office extension 42',
      address_us: '1 Main St, San Francisco, CA 94102, USA',
      address_bad: '東京都新宿区西新宿2-8-1',
      url: 'https://acme.com/about',
      url_bad: 'not-a-url',
      external_id: 'ext-42',
      account_id: 'acct-9',
    };

    const aliased = aliasFields(ledger, packet, [
      { path: 'email', kind: 'email' },
      { path: 'name', kind: 'name' },
      { path: 'org', kind: 'org' },
      { path: 'phone_gb', kind: 'phone' },
      { path: 'phone_bad', kind: 'phone' },
      { path: 'address_us', kind: 'address' },
      { path: 'address_bad', kind: 'address' },
      { path: 'url', kind: 'url' },
      { path: 'url_bad', kind: 'url' },
      { path: 'external_id', kind: 'external_id' },
      { path: 'account_id', kind: 'account_id' },
    ], counters);

    expect(aliased).toEqual({
      email: 'm1@d1.invalid',
      name: 'pii.Person1',
      org: 'pii.Org1',
      phone_gb: 'pii.Phone1.gb',
      phone_bad: 'pii.Phone2',
      address_us: 'pii.Address1.san-francisco.ca.usa',
      address_bad: 'pii.Address2',
      url: 'https://d1.invalid/about',
      url_bad: 'pii.Url1',
      external_id: 'pii.Id1',
      account_id: 'pii.Account1',
    });
    expect(summarizeRedactions(counters)).toEqual({
      email: 1,
      name: 1,
      org: 1,
      phone: 2,
      address: 2,
      url: 2,
      external_id: 1,
      account_id: 1,
    });
  });

  it('uses bare parse-fail aliases for isolated phone, address, and url values', () => {
    expect(aliasFields(
      createLedger('phone'),
      { phone: '555-0123' },
      [{ path: 'phone', kind: 'phone' }],
    )).toEqual({ phone: 'pii.Phone1' });
    expect(aliasFields(
      createLedger('address'),
      { address: 'somewhere in nowhere' },
      [{ path: 'address', kind: 'address' }],
    )).toEqual({ address: 'pii.Address1' });
    expect(aliasFields(
      createLedger('url'),
      { url: 'not-a-url' },
      [{ path: 'url', kind: 'url' }],
    )).toEqual({ url: 'pii.Url1' });
  });
});

describe('aliasFields - ordered content pass', () => {
  it('aliases identifiers before content even when the content field is listed first', () => {
    const ledger = createLedger('s1');
    const counters = createCounters();
    const packet = {
      owner_email: 'alice@acme.com',
      owner_name: 'Alice Chen',
      company_name: 'Acme',
      notes: 'Alice Chen confirmed renewal; Acme will sign by Friday. CC bob@acme.com on the contract email and ping acme.com/portal for the renewal page.',
    };

    const aliased = aliasFields(ledger, packet, [
      { path: 'notes', kind: 'content' },
      { path: 'owner_email', kind: 'email' },
      { path: 'owner_name', kind: 'name' },
      { path: 'company_name', kind: 'org' },
    ], counters);

    expect(aliased).toEqual({
      owner_email: 'm1@d1.invalid',
      owner_name: 'pii.Person1',
      company_name: 'pii.Org1',
      notes: 'pii.Person1 confirmed renewal; pii.Org1 will sign by Friday. CC m2@d1.invalid on the contract email and ping d1.invalid/portal for the renewal page.',
    });
    expect(summarizeRedactions(counters)).toEqual({
      email: 1,
      name: 1,
      org: 1,
      content_text_replacements: 4,
    });
  });

  it('completes emails at an aliased domain and restores casing siblings', () => {
    const ledger = createLedger('s1');
    const counters = createCounters();
    const packet = {
      owner_email: 'alice@acme.com',
      company_name: 'Acme',
      notes: 'CC bob@acme.com; ACME legal approved.',
    };

    const aliased = aliasFields(ledger, packet, [
      { path: 'owner_email', kind: 'email' },
      { path: 'company_name', kind: 'org' },
      { path: 'notes', kind: 'content' },
    ], counters) as typeof packet;

    expect(aliased.notes).toBe('CC m2@d1.invalid; cap_pii.Org1 legal approved.');
    expect(restoreInString(ledger, aliased.notes)).toBe('CC bob@acme.com; ACME legal approved.');
    expect(summarizeRedactions(counters)).toEqual({
      email: 1,
      org: 1,
      content_text_replacements: 2,
    });
  });
});

describe('aliasFields - structured path behavior', () => {
  it('reuses the same alias for the same kind and value across fields in one call', () => {
    const ledger = createLedger('s1');
    const packet = {
      primary_name: 'Alice Chen',
      secondary_name: 'Alice Chen',
      primary_email: 'alice@acme.com',
      secondary_email: 'Alice@Acme.com',
    };

    const aliased = aliasFields(ledger, packet, [
      { path: 'primary_name', kind: 'name' },
      { path: 'secondary_name', kind: 'name' },
      { path: 'primary_email', kind: 'email' },
      { path: 'secondary_email', kind: 'email' },
    ]);

    expect(aliased).toEqual({
      primary_name: 'pii.Person1',
      secondary_name: 'pii.Person1',
      primary_email: 'm1@d1.invalid',
      secondary_email: 'm1@d1.invalid',
    });
  });

  it('returns a deep copy and leaves the input byte-for-byte unchanged', () => {
    const ledger = createLedger('s1');
    const packet = {
      owner: { email: 'alice@acme.com', name: 'Alice Chen' },
      contacts: [{ email: 'bob@acme.com' }],
      untouched: { ok: true },
    };
    const before = structuredClone(packet);
    const beforeJson = JSON.stringify(packet);

    const aliased = aliasFields(ledger, packet, [
      { path: 'owner.email', kind: 'email' },
      { path: 'owner.name', kind: 'name' },
      { path: 'contacts.0.email', kind: 'email' },
    ]) as typeof packet;

    expect(packet).toEqual(before);
    expect(JSON.stringify(packet)).toBe(beforeJson);
    expect(aliased).not.toBe(packet);
    expect(aliased.owner).not.toBe(packet.owner);
    expect(aliased.contacts).not.toBe(packet.contacts);
    expect(aliased).toEqual({
      owner: { email: 'm1@d1.invalid', name: 'pii.Person1' },
      contacts: [{ email: 'm2@d1.invalid' }],
      untouched: { ok: true },
    });
  });

  it('handles nested paths, array-index paths, absent paths, and NUMERIC values', () => {
    // ⚠ REVERSED (2026-07-12): this used to assert `{ email: 7 }` came through UNTOUCHED —
    // i.e. a PRESENT value at a tagged path passed through RAW because it was not a string.
    // That is the exact pattern that let every mail recipient egress (`to`/`cc` are ARRAYS).
    // The substrate cannot tell `email: 7` (garbage) from `phone: 4155550143` (a real phone a
    // JSON API returned as a number) — and a tag is a PROMISE the field is protected. So a
    // present numeric value is now aliased via its string form. An ABSENT path is still a
    // no-op: there is genuinely nothing to protect.
    const ledger = createLedger('s1');
    const packet = {
      owner: { email: 'alice@acme.com' },
      contacts: [{ email: 'bob@acme.com' }, { email: 7 }],
    };

    const aliased = aliasFields(ledger, packet, [
      { path: 'owner.email', kind: 'email' },
      { path: 'contacts.0.email', kind: 'email' },
      { path: 'contacts.1.email', kind: 'email' },
      { path: 'contacts.2.email', kind: 'email' },
      { path: 'missing.email', kind: 'email' },
    ]);

    expect(aliased).toEqual({
      owner: { email: 'm1@d1.invalid' },
      contacts: [{ email: 'm2@d1.invalid' }, { email: 'pii.Email1' }],
    });
  });

  it('aliases a PHONE a vendor returned as a NUMBER (this used to egress raw)', () => {
    const ledger = createLedger('s1');
    const aliased = aliasFields(ledger, { phone: 4155550143 }, [
      { path: 'phone', kind: 'phone' },
    ]) as Record<string, unknown>;
    expect(aliased.phone).toBe('pii.Phone1');
    expect(JSON.stringify(aliased)).not.toContain('4155550143');
  });

  it('treats prototype-pollution paths as no-ops', () => {
    const ledger = createLedger('s1');
    const packet = { safe: 'Alice Chen' };
    const fields: PiiFieldTag[] = [
      { path: '__proto__.polluted', kind: 'name' },
      { path: 'constructor.x', kind: 'name' },
      { path: 'safe', kind: 'name' },
    ];

    const aliased = aliasFields(ledger, packet, fields);

    expect(aliased).toEqual({ safe: 'pii.Person1' });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('aliasFields - counters', () => {
  it('accumulates per-kind counts and summarizeRedactions omits zero kinds', () => {
    const ledger = createLedger('s1');
    const counters = createCounters();
    const packet = {
      email: 'alice@acme.com',
      name: 'Alice Chen',
      org: 'Acme',
      phone: '+44-20-7946-0958',
      address: '1 Main St, San Francisco, CA 94102, USA',
      url: 'https://acme.com/about',
      external_id: 'ext-42',
      account_id: 'acct-9',
      notes: 'Alice Chen from Acme',
    };

    aliasFields(ledger, packet, [
      { path: 'email', kind: 'email' },
      { path: 'name', kind: 'name' },
      { path: 'org', kind: 'org' },
      { path: 'phone', kind: 'phone' },
      { path: 'address', kind: 'address' },
      { path: 'url', kind: 'url' },
      { path: 'external_id', kind: 'external_id' },
      { path: 'account_id', kind: 'account_id' },
      { path: 'notes', kind: 'content' },
    ], counters);

    expect(summarizeRedactions(counters)).toEqual({
      email: 1,
      name: 1,
      org: 1,
      phone: 1,
      address: 1,
      url: 1,
      external_id: 1,
      account_id: 1,
      content_text_replacements: 2,
    });
    expect(summarizeRedactions(createCounters())).toEqual({});
    expect(summarizeRedactions(counters)).not.toHaveProperty('domain');
    expect(summarizeRedactions(counters)).not.toHaveProperty('email_local');
  });
});

/** A tagged leaf can legitimately be a STRING ARRAY — a recipient list.
 *
 *  THE LEAK THIS PINS: `MAIL_SCHEMA` tags `to` / `cc` (address ARRAYS) `privacy: 'email'`,
 *  and the CRM engagement entities tag `to_emails` / `cc_emails` / `attendee_emails` the
 *  same way. Both passes used to bail on anything that was not a bare string
 *  (`typeof value !== 'string'`), which SILENTLY DROPPED every one of them: a mail tool
 *  result aliased `from` and then sent every RECIPIENT's address to the cloud LLM in the
 *  clear. The schema author had done nothing wrong — the substrate ignored the tag. */
describe('aliasFields - string ARRAY leaves (recipient lists)', () => {
  const FIELDS: PiiFieldTag[] = [
    { path: 'from', kind: 'email' },
    { path: 'to', kind: 'email' },
    { path: 'cc', kind: 'email' },
    { path: 'attendees', kind: 'email' },
    { path: 'subject', kind: 'content' },
  ];

  it('aliases every element of a tagged email array', () => {
    const ledger = createLedger('s1');
    const aliased = aliasFields(ledger, {
      from: 'ilana@northwind.example',
      to: ['bruno@beta.example', 'cara@gamma.example'],
      cc: ['dev@delta.example'],
      subject: 'renewal',
    }, FIELDS) as Record<string, unknown>;

    expect(aliased.from).toBe('m1@d1.invalid');
    expect(aliased.to).toEqual(['m2@d2.invalid', 'm3@d3.invalid']);
    expect(aliased.cc).toEqual(['m4@d4.invalid']);
    expect(JSON.stringify(aliased)).not.toContain('beta.example');
  });

  it('gives a recipient who is ALSO the sender the SAME alias (one shared ledger)', () => {
    const ledger = createLedger('s1');
    const aliased = aliasFields(ledger, {
      from: 'ilana@northwind.example',
      to: ['ilana@northwind.example', 'bruno@beta.example'],
    }, FIELDS) as Record<string, unknown>;

    const [first] = aliased.to as string[];
    expect(first).toBe(aliased.from); // same real value → same alias
  });

  it('RESTORES an aliased recipient (the hard invariant holds through an array)', () => {
    const ledger = createLedger('s1');
    aliasFields(ledger, {
      to: ['bruno@beta.example'],
    }, FIELDS);
    expect(restoreInString(ledger, 'reply to m1@d1.invalid')).toBe(
      'reply to bruno@beta.example',
    );
  });

  it('protects EVERY present element — nothing falls through raw', () => {
    // Total by construction: a string aliases, a number aliases via its string form, an
    // unaliasable object fail-closed REDACTS, and only null (genuinely absent) passes.
    const ledger = createLedger('s1');
    const aliased = aliasFields(ledger, {
      to: ['bruno@beta.example', 4155550143, null, { nested: 'x' }],
    }, FIELDS) as Record<string, unknown>;
    expect(aliased.to).toEqual([
      'm1@d1.invalid',
      'pii.Email1',
      null,
      PII_UNALIASABLE,
    ]);
    expect(JSON.stringify(aliased)).not.toContain('4155550143');
  });

  it('content-scans a tagged array of free-text lines against the seeded ledger', () => {
    const ledger = createLedger('s1');
    const aliased = aliasFields(ledger, {
      from: 'ilana@northwind.example',
      subject: ['ping ilana@northwind.example', 'no pii here'],
    }, FIELDS) as Record<string, unknown>;
    // `content` is scan-only: it replaces the ALREADY-seeded sender, seeds nothing new.
    expect(aliased.subject).toEqual(['ping m1@d1.invalid', 'no pii here']);
  });

  it('an EMPTY array is a no-op (no counter churn)', () => {
    const ledger = createLedger('s1');
    const counters = createCounters();
    const aliased = aliasFields(ledger, { to: [] }, FIELDS, counters) as Record<string, unknown>;
    expect(aliased.to).toEqual([]);
    expect(summarizeRedactions(counters)).toEqual({});
  });
});

/** THE DURABLE GUARD: a `privacy` tag is a PROMISE the field is protected. If a pass cannot
 *  handle the value's SHAPE it must handle it or fail LOUD — never `continue`. A silent skip
 *  is indistinguishable from "nothing to do": nothing throws, nothing logs, no test goes red,
 *  and the real value simply egresses. That is precisely how `MAIL_SCHEMA`'s ARRAY-valued
 *  `to` / `cc` sent every mail recipient's address to the cloud LLM in the clear. */
describe('aliasFields - no present value falls through raw (fail-closed on an unhandled shape)', () => {
  it('an UNINTERPRETABLE object at an identifier path is REDACTED, not passed through', () => {
    const ledger = createLedger('s1');
    const aliased = aliasFields(ledger, {
      who: { local: 'alice', host: 'acme.com' },
    }, [{ path: 'who', kind: 'email' }]) as Record<string, unknown>;

    // We cannot know WHICH leaf carries the identifier, so it does not go out at all.
    // (A STRUCTURED ADDRESS is the ONE shape we CAN interpret — it composes instead of
    // failing closed; see the "structured address composes" suite below.)
    expect(aliased.who).toBe(PII_UNALIASABLE);
    expect(JSON.stringify(aliased)).not.toContain('acme.com');
  });

  it('the FIX for an object is to tag its dotted sub-paths (what the shipped schemas do)', () => {
    const ledger = createLedger('s1');
    const aliased = aliasFields(ledger, {
      mailing_address: { address1: '1600 Amphitheatre Parkway', city: 'Mountain View' },
    }, [{ path: 'mailing_address.address1', kind: 'address' }]) as {
      mailing_address: Record<string, unknown>;
    };
    expect(aliased.mailing_address.address1).not.toContain('Amphitheatre');
    // The coarse city stays visible — the accepted D-167 comfort tradeoff.
    expect(aliased.mailing_address.city).toBe('Mountain View');
  });

  it('an ABSENT or null path is still a clean no-op (nothing to protect)', () => {
    const ledger = createLedger('s1');
    const packet = { present: 'alice@acme.com', explicit_null: null };
    const aliased = aliasFields(ledger, packet, [
      { path: 'present', kind: 'email' },
      { path: 'explicit_null', kind: 'email' },
      { path: 'missing.deep.path', kind: 'email' },
    ]) as Record<string, unknown>;
    expect(aliased.present).toBe('m1@d1.invalid');
    expect(aliased.explicit_null).toBeNull();
    expect(aliased).not.toHaveProperty('missing');
  });

  it('a CONTENT tag deep-walks any shape (scan-only, so recursing cannot over-alias)', () => {
    const ledger = createLedger('s1');
    const aliased = aliasFields(ledger, {
      from: 'ilana@northwind.example',
      body: {
        lines: ['ping ilana@northwind.example', 'nothing here'],
        footer: { note: 'cc ilana@northwind.example' },
      },
    }, [
      { path: 'from', kind: 'email' },
      { path: 'body', kind: 'content' },
    ]) as Record<string, unknown>;

    // Every string leaf, at any depth, is scanned against the already-seeded ledger.
    expect(aliased.body).toEqual({
      lines: ['ping m1@d1.invalid', 'nothing here'],
      footer: { note: 'cc m1@d1.invalid' },
    });
    // Content NEVER seeds — an unknown value inside a content blob is not aliased into
    // existence, so there is no over-alias risk in recursing.
    expect(JSON.stringify(aliased)).not.toContain('ilana@northwind.example');
  });
});

/** A bare ALL-DIGIT value is too ambiguous to blind-replace in prose.
 *
 *  THE DEFECT THIS PINS (owner-predicted, then measured): `mailing_address.zip` is tagged
 *  `address` in the shipped HubSpot/Salesforce schemas, which seeds `94043` into the ledger —
 *  after which the CONTENT pass replaced `94043` ANYWHERE. `invoice 94043 paid` became
 *  `invoice pii.Address1 paid`. That is worse than mangling a number: the invoice and the
 *  contact's postcode end up sharing ONE alias, so the model concludes they are the SAME
 *  THING. A false identity is worse than a redaction.
 *
 *  The predicate is ALL-DIGITS, not length — because UK (`SW1A 1AA`) and Canadian
 *  (`K1A 0B1`) postcodes are ALPHANUMERIC and therefore distinctive: any bare occurrence of
 *  them really is the postcode, so they must keep scanning. Only the all-digit formats
 *  (US / DE / FR / …) are ambiguous. */
describe('scanContent - a bare all-digit value is not blind-replaced in prose', () => {
  const aliasZip = (zip: string, notes: string) => {
    const ledger = createLedger('s1');
    const out = aliasFields(ledger, { zip, notes }, [
      { path: 'zip', kind: 'address' },
      { path: 'notes', kind: 'content' },
    ]) as Record<string, string>;
    return { ledger, out };
  };

  it('a US zip is aliased at its FIELD but does not corrupt an invoice number', () => {
    const { out } = aliasZip('94043', 'invoice 94043 paid; posted to 94043');
    expect(out.zip).toBe('pii.Address1');            // the record IS protected
    expect(out.notes).toBe('invoice 94043 paid; posted to 94043'); // prose is NOT corrupted
  });

  it('a German zip likewise', () => {
    const { out } = aliasZip('10115', 'order 10115 shipped');
    expect(out.zip).toBe('pii.Address1');
    expect(out.notes).toBe('order 10115 shipped');
  });

  it('a UK postcode IS still scanned (alphanumeric ⇒ distinctive ⇒ unambiguous)', () => {
    const { out } = aliasZip('SW1A 1AA', 'lives at SW1A 1AA');
    expect(out.zip).toBe('pii.Address1');
    expect(out.notes).toBe('lives at pii.Address1');
  });

  it('a Canadian postcode IS still scanned', () => {
    const { out } = aliasZip('K1A 0B1', 'lives at K1A 0B1');
    expect(out.zip).toBe('pii.Address1');
    expect(out.notes).toBe('lives at pii.Address1');
  });

  it('RESTORE still round-trips the withheld zip (the field alias is a real ledger row)', () => {
    const { ledger, out } = aliasZip('94043', 'no zip here');
    expect(restoreInString(ledger, `mail it to ${out.zip}`)).toBe('mail it to 94043');
  });

  it('⚠ PHONE is EXEMPT — its national forms are all-digit BY CONSTRUCTION', () => {
    // The phone variant rows (`4155550143`, trunk-`0` forms) are all-digit on purpose, and a
    // ≥7-digit floor is what bounds them. Applying the digit guard to `phone` would silently
    // break known-phone matching in prose — exactly the regression class this file guards.
    const ledger = createLedger('s1');
    const out = aliasFields(ledger, {
      phone: '+14155550143',
      notes: 'reach her on (415) 555-0143 or 4155550143',
    }, [
      { path: 'phone', kind: 'phone' },
      { path: 'notes', kind: 'content' },
    ]) as Record<string, string>;

    expect(out.phone).toBe('pii.Phone1.us');
    expect(out.notes).not.toContain('4155550143');
    expect(out.notes).not.toContain('555-0143');
  });
});

/** A STRUCTURED address composes: the ledger learns the postcode's NEIGHBOURS.
 *
 *  THE OWNER'S DESIGN — the email/domain trick applied to the postcode. Aliasing
 *  `alice@acme.com` teaches the ledger the DOMAIN, which then anchors a composite match
 *  (`<anything>@acme.com`). A postcode has the same problem and the same solution: `94043`
 *  cannot be matched alone (it is indistinguishable from an invoice number, so `scanContent`
 *  withholds every all-digit value) — but the record hands us the WHOLE address, so we know
 *  its neighbours. A postcode is virtually always written next to its city and/or state with
 *  optional commas, so we look for those COMBINATIONS. `Mountain View, CA 94043` matches;
 *  `invoice 94043` cannot, because the bare postcode is deliberately never a form.
 *
 *  And it does NOT break the structure — the objection that killed the naive
 *  "collapse the object into one alias" idea. Each leaf keeps its own alias and restores to
 *  its own value; the composite rows are ledger-only and are never written into a field. */
describe('aliasFields - structured address composes (postcode gets its neighbours)', () => {
  const ADDR = {
    address1: '1600 Amphitheatre Parkway',
    city: 'Mountain View',
    state: 'CA',
    zip: '94043',
    country: 'USA',
  };

  it('never emits a lone postcode as a match form', () => {
    const forms = addressMatchForms({ city: 'Mountain View', state: 'CA', postal: '94043' });
    expect(forms).toContain('Mountain View, CA 94043');
    expect(forms).toContain('Mountain View CA 94043');
    expect(forms).toContain('CA 94043');
    // THE INVARIANT: the bare postcode is never a form, so `invoice 94043` can never hit.
    expect(forms).not.toContain('94043');
    for (const f of forms) expect(f).not.toMatch(/^\d+$/);
  });

  it('a postcode with NO neighbours yields no forms at all (nothing to anchor on)', () => {
    expect(addressMatchForms({ postal: '94043' })).toEqual([]);
    expect(addressMatchForms({ city: 'Mountain View' })).toEqual([]); // postal-bearing only
  });

  it('aliases the address in PROSE via its neighbours, and leaves an invoice number alone', () => {
    const ledger = createLedger('s1');
    const out = aliasFields(ledger, {
      mailing_address: ADDR,
      notes: 'met at 1600 Amphitheatre Parkway, Mountain View, CA 94043 — invoice 94043 paid',
    }, [
      { path: 'mailing_address', kind: 'address' },
      { path: 'notes', kind: 'content' },
    ]) as Record<string, string>;

    // The address run is gone from the prose…
    expect(out.notes).not.toContain('94043 —');
    expect(out.notes).not.toContain('Mountain View, CA 94043');
    expect(out.notes).not.toContain('1600 Amphitheatre Parkway');
    // …but the INVOICE number survives untouched — the bare postcode is never a form.
    expect(out.notes).toContain('invoice 94043 paid');
    // …and the region grain survives in the geo suffix (open-question #9).
    expect(out.notes).toMatch(/pii\.Address\d+\.mountain-view\.ca/);
  });

  it('STRUCTURE IS PRESERVED and the whole packet round-trips EXACTLY', () => {
    const ledger = createLedger('s1');
    const packet = {
      mailing_address: ADDR,
      notes: 'met at 1600 Amphitheatre Parkway, Mountain View, CA 94043; also Mountain View CA 94043',
    };
    const aliased = aliasFields(ledger, packet, [
      { path: 'mailing_address', kind: 'address' },
      { path: 'notes', kind: 'content' },
    ]) as typeof packet;

    // The object is STILL an object — it did not collapse into one `address1` string.
    expect(Object.keys(aliased.mailing_address)).toEqual(Object.keys(ADDR));
    // Coarse leaves stay visible; strong leaves are aliased.
    expect(aliased.mailing_address.city).toBe('Mountain View');
    expect(aliased.mailing_address.state).toBe('CA');
    expect(aliased.mailing_address.country).toBe('USA');
    expect(aliased.mailing_address.address1).not.toContain('Amphitheatre');
    expect(aliased.mailing_address.zip).not.toBe('94043');

    // THE HARD INVARIANT: every leaf, and every prose layout, restores to EXACTLY what it was.
    expect(restoreArgs(ledger, aliased)).toEqual(packet);
  });

  it('KNOWN LIMITATION (not a gap): `CA` does not match prose that writes `California`', () => {
    // Owner-ratified, 2026-07-12. Forms are matched LITERALLY, so an abbreviation written out
    // long-hand matches nothing and the postcode stays raw there. Same class for street
    // abbreviations (`Parkway` vs `Pkwy`). This is DELIBERATE: expanding abbreviations means a
    // synonym table per country, and every synonym is another chance to OVER-match — and this
    // file's whole history is that over-aliasing (corruption, false identity) costs more than
    // a miss. D-167: "aliasing may MISS; the HARD invariant is RESTORE." A missed postcode is
    // a miss. Do not file it as a defect; do not add a synonym table without an owner call.
    const ledger = createLedger('s1');
    const out = aliasFields(ledger, {
      mailing_address: { address1: '1 Main St', city: 'Mountain View', state: 'CA', zip: '94043' },
      notes: 'lives in Mountain View, California 94043',
    }, [
      { path: 'mailing_address', kind: 'address' },
      { path: 'notes', kind: 'content' },
    ]) as Record<string, string>;

    // The abbreviated form is what the ledger holds, so the spelled-out prose does NOT match.
    expect(out.notes).toBe('lives in Mountain View, California 94043');
    // …and the record itself is still protected, which is what actually matters.
    expect(out.mailing_address).not.toHaveProperty('zip', '94043');
  });

  it('an object at an address path that is NOT an address still fails closed', () => {
    const ledger = createLedger('s1');
    const out = aliasFields(ledger, { blob: { foo: 'bar' } }, [
      { path: 'blob', kind: 'address' },
    ]) as Record<string, unknown>;
    expect(out.blob).toBe(PII_UNALIASABLE);
  });
});
