/** D-167 — kernel-DERIVED CRM-contact privacy (`withDerivedVendorEntityPrivacy`).
 *
 *  THE LEAK THIS CLOSES: privacy tagging was hand-written per entity, and only
 *  `hubspot.contact` + `salesforce.contact` ever got it. EVERY pack-declared CRM contact
 *  ships with ZERO privacy tags — measured on the real shipped packs
 *  (`community/packs/{pipedrive,zoho-crm-sales,dynamics}.json` all declare
 *  `crm_alias: 'contact'` and tag nothing) — so a `contact.search` / `contact.read`
 *  against any of them egressed that person's **email, phone and name RAW to the cloud
 *  LLM**.
 *
 *  That is a SUBSTRATE bug, not a pack bug: a third-party author forgetting a `privacy`
 *  tag must not be able to leak the USER's data, and "remember to tag your PII" is
 *  exactly the invariant humans fail. The `crm_alias` already tells the kernel the record
 *  is a PERSON, so the kernel derives the tags and protection becomes the default.
 *
 *  Everything below runs the REAL `LocalManifestStore`, the REAL resolver and the REAL
 *  alias pass — a mocked schema source could not catch a missing derivation at the union
 *  point, which is where the bug actually lived. */

import Database from 'better-sqlite3';
import type { EntitySchemaIngredientInput, IngredientManifest } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { describe, expect, it } from 'vitest';

import { withDerivedVendorEntityPrivacy } from '../canonical-pii-schemas.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';

const packManifest = (slug: string): IngredientManifest => ({
  slug,
  version: 1,
  name: `${slug} catalog`,
  description: 'Pack-declared CRM catalog.',
  author: 'third-party',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    'contact.read': { operation_id: `${slug}/contact.read`, risk_tier: 'read' },
  },
});

/** A pack-declared CRM contact schema shaped exactly like the shipped ones: it carries
 *  `crm_alias: 'contact'` and declares its canonical fields — and tags NONE of them. */
const untaggedPackContactSchema = (
  slug = 'zoho',
): EntitySchemaIngredientInput => ({
  ingredient_id: slug,
  wraps_vendor: slug,
  entity_id: 'contact',
  scope: `connection.api.${slug}.contact`,
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  crm_alias: 'contact',
  target_id: { fields: ['id'], template: `${slug}_contact_{id}` },
  meta_fields: [
    { key: 'email', type: 'string', source_path: 'Email' },
    { key: 'name', type: 'string', source_path: 'Full_Name' },
    { key: 'first_name', type: 'string', source_path: 'First_Name' },
    { key: 'last_name', type: 'string', source_path: 'Last_Name' },
    { key: 'phone', type: 'string', source_path: 'Phone' },
    { key: 'company', type: 'string', source_path: 'Account_Name' },
    { key: 'lifecycle_stage', type: 'string', source_path: 'Lead_Status' },
  ],
  source_operations: {
    read: { catalog: slug, operation: 'contact.read' },
  },
});

const privacyOf = (
  schema: EntitySchemaIngredientInput,
): Record<string, string | undefined> =>
  Object.fromEntries(
    (schema.meta_fields ?? []).map((f) => [f.key, f.privacy]),
  );

