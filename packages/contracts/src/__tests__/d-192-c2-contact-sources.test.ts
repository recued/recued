/** D-192 C-2 slice 5 — the `ContactSourceDeclaration` registry (contracts, pure).
 *
 *  Mirrors the file-vendors test (enum vocab, the shipped entries + their facts,
 *  the fail-closed per-entry validator, the throwing builder, the cross-entry
 *  dup-vendor guard, the accessors). Boot self-validation is implicit — importing
 *  the module runs it; a bad registry would throw at load.
 *
 *  Two blocks here carry more weight than the usual registry test, because both
 *  guard failures that are SILENT rather than loud:
 *
 *   - **the import-rung floor** — an importer may never write `manual`, or a CRM
 *     sync would outrank the user's own typing and no later edit could win it back.
 *   - **the declared absences** — `supplies` is a PROMISE, and its GAPS are
 *     statements of fact about each vendor (Salesforce carries no company field;
 *     Pipedrive carries neither company nor address). Pinning them means a future
 *     edit that quietly "fills in" a gap the vendor cannot actually supply fails
 *     HERE, instead of draining a D-138 blocking key to NULL in production.
 */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  CONTACT_IMPORT_RUNGS,
  CONTACT_IMPORT_SCOPES,
  CONTACT_MATCH_KEY_KINDS,
  CONTACT_SOURCE_DECLARATIONS,
  assertContactSourceDeclarationShape,
  assertContactSourceRegistry,
  assertContactSourceRegistryBinding,
  assertContactSourceVendorBinding,
  buildContactSourceDeclaration,
  getContactSourceDeclaration,
  isDeclaredContactSourceVendor,
  listContactSourceVendors,
  type ConnectionVendorEntity,
  type ContactSourceDeclaration,
} from '../index.js';

const valid = (): ContactSourceDeclaration => ({
  vendor: 'hubspot',
  display_name: 'HubSpot Contacts',
  rung: 'vendor_meta',
  import_scope: 'hydrate_on_match',
  vendor_entity: 'contact',
  supplies: { aliases: ['email_alias', 'phone_alias'], attributes: ['name', 'org', 'address'] },
  match_on: ['email_alias'],
});

/** A declaration cast through `unknown` so a deliberately-invalid field can be
 *  handed to the shape validator (which takes `unknown` by design). */
const withField = (patch: Record<string, unknown>): unknown => ({ ...valid(), ...patch });

describe('D-192 C-2 slice 5 — vocabulary', () => {
  it('import scopes are the two miss policies', () => {
    expect([...CONTACT_IMPORT_SCOPES]).toEqual(['full_import', 'hydrate_on_match']);
  });

  it('import rungs are a strict subset of the ladder — the user rungs are excluded', () => {
    expect([...CONTACT_IMPORT_RUNGS]).toEqual(['vendor_meta', 'contact_book']);
    expect(CONTACT_IMPORT_RUNGS).not.toContain('manual');
    expect(CONTACT_IMPORT_RUNGS).not.toContain('user_confirmed');
    expect(CONTACT_IMPORT_RUNGS).not.toContain('derived');
  });

  it('match-key kinds are the two with a contact-store resolver behind them', () => {
    // email → `contactByAnyEmail` (the slice-4 address space); phone →
    // `contact_phone_forms`. `chat_alias` / `platform_id` identify a person on
    // another surface and have no resolver at all.
    expect([...CONTACT_MATCH_KEY_KINDS]).toEqual(['email_alias', 'phone_alias']);
  });
});

