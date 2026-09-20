/** ⛔⛔ A VENDOR ADDRESS LIST BECAME A `data.contact` KEY WITHOUT EVER BEING
 *  PARSED AS AN ADDRESS.
 *
 *  `parseEmailList` was `raw.split(/[;,\n]/)` + `trim().toLowerCase()` + an `@`
 *  check, in two byte-identical copies (HubSpot + Salesforce). Its output goes
 *  straight into `engagement_edges.target_id` with `target_kind:
 *  'data.contact'` (`email-engagement-reconciler.ts:254`), and
 *  `record-projections.ts:55` reads those rows back as contact emails for
 *  `account_engagement_breadth`.
 *
 *  So `hs_email_to_email: "Bob Smith <bob@x.com>"` wrote the contact key
 *  `bob smith <bob@x.com>` — which matches no contact row, because contacts are
 *  keyed by `canonicalizeEmail`. The same person then counts TWICE toward
 *  account breadth: once under their real address from another engagement, once
 *  under the mangled one. `EngagementStore` states the invariant that broke:
 *  *"Emails are raw-stored (already D-138-canonical at edge-write time)"*.
 *
 *  🔑 THE PROPERTY THAT CATCHES IT IN ONE LINE: every element of the list must
 *  be a FIXED POINT of `canonicalizeEmail`, because that is what a contact key
 *  is. `canonicalizeEmail('bob smith <bob@x.com>')` returns the same mangled
 *  string, so the value is stable but WRONG — which is why an equality check
 *  against a hand-written expectation could pass while the join failed. The
 *  fixed-point test needs no expectation written by the same person who wrote
 *  the parser.
 *
 *  ⛔ AND DO NOT "CONSOLIDATE" THE CONTACT RECONCILERS INTO THIS. Their
 *  `canonicalizeEmail` / `canonicalizeContactEmail` stay a bare lowercase+trim
 *  ON PURPOSE, and the Salesforce copy says why: *"SOQL returns plain email
 *  strings (no `Bob <bob@x.com>` envelope shape that mail headers carry)"*. A
 *  typed `Email` field on a Contact SObject is not header text. Those values are
 *  the CRM CONTACT IDENTITY KEY, so changing how they canonicalize would re-key
 *  stored rows — a migration, not a fix. The bug was the bare form being copied
 *  from the typed field, where it is right, to `ToAddress` / `hs_email_to_email`,
 *  where the value IS an RFC 5322 address list.
 *
 *  ⚠ EVERY EXISTING TEST USED A BARE ADDRESS. `'Foo@bar.com; baz@qux.io ,
 *  extra@example.org'`, `'sales@acme.com; cc-rep@acme.com'`, `'c@d.com'`,
 *  `'buyer@acme.com'` — not one display name across four reconcilers, which is
 *  exactly the shape where a default fixture never renders the failing case. */

import { describe, expect, it } from 'vitest';
import { canonicalizeEmail, parseAddressListEmails } from '@recued/contracts';
import { parseEmailList as hubspotParseEmailList } from '../data/hubspot/engagement-shared.js';
import { parseEmailList as salesforceParseEmailList } from '../data/salesforce/engagement-shared.js';

/** Forms a CRM actually stores in a flat address column. */
const CASES: ReadonlyArray<{ raw: string; emails: readonly string[]; why: string }> = [
  { raw: 'bob@x.com;jane@y.com', emails: ['bob@x.com', 'jane@y.com'], why: 'semicolon list' },
  {
    raw: 'Foo@bar.com; baz@qux.io , extra@example.org',
    emails: ['foo@bar.com', 'baz@qux.io', 'extra@example.org'],
    why: 'the pre-existing expectation — must not change',
  },
  { raw: 'Bob Smith <bob@x.com>', emails: ['bob@x.com'], why: 'THE BUG — display name' },
  { raw: '<bob@x.com>', emails: ['bob@x.com'], why: 'THE BUG — bare angle brackets' },
  {
    raw: '"Smith, Bob" <bob@x.com>;jane@y.com',
    emails: ['bob@x.com', 'jane@y.com'],
    why: 'THE BUG — a comma INSIDE the quoted display name',
  },
  {
    raw: 'Bob Smith <bob@x.com>, "Doe, Jane" <jane@y.com>',
    emails: ['bob@x.com', 'jane@y.com'],
    why: 'both forms in one list',
  },
  { raw: 'bob@x.com\njane@y.com', emails: ['bob@x.com', 'jane@y.com'], why: 'newline column' },
  { raw: 'BOB@X.COM ; Jane@Y.com', emails: ['bob@x.com', 'jane@y.com'], why: 'case folded' },
  { raw: '', emails: [], why: 'empty' },
  { raw: '   ', emails: [], why: 'whitespace only' },
  { raw: 'not-an-email;also-not', emails: [], why: 'no @ — dropped, not passed through' },
  { raw: 'a@b@c.com', emails: [], why: 'two @ is not an address' },
  { raw: '@x.com;bob@', emails: [], why: 'missing local-part / domain' },
  {
    raw: 'Bob <bob@x.com>;garbage;jane@y.com',
    emails: ['bob@x.com', 'jane@y.com'],
    why: 'one junk entry does not lose the valid ones',
  },
];