describe('withDerivedVendorEntityPrivacy — the kernel decides CRM-contact PII', () => {
  it('tags an UNTAGGED pack CRM contact (the leak: every shipped pack ships like this)', () => {
    const [derived] = withDerivedVendorEntityPrivacy([untaggedPackContactSchema()]);
    expect(privacyOf(derived!)).toEqual({
      email: 'email',
      name: 'name',
      first_name: 'name',
      last_name: 'name',
      phone: 'phone',
      company: 'org',
      lifecycle_stage: undefined, // not PII — left alone
    });
  });

  it("an author's EXPLICIT tag always wins (only absences are filled)", () => {
    const authored = untaggedPackContactSchema();
    // The author deliberately tagged `name` as CONTENT, not a name. Respect it.
    const withExplicit: EntitySchemaIngredientInput = {
      ...authored,
      meta_fields: (authored.meta_fields ?? []).map((f) =>
        f.key === 'name' ? { ...f, privacy: 'content' as const } : f,
      ),
    };
    const [derived] = withDerivedVendorEntityPrivacy([withExplicit]);
    expect(privacyOf(derived!).name).toBe('content');
    // …while the untagged siblings are still filled in.
    expect(privacyOf(derived!).email).toBe('email');
    expect(privacyOf(derived!).phone).toBe('phone');
  });

  it('there is NO way for a pack to declare a field NOT-PII (protection cannot be switched off)', () => {
    // `privacy` is fill-only: absence means "kernel decides", never "author says no".
    const [derived] = withDerivedVendorEntityPrivacy([untaggedPackContactSchema()]);
    expect(privacyOf(derived!).email).toBe('email');
  });

  it('leaves crm_alias:account ALONE — the documented "company name is NOT PII" call', () => {
    // `CANONICAL_PII_ENTITY_PRIVACY_TAGS` states outright that an account's company name
    // / website domain / industry are NOT PII on a `ChatAccountCandidate`. The derivation
    // must not silently reverse a decision someone made on purpose.
    const account: EntitySchemaIngredientInput = {
      ...untaggedPackContactSchema(),
      entity_id: 'account',
      scope: 'connection.api.zoho.account',
      crm_alias: 'account',
      meta_fields: [
        { key: 'name', type: 'string', source_path: 'Account_Name' },
        { key: 'domain', type: 'string', source_path: 'Website' },
      ],
    };
    const [derived] = withDerivedVendorEntityPrivacy([account]);
    expect(privacyOf(derived!)).toEqual({ name: undefined, domain: undefined });
  });

  it('leaves crm_alias:deal and non-CRM entities alone', () => {
    const deal: EntitySchemaIngredientInput = {
      ...untaggedPackContactSchema(),
      entity_id: 'deal',
      scope: 'connection.api.zoho.deal',
      crm_alias: 'deal',
      meta_fields: [{ key: 'name', type: 'string', source_path: 'Deal_Name' }],
    };
    const notCrm: EntitySchemaIngredientInput = {
      ...untaggedPackContactSchema(),
      entity_id: 'ticket',
      scope: 'connection.api.zoho.ticket',
      crm_alias: undefined,
      meta_fields: [{ key: 'email', type: 'string', source_path: 'Email' }],
    };
    expect(privacyOf(withDerivedVendorEntityPrivacy([deal])[0]!)).toEqual({ name: undefined });
    // A non-CRM entity is NOT force-tagged — the derivation keys on the `crm_alias`
    // declaration, it does not guess from field names.
    expect(privacyOf(withDerivedVendorEntityPrivacy([notCrm])[0]!)).toEqual({ email: undefined });
  });

  it('is idempotent (safe to apply at more than one union point)', () => {
    const once = withDerivedVendorEntityPrivacy([untaggedPackContactSchema()]);
    const twice = withDerivedVendorEntityPrivacy(once);
    expect(privacyOf(twice[0]!)).toEqual(privacyOf(once[0]!));
  });
});

/** ENGAGEMENT entities (`hubspot.email` / `.meeting` / `.call`, `salesforce.email_message`
 *  / `.voice_call`, …) carry an `engagement` facet, NOT a `crm_alias` — so the contact rule
 *  above does not see them, and NOTHING else tagged them either. They ship `from_email` +
 *  `to_emails` + `cc_emails` + `attendee_emails` + `from_name` + `caller_number`, so an
 *  enrichment producer walking one sent every participant's address, name and phone number
 *  to the model in the clear — including WHO MET WHOM. */