describe('D-192 C-2 slice 5 — the shape validator fails closed', () => {
  it('accepts the shipped shape', () => {
    expect(assertContactSourceDeclarationShape(valid())).toEqual([]);
  });

  it('REJECTS an importer writing the `manual` rung — the structural guarantee', () => {
    // The headline invariant. An import at `manual` would park a vendor's value at
    // the TOP of the C-2a ladder, where the user's own typing could never correct
    // it — the exact data loss the rejected `legacy` rung would have caused.
    const issues = assertContactSourceDeclarationShape(withField({ rung: 'manual' }));
    expect(issues.some((i) => i.includes("field 'rung'"))).toBe(true);
  });

  it("rejects Recued's own rungs (derived / ai_inferred / domain_inferred)", () => {
    for (const rung of ['derived', 'ai_inferred', 'domain_inferred']) {
      const issues = assertContactSourceDeclarationShape(withField({ rung }));
      expect(issues.some((i) => i.includes("field 'rung'"))).toBe(true);
    }
  });

  it('rejects a match_on that is not a subset of supplies.aliases', () => {
    // Matching on an identifier the source never imports = a silent zero-import.
    const issues = assertContactSourceDeclarationShape(
      withField({
        supplies: { aliases: ['email_alias'], attributes: ['name'] },
        match_on: ['phone_alias'],
      }),
    );
    expect(issues.some((i) => i.includes('not in supplies.aliases'))).toBe(true);
  });

  it('rejects an empty match_on — a source with no join key matches nothing', () => {
    const issues = assertContactSourceDeclarationShape(withField({ match_on: [] }));
    expect(issues.some((i) => i.includes("field 'match_on' must be non-empty"))).toBe(true);
  });

  it('REJECTS an unmatchable join key (chat_alias / platform_id) — even for an address book', () => {
    // Matchability is a property of the KIND, not the vendor, so it is enforced in
    // the PURE shape validator. The vendor binding cannot carry this rule: it
    // returns early for `vendor_entity: null`, so an address book — exactly the
    // thing slice 7 adds — would sail straight past it with a chat_alias join key
    // and silently match zero contacts forever.
    for (const kind of ['chat_alias', 'platform_id']) {
      const issues = assertContactSourceDeclarationShape(
        withField({
          vendor: 'google',
          rung: 'contact_book',
          import_scope: 'full_import',
          vendor_entity: null,
          supplies: { aliases: ['email_alias', kind], attributes: ['name'] },
          match_on: [kind],
        }),
      );
      expect(issues.some((i) => i.includes('cannot key a match'))).toBe(true);
    }
  });

  it('rejects empty supplies.aliases — a source with no identifier cannot attach', () => {
    const issues = assertContactSourceDeclarationShape(
      withField({ supplies: { aliases: [], attributes: ['name'] }, match_on: ['email_alias'] }),
    );
    expect(issues.some((i) => i.includes('supplies.aliases must be non-empty'))).toBe(true);
  });

  it('allows empty supplies.attributes — an identity-only source is coherent', () => {
    const issues = assertContactSourceDeclarationShape(
      withField({ supplies: { aliases: ['email_alias'], attributes: [] } }),
    );
    expect(issues).toEqual([]);
  });

  it('rejects unknown alias / attribute kinds and duplicates', () => {
    expect(
      assertContactSourceDeclarationShape(
        withField({ supplies: { aliases: ['email_alias', 'nope'], attributes: ['name'] } }),
      ).some((i) => i.includes("unknown kind 'nope'")),
    ).toBe(true);

    expect(
      assertContactSourceDeclarationShape(
        withField({ supplies: { aliases: ['email_alias'], attributes: ['name', 'name'] } }),
      ).some((i) => i.includes("lists 'name' twice")),
    ).toBe(true);
  });

  it('rejects a bad vendor slug and an empty display_name', () => {
    expect(
      assertContactSourceDeclarationShape(withField({ vendor: 'HubSpot' })).some((i) =>
        i.includes("field 'vendor'"),
      ),
    ).toBe(true);
    expect(
      assertContactSourceDeclarationShape(withField({ display_name: '' })).some((i) =>
        i.includes("field 'display_name'"),
      ),
    ).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(assertContactSourceDeclarationShape(null)).toEqual(['expected object']);
    expect(assertContactSourceDeclarationShape([])).toEqual(['expected object']);
  });

  it('a malformed supplies does NOT cascade a misleading subset error onto match_on', () => {
    // With supplies unparseable we do not know what the source imports, so claiming
    // "you never import email" would point the reader at the wrong field entirely.
    const issues = assertContactSourceDeclarationShape(
      withField({ supplies: null, match_on: ['email_alias'] }),
    );
    expect(issues).toContain("field 'supplies' must be an object");
    expect(issues.some((i) => i.includes('is not in supplies.aliases'))).toBe(false);
  });

  it('the builder THROWS on a misconfigured entry (module-load failure, not first-sync)', () => {
    // The double cast is the point: `rung: 'manual'` does not even TYPE-CHECK against
    // `ContactImportRung`, so the registry literal is guarded at compile time. The
    // runtime validator is defence-in-depth for values that arrive from outside the
    // type system — a persisted row, a pack-declared source.
    expect(() =>
      buildContactSourceDeclaration({
        ...valid(),
        rung: 'manual',
      } as unknown as ContactSourceDeclaration),
    ).toThrow(/invalid ContactSourceDeclaration 'hubspot'/);
  });
});