const VENDORS: ReadonlyArray<[string, (raw: string | null | undefined) => string[]]> = [
  ['hubspot', hubspotParseEmailList],
  ['salesforce', salesforceParseEmailList],
];

describe('a vendor address list parses into contact keys, not into text', () => {
  for (const [vendor, parse] of VENDORS) {
    it(`${vendor} parseEmailList extracts the address from every form`, () => {
      const wrong = CASES
        .map((c) => ({ c, got: parse(c.raw) }))
        .filter(({ c, got }) => JSON.stringify(got) !== JSON.stringify(c.emails))
        .map(({ c, got }) => `  ${JSON.stringify(c.raw)} → ${JSON.stringify(got)}`
          + ` (want ${JSON.stringify(c.emails)} — ${c.why})`);
      expect(wrong, `${vendor}:\n${wrong.join('\n')}`).toEqual([]);
    });

    /** 🔑 THE ONE THAT NEEDED NO EXPECTATION. Every value here is written as a
     *  `data.contact` key, so it must be what `canonicalizeEmail` would
     *  produce — otherwise the join silently misses and the contact
     *  double-counts. Holds for inputs nobody thought to tabulate above. */
    it(`${vendor} emits only fixed points of canonicalizeEmail`, () => {
      const extra = [
        'Bob Smith <BOB@X.com>', '"Q; R" <q@r.com>', 'a <a@b.com>, b <b@c.com>',
        '  <spaced@x.com>  ', 'Name (comment) <n@x.com>', 'no-at-here',
      ];
      const notFixed: string[] = [];
      for (const raw of [...CASES.map((c) => c.raw), ...extra]) {
        for (const email of parse(raw)) {
          if (canonicalizeEmail(email) !== email) {
            notFixed.push(`  ${JSON.stringify(raw)} → ${JSON.stringify(email)}`
              + ` (canonicalizes to ${JSON.stringify(canonicalizeEmail(email))})`);
          }
        }
      }
      expect(
        notFixed,
        `${vendor} emitted a value that is not a canonical contact key:\n${notFixed.join('\n')}\n`
          + 'These are written to engagement_edges.target_id as target_kind '
          + "'data.contact' and will match no contact row.",
      ).toEqual([]);
    });
  }

  it('the two vendor copies are the same function', () => {
    // They were byte-identical before and diverging silently is the failure
    // mode that made the original bug two bugs. Both now delegate.
    const probes = [...CASES.map((c) => c.raw), 'x <x@y.com>;;z@z.com', 'a@b.com,'];
    for (const raw of probes) {
      expect(salesforceParseEmailList(raw), JSON.stringify(raw))
        .toEqual(hubspotParseEmailList(raw));
      expect(hubspotParseEmailList(raw), JSON.stringify(raw))
        .toEqual(parseAddressListEmails(raw));
    }
  });

  it('null and undefined are empty, not a throw', () => {
    for (const [, parse] of VENDORS) {
      expect(parse(null)).toEqual([]);
      expect(parse(undefined)).toEqual([]);
    }
  });

  it('MUTATION: the fixed-point check can see the old implementation', () => {
    // ⚠ Without this the property above passes just as happily against a parser
    //   that returns nothing. This is the exact code that shipped.
    const old = (raw: string): string[] => raw.split(/[;,\n]/)
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 0 && p.includes('@'));
    const got = old('Bob Smith <bob@x.com>');
    expect(got).toEqual(['bob smith <bob@x.com>']);
    expect(canonicalizeEmail(got[0]!)).toBe('bob smith <bob@x.com>'); // stable but wrong
    expect(got[0]).not.toBe('bob@x.com');
  });
});