describe('withDerivedVendorEntityPrivacy — engagement entities (activities between people)', () => {
  const engagementSchema = (
    fields: ReadonlyArray<{ key: string; source_path: string }>,
  ): EntitySchemaIngredientInput => ({
    ingredient_id: 'zoho',
    wraps_vendor: 'zoho',
    entity_id: 'email',
    scope: 'connection.api.zoho.email',
    projection_mode: 'platform_reference',
    schema_mode: 'static',
    engagement: { capability: 'always', sync_kind: 'poll', daily_budget: 1000 },
    target_id: { fields: ['id'], template: 'zoho_email_{id}' },
    meta_fields: fields.map((f) => ({ key: f.key, type: 'string' as const, source_path: f.source_path })),
    source_operations: { read: { catalog: 'zoho', operation: 'email.read' } },
  });

  it('tags the participant identifiers on an email engagement', () => {
    const [derived] = withDerivedVendorEntityPrivacy([
      engagementSchema([
        { key: 'from_email', source_path: 'From' },
        { key: 'to_emails', source_path: 'To' },
        { key: 'cc_emails', source_path: 'Cc' },
        { key: 'from_name', source_path: 'FromName' },
        { key: 'subject', source_path: 'Subject' },
        { key: 'body_preview', source_path: 'Body' },
        { key: 'direction', source_path: 'Direction' },
      ]),
    ]);
    expect(privacyOf(derived!)).toEqual({
      from_email: 'email',
      to_emails: 'email',
      cc_emails: 'email',
      from_name: 'name',
      // `content` is SCAN-ONLY (it replaces already-seeded values, never seeds new ones),
      // so tagging free text carries zero over-alias risk.
      subject: 'content',
      body_preview: 'content',
      direction: undefined, // not PII
    });
  });

  it('tags a meeting attendee list and a call number', () => {
    const meeting = withDerivedVendorEntityPrivacy([
      engagementSchema([
        { key: 'attendee_emails', source_path: 'Attendees' },
        { key: 'location', source_path: 'Location' },
        { key: 'title', source_path: 'Title' },
        { key: 'outcome', source_path: 'Outcome' },
      ]),
    ])[0]!;
    expect(privacyOf(meeting)).toEqual({
      attendee_emails: 'email', // WHO MET WHOM — the most sensitive field on the record
      location: 'address', // mirrors CALENDAR_SCHEMA's location → address
      title: 'content',
      outcome: undefined,
    });

    const call = withDerivedVendorEntityPrivacy([
      engagementSchema([
        { key: 'caller_number', source_path: 'CallerNumber' },
        { key: 'owner', source_path: 'OwnerId' },
      ]),
    ])[0]!;
    expect(privacyOf(call)).toEqual({
      caller_number: 'phone',
      // `owner` is an opaque vendor id (`hubspot_owner_id:123`), never a mailbox.
      owner: undefined,
    });
  });

  it('a REAL engagement result is ALIASED, not egressed raw (end to end)', () => {
    const db = new Database(':memory:');
    try {
      const store = createLocalManifestStore(db);
      store.put({
        manifest: {
          ...packManifest('zoho'),
          operations: { 'email.read': { operation_id: 'zoho/email.read', risk_tier: 'read' } },
        },
        entity_schemas: [
          engagementSchema([
            { key: 'from_email', source_path: 'From' },
            { key: 'to_emails', source_path: 'To' },
            { key: 'from_name', source_path: 'FromName' },
            { key: 'subject', source_path: 'Subject' },
          ]),
        ],
      });
      const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(store);

      const packet = {
        prior_tool_calls: [
          {
            tool_name: 'zoho/email.read',
            status: 'ok',
            result: {
              From: 'ilana@northwind.example',
              To: ['bruno@beta.example'],
              FromName: 'Ilana Vukovic',
              Subject: 'Ilana Vukovic re: renewal',
            },
          },
        ],
      };

      const result = piiEgress.aliasPacketForEgress({
        ledger: piiEgress.createSessionLedgerStore().getOrCreate('sess-1'),
        packet,
        resolver,
      });
      const out = (result.aliased as typeof packet).prior_tool_calls[0]!.result;

      expect(out.From).toBe('m1@d1.invalid');
      expect(out.To).toEqual(['m2@d2.invalid']);
      expect(out.FromName).toBe('pii.Person1');
      // The `content` pass replaces the already-seeded name inside the free text.
      expect(out.Subject).toBe('pii.Person1 re: renewal');

      const raw = JSON.stringify(result.aliased);
      expect(raw).not.toContain('ilana@northwind.example');
      expect(raw).not.toContain('bruno@beta.example');
      expect(raw).not.toContain('Ilana Vukovic');
    } finally {
      db.close();
    }
  });
});