describe('D-192 C-2 slice 5 — the vendor binding (the anti-silent-zero-import device)', () => {
  /** A stand-in vendor registry, so the binding failures can be provoked without
   *  mutating the real one. */
  const fakeRegistry = (fields: ConnectionVendorEntity['meta_fields']): ConnectionVendorEntity[] => [
    {
      vendor: 'acme',
      entity: 'contact',
      display_name: 'Acme Contact',
      crm_alias: 'contact',
      meta_fields: fields,
    } as ConnectionVendorEntity,
  ];

  it('an address book (null vendor_entity) has nothing to bind', () => {
    const decl: ContactSourceDeclaration = {
      ...valid(),
      vendor: 'google',
      rung: 'contact_book',
      import_scope: 'full_import',
      vendor_entity: null,
    };
    expect(assertContactSourceVendorBinding(decl)).toEqual([]);
  });

  it('rejects a vendor_entity absent from CONNECTION_VENDOR_ENTITIES (the typo guard)', () => {
    const decl: ContactSourceDeclaration = { ...valid(), vendor_entity: 'contacts' };
    expect(assertContactSourceVendorBinding(decl).some((i) => i.includes('is not declared'))).toBe(
      true,
    );
  });

  it('rejects hydrating a person from a deal-aliased entity', () => {
    // `hubspot.deal` exists, but you cannot build a contact out of it.
    const decl: ContactSourceDeclaration = { ...valid(), vendor_entity: 'deal' };
    expect(
      assertContactSourceVendorBinding(decl).some((i) => i.includes("crm_alias 'deal'")),
    ).toBe(true);
  });

  it('REJECTS an email join key the vendor entity cannot back — the silent-zero-import guard', () => {
    // An entity with a phone but no email. `match_on: ['email_alias']` against it
    // would hydrate exactly zero contacts, forever, without ever erroring — and be
    // indistinguishable from "the CRM had no matches".
    const decl: ContactSourceDeclaration = { ...valid(), vendor: 'acme', vendor_entity: 'contact' };
    const registry = fakeRegistry([
      { key: 'phone', type: 'string', source_path: 'Phone', description: 'phone' },
    ]);
    expect(
      assertContactSourceVendorBinding(decl, registry).some((i) =>
        i.includes('would silently match zero contacts'),
      ),
    ).toBe(true);
  });

  it('a meta-field declared with NEITHER source_path NOR derivation does not back a join key', () => {
    // This is the `mailing_address` shape — a bare declaration. It must not count
    // as "backed" merely by existing.
    const decl: ContactSourceDeclaration = { ...valid(), vendor: 'acme', vendor_entity: 'contact' };
    const registry = fakeRegistry([
      { key: 'email', type: 'string', description: 'declared, but nothing behind it' },
    ]);
    expect(
      assertContactSourceVendorBinding(decl, registry).some((i) =>
        i.includes('would silently match zero contacts'),
      ),
    ).toBe(true);
  });

  it('a derivation-backed meta-field DOES back a join key', () => {
    const decl: ContactSourceDeclaration = { ...valid(), vendor: 'acme', vendor_entity: 'contact' };
    const registry = fakeRegistry([
      {
        key: 'email',
        type: 'string',
        description: 'derived',
        derivation: { kind: 'concat', parts: ['a', 'b'] },
      },
    ]);
    expect(assertContactSourceVendorBinding(decl, registry)).toEqual([]);
  });
});

describe('D-192 C-2 slice 5 — the shipped registry', () => {
  it('boot-validates clean (shape + dup — the self-contained half that throws at load)', () => {
    expect(assertContactSourceRegistry(CONTACT_SOURCE_DECLARATIONS)).toEqual([]);
  });

  it('BINDS clean against the LIVE vendor registry — the CI half of the join-key guard', () => {
    // Not a formality, and this is the ONLY place it is enforced pre-slice-6: it is
    // what fails if someone drops the `email` meta-field from `salesforce.contact`
    // or renames Pipedrive's `person` entity. Deliberately NOT a module-load throw —
    // that would let an unrelated D-194 edit brick every import of packages/contracts.
    expect(assertContactSourceRegistryBinding(CONTACT_SOURCE_DECLARATIONS)).toEqual([]);
  });

  it('declares the three CRMs + the TWO contact books — and CardDAV is still absent', () => {
    // ⚠ D-205 #4c — `google` landed, and it arrived the way this test used to demand:
    // in the SAME commit as its leaf, with `supplies` read off a field map that
    // exists (the `google-contacts` pack's `entities.person`).
    //
    // `microsoft` landed the same way: with `graph-people-leaf.ts` and the
    // `microsoft-contacts` pack's `entities.contact` in the same change.
    expect([...listContactSourceVendors()]).toEqual([
      'hubspot',
      'salesforce',
      'google',
      'pipedrive',
      'microsoft',
    ]);
    expect(isDeclaredContactSourceVendor('google')).toBe(true);
    expect(isDeclaredContactSourceVendor('microsoft')).toBe(true);
    // Still absent, for the ORIGINAL reason: no leaf. `supplies` is a promise the
    // runner verifies per record, so promising the shape of an API nobody has read
    // fails EVERY record on the FIRST cycle. It lands with its leaf.
    expect(isDeclaredContactSourceVendor('carddav')).toBe(false);
    // ⚠ Kept deliberately after `microsoft` landed, and it now guards something
    // DIFFERENT: the Microsoft contact book is declared under the vendor slug
    // `microsoft` — the one the whole shipped Graph pack family already uses
    // (`outlook`, `onedrive`, `teams`, `planner`). `msgraph` must stay undeclared so
    // a second Microsoft entry cannot appear under a parallel slug and split the
    // connection row-match.
    expect(isDeclaredContactSourceVendor('msgraph')).toBe(false);
  });

  it('🔑 the POSTURE is what separates a CRM from a contact book — and it is exclusive', () => {
    // This is the whole design in one assertion. A CRM is your COMPANY's list — 10k
    // rows, mostly strangers — so it only ever ENRICHES someone you already know. A
    // contact book is YOUR list; every entry is someone you chose to keep, including
    // the dentist who has never emailed you and never will.
    //
    // The two are perfectly correlated with the RUNG, and must be: `full_import`
    // CREATES rows, and a created row must be attributable — only `contact_book` has
    // a `ContactSource` to stamp (the runner refuses the cycle otherwise).
    for (const d of CONTACT_SOURCE_DECLARATIONS) {
      if (d.rung === 'vendor_meta') {
        expect(d.import_scope, d.vendor).toBe('hydrate_on_match');
        expect(d.vendor_entity, d.vendor).not.toBeNull(); // a CRM has a platform record
      } else {
        expect(d.rung, d.vendor).toBe('contact_book');
        expect(d.import_scope, d.vendor).toBe('full_import');
        // A contact book has NO platform record — it IS the record. This null is what
        // makes the runner's bind gate early-return instead of running a CRM-shaped
        // check against a thing that is not a CRM.
        expect(d.vendor_entity, d.vendor).toBeNull();
      }
      // Email keys every match. The runner has no phone→contact resolver and REFUSES
      // a cycle keyed on one rather than match zero contacts in silence.
      expect([...d.match_on], d.vendor).toEqual(['email_alias']);
    }
  });

  it('every declared vendor_entity really is contact-aliased in the live registry', () => {
    for (const d of CONTACT_SOURCE_DECLARATIONS) {
      // A contact book declares none — nothing to bind, and
      // `assertContactSourceVendorBinding` short-circuits on exactly this.
      if (d.vendor_entity === null) continue;
      const entity = CONNECTION_VENDOR_ENTITIES.find(
        (v) => v.vendor === d.vendor && v.entity === d.vendor_entity,
      );
      expect(entity, `${d.vendor}.${String(d.vendor_entity)}`).toBeDefined();
      expect(entity?.crm_alias).toBe('contact');
    }
  });

  // ── The declared absences. Each is a STATEMENT about the vendor, pinned so a
  //    future edit cannot quietly promise something no code can produce. ──

  it('HubSpot supplies org + address; it is the only CRM with a company field', () => {
    const hb = getContactSourceDeclaration('hubspot');
    expect(hb?.supplies.attributes).toContain('org'); // properties.company
    expect(hb?.supplies.attributes).toContain('address'); // via the reconciler, NOT the registry
  });

  it('Salesforce supplies NO org — a SF Contact has no Company field (it is an AccountId link)', () => {
    const sf = getContactSourceDeclaration('salesforce');
    expect(sf?.supplies.attributes).not.toContain('org');
    expect(sf?.supplies.attributes).toContain('address');
  });

  it('Pipedrive supplies NEITHER org NOR address', () => {
    const pd = getContactSourceDeclaration('pipedrive');
    expect(pd?.supplies.attributes).not.toContain('org'); // an org_id link
    expect(pd?.supplies.attributes).not.toContain('address'); // no meta-field at all
    expect(pd?.supplies.attributes).toContain('name');
  });

  it('no CRM supplies title / photo / birthday — and the contact book is why that gap exists', () => {
    // The CRM half is unchanged: HubSpot `jobtitle` + Salesforce `Title` exist in the
    // vendor APIs but are neither declared as meta-fields nor requested by the
    // reconcilers. Promising `title` there would promise a value no code can produce.
    // And no CRM carries a photo or a birthday AT ALL — those are what an address
    // book is FOR, which is the argument for having one.
    for (const d of CONTACT_SOURCE_DECLARATIONS) {
      if (d.rung !== 'vendor_meta') continue;
      expect(d.supplies.attributes, d.vendor).not.toContain('title');
      expect(d.supplies.attributes, d.vendor).not.toContain('photo');
      expect(d.supplies.attributes, d.vendor).not.toContain('birthday');
    }

    // ✅ And the contact book closes half of it: Google supplies the PHOTO — a URL,
    // never bytes (C-2's North star), and the detail page renders it as text for
    // exactly that reason.
    const google = getContactSourceDeclaration('google');
    expect(google?.supplies.attributes).toContain('photo');

    // ⚠ …but NOT `birthday`, and that is a STATEMENT, not an oversight. The People
    // API carries birthdays; the PACK's `entities.person` field map does not declare
    // them, so no code can produce one. `supplies` is a promise the runner VERIFIES
    // per record — promising it would fail every record on the first cycle. Closing
    // it is a visible two-line pack edit, not a discovery six months on.
    expect(google?.supplies.attributes).not.toContain('birthday');
    expect(google?.supplies.attributes).not.toContain('title');
  });

  it('NOBODY supplies platform_id — that alias kind is the SOCIAL axis, not the CRM link', () => {
    // `CONTACT_ALIAS_PLATFORMS` is a closed list (facebook / x / instagram /
    // linkedin / github / substack) with no CRM vendors in it. The CRM record link
    // is a different substrate — `PlatformIdEntry` / `contact_platform_link`.
    for (const d of CONTACT_SOURCE_DECLARATIONS) {
      expect(d.supplies.aliases).not.toContain('platform_id');
    }
  });
});

describe('D-192 C-2 slice 5 — cross-entry guard + accessors', () => {
  it('catches a duplicate vendor slug', () => {
    const issues = assertContactSourceRegistry([valid(), valid()]);
    expect(issues.some((i) => i.includes("duplicate vendor 'hubspot'"))).toBe(true);
  });

  it('getContactSourceDeclaration returns null for an undeclared vendor', () => {
    expect(getContactSourceDeclaration('hubspot')?.vendor).toBe('hubspot');
    expect(getContactSourceDeclaration('zoho')).toBeNull();
    expect(isDeclaredContactSourceVendor('zoho')).toBe(false);
    expect(isDeclaredContactSourceVendor(42)).toBe(false);
  });
});