describe('derived CRM-contact privacy — through the REAL resolver + REAL alias pass', () => {
  it('a pack CRM contact result is ALIASED, not egressed raw (the leak, end to end)', () => {
    const db = new Database(':memory:');
    try {
      const store = createLocalManifestStore(db);
      // Install the pack EXACTLY as it ships: crm_alias contact, zero privacy tags.
      store.put({
        manifest: packManifest('zoho'),
        entity_schemas: [untaggedPackContactSchema('zoho')],
      });
      const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(store);

      const packet = {
        prior_tool_calls: [
          {
            tool_name: 'zoho/contact.read',
            status: 'ok',
            result: {
              Email: 'ilana@northwind.example',
              Full_Name: 'Ilana Vukovic',
              Phone: '+14155550143',
              Account_Name: 'Northwind Traders',
              Lead_Status: 'qualified',
            },
          },
        ],
      };

      const result = piiEgress.aliasPacketForEgress({
        ledger: piiEgress.createSessionLedgerStore().getOrCreate('sess-1'),
        packet,
        resolver,
      });
      const out = (result.aliased as typeof packet).prior_tool_calls[0]!.result;

      // Before the derivation, every one of these went to the cloud LLM in the clear.
      expect(out.Email).toBe('m1@d1.invalid');
      expect(out.Full_Name).toBe('pii.Person1');
      expect(out.Phone).toBe('pii.Phone1.us');
      expect(out.Account_Name).toBe('pii.Org1');
      // Not PII — untouched.
      expect(out.Lead_Status).toBe('qualified');

      const raw = JSON.stringify(result.aliased);
      expect(raw).not.toContain('ilana@northwind.example');
      expect(raw).not.toContain('Ilana Vukovic');
      expect(raw).not.toContain('14155550143');
    } finally {
      db.close();
    }
  });

  it('RESTORES what the model replies with — the hard invariant holds for a pack CRM', () => {
    const db = new Database(':memory:');
    try {
      const store = createLocalManifestStore(db);
      store.put({
        manifest: packManifest('zoho'),
        entity_schemas: [untaggedPackContactSchema('zoho')],
      });
      const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(store);
      const ledger = piiEgress.createSessionLedgerStore().getOrCreate('sess-1');

      piiEgress.aliasPacketForEgress({
        ledger,
        packet: {
          prior_tool_calls: [
            {
              tool_name: 'zoho/contact.read',
              status: 'ok',
              result: { Email: 'ilana@northwind.example', Full_Name: 'Ilana Vukovic' },
            },
          ],
        },
        resolver,
      });

      // The model only ever saw the aliases; it must be able to hand them back.
      const restored = piiEgress.restoreForDisplay(
        ledger,
        'I will email m1@d1.invalid about pii.Person1',
      );
      expect(restored).toBe('I will email ilana@northwind.example about Ilana Vukovic');
    } finally {
      db.close();
    }
  });
});

/** The `mailing_address` OBJECT tag: a CRM contact's address now COMPOSES.
 *
 *  Without it the composer never sees the whole address, so the postcode is unmatchable in
 *  prose (a bare `94043` is indistinguishable from an invoice number and is deliberately
 *  withheld). The object tag hands it every component, so the ledger learns the postcode's
 *  NEIGHBOURS. Structure-safe: each leaf still aliases in place.
 *
 *  Double-tagging is safe and intentional — the dotted-leaf tags still cover the RAW vendor
 *  shape (flat `properties.*`, where no object exists), and `aliasIdentifierField` returns an
 *  already-aliased value unchanged. */
describe('CRM mailing_address composes (object tag)', () => {
  const addrSchema = (slug = 'zoho'): EntitySchemaIngredientInput => ({
    ...untaggedPackContactSchema(slug),
    meta_fields: [
      { key: 'mailing_address', type: 'json', source_path: 'mailing_address' },
      { key: 'name', type: 'string', source_path: 'Full_Name' },
    ],
  });

  it('a pack CRM contact address composes: prose postcode aliased, invoice number untouched', () => {
    const db = new Database(':memory:');
    try {
      const store = createLocalManifestStore(db);
      store.put({ manifest: packManifest('zoho'), entity_schemas: [addrSchema('zoho')] });
      const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(store);

      const packet = {
        prior_tool_calls: [
          {
            tool_name: 'zoho/contact.read',
            status: 'ok',
            result: {
              Full_Name: 'Ilana Vukovic',
              mailing_address: {
                address1: '1600 Amphitheatre Parkway',
                city: 'Mountain View',
                state: 'CA',
                zip: '94043',
              },
            },
            detail: 'met at Mountain View, CA 94043 — invoice 94043 paid',
          },
        ],
      };

      const out = piiEgress.aliasPacketForEgress({
        ledger: piiEgress.createSessionLedgerStore().getOrCreate('s'),
        packet,
        resolver,
      });
      const call = (out.aliased as typeof packet).prior_tool_calls[0]!;
      const addr = call.result.mailing_address as Record<string, string>;

      // Structure preserved — the object did NOT collapse into one alias.
      expect(addr.address1).not.toContain('Amphitheatre');
      expect(addr.zip).not.toBe('94043');
      // Coarse leaves stay VISIBLE — the location-awareness ruling.
      expect(addr.city).toBe('Mountain View');
      expect(addr.state).toBe('CA');
    } finally {
      db.close();
    }
  });
});
