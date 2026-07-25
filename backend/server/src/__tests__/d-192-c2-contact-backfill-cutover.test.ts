/** D-192 C-2 (Stance 2) slice 3 — the CUTOVER: the provenance-preserving
 *  backfill, the wired write paths, and `contact_id` NOT NULL.
 *
 *  This is the GATE. `materializeContactProjection` writes the projection of the
 *  contributions FULL STOP — a field with no contribution projects to NULL — so
 *  slices 1 and 2 deliberately left it unwired: running it before every legacy
 *  column value had a contribution behind it would have WIPED the warehouse.
 *  This slice backfills, then wires. Both halves are asserted here, against a
 *  real SQLite file: the invariants under test are UNIQUE indexes, triggers, and
 *  what actually lands in the columns, and a mock asserts nothing about any of it.
 *
 *  Spec: D-192 (build plan step 3);
 *  decisions-log § D-192 C-2. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTACT_SOURCE_ID_DERIVED,
  CONTACT_SOURCE_ID_MANUAL,
  type ContactSource,
} from '@recued/contracts';

import {
  createContactStore,
  ensureContactSchema,
  isMentionOnlyEmail,
  type ContactStore,
} from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-cutover-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Schema only — NO store yet. Every test here seeds a PRE-CUTOVER warehouse
  // (columns written, zero contributions, `projection_provenance` NULL) and then
  // constructs the store, because construction is when the cutover runs.
  ensureContactSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Write a row exactly as the PRE-C-2 store wrote it: columns, and nothing else.
 *  This is the warehouse the cutover has to convert without losing anything. */
const seedLegacyRow = (input: {
  readonly email: string;
  readonly contact_id: string;
  readonly name?: string | null;
  readonly source?: ContactSource;
  readonly phone?: string | null;
  readonly company?: string | null;
  readonly company_source?: string | null;
  readonly mailing_address?: unknown;
  readonly merged_into?: string | null;
  readonly updated_at?: number;
}): void => {
  db.prepare(
    `INSERT INTO contacts
       (email, name, first_seen, last_interaction, interaction_count, source,
        created_at, updated_at, contact_id, phone, company, company_source,
        mailing_address, merged_into)
       VALUES (@email, @name, 1000, 1000, 1, @source, 1000, @updated_at,
               @contact_id, @phone, @company, @company_source,
               @mailing_address, @merged_into)`,
  ).run({
    email: input.email,
    name: input.name ?? null,
    source: input.source ?? 'email_from',
    updated_at: input.updated_at ?? 5_000,
    contact_id: input.contact_id,
    phone: input.phone ?? null,
    company: input.company ?? null,
    company_source: input.company_source ?? null,
    mailing_address: input.mailing_address
      ? JSON.stringify(input.mailing_address)
      : null,
    merged_into: input.merged_into ?? null,
  });
};

const orgOf = (store: ContactStore, id: string) =>
  store.listContactAttributes(id, 'org')[0];
const nameOf = (store: ContactStore, id: string) =>
  store.listContactAttributes(id, 'name')[0];
const aliasOf = (store: ContactStore, id: string, kind: 'email_alias' | 'phone_alias') =>
  store.listContactAliases(id, kind)[0];

// ════════════════════════════════════════════════════════════════════════════
describe('D-192 C-2b — the cutover backfill, provenance-PRESERVING', () => {
  it('maps every legacy column to its TRUE rung — there is no flat `legacy`', () => {
    seedLegacyRow({
      email: 'typed@example.com',
      contact_id: 'ct_typed',
      name: 'Roberta Smith',
      source: 'manual',
      phone: '+16175550100',
      company: 'Acme (typed)',
      company_source: 'manual',
      mailing_address: { address1: '1 main street', city: 'boston', state: 'MA', zip: '02101', country: 'US' },
    });
    seedLegacyRow({
      email: 'derived@example.com',
      contact_id: 'ct_derived',
      name: 'Bob From The Header',
      source: 'email_from',
      company: 'Globex',
      company_source: 'vendor_meta',
    });

    const store = createContactStore(db); // ← the cutover runs HERE

    // The user's own row: everything they touched is `manual`.
    expect(nameOf(store, 'ct_typed')).toMatchObject({
      value: 'Roberta Smith',
      source: 'manual',
      source_id: CONTACT_SOURCE_ID_MANUAL,
    });
    expect(orgOf(store, 'ct_typed')).toMatchObject({ source: 'manual' });
    expect(store.listContactAttributes('ct_typed', 'address')[0]).toMatchObject({
      source: 'manual',
    });
    expect(aliasOf(store, 'ct_typed', 'phone_alias')).toMatchObject({
      alias_pattern: '+16175550100',
      source: 'manual',
    });
    expect(aliasOf(store, 'ct_typed', 'email_alias')).toMatchObject({
      alias_pattern: 'typed@example.com',
      source: 'manual', // the ROW's source is manual → so is its address
    });

    // The mail-derived row: `derived`, not `manual` — nobody ASSERTED any of it,
    // Recued pulled it out of a `From:` header. That is what lets a real address
    // book correct it later.
    expect(nameOf(store, 'ct_derived')).toMatchObject({
      source: 'derived',
      source_id: CONTACT_SOURCE_ID_DERIVED,
    });
    expect(aliasOf(store, 'ct_derived', 'email_alias')).toMatchObject({
      source: 'derived',
    });
    // …but its company carried a RECORDED provenance, and that is preserved
    // independently of how the row itself was born.
    expect(orgOf(store, 'ct_derived')).toMatchObject({
      value: 'Globex',
      source: 'vendor_meta',
    });

    // `as_of` is the row's last-written time, not the cutover clock — the
    // tightest honest upper bound on when the value was actually asserted.
    expect(nameOf(store, 'ct_typed')?.as_of).toBe(5_000);
  });

  // ── The headline regression. This is why C-2b's ratified prose was rejected. ──
  it('a CRM import does NOT overwrite the user’s hand-typed value after the cutover', () => {
    // The ratified C-2b said "backfill existing columns as `source='legacy'`
    // contributions". A flat `legacy` rung parked at the BOTTOM of the ladder
    // means the very first `vendor_meta` import outranks it — so the user's own
    // hand-typed company is silently destroyed by the first HubSpot sync. That is
    // the precise data loss the projection exists to prevent, and it would have
    // been introduced BY the thing meant to prevent it.
    seedLegacyRow({
      email: 'bob@example.com',
      contact_id: 'ct_bob',
      name: 'Bob',
      source: 'manual',
      company: 'Acme (typed by me)',
      company_source: 'manual',
    });

    const store = createContactStore(db);

    // HubSpot syncs and disagrees.
    store.upsertContactAttribute({
      contact_id: 'ct_bob',
      kind: 'org',
      value: 'ACME CORPORATION INC',
      source: 'vendor_meta',
      source_id: 'hubspot.prod.contact',
      as_of: 9_999_999,
    });
    const rec = store.materializeContactProjection('ct_bob');

    // The user still wins. Under a flat `legacy` rung this would read
    // 'ACME CORPORATION INC' and the typed value would be gone from the column
    // with nothing to surface the loss.
    expect(rec?.company).toBe('Acme (typed by me)');
    expect(rec?.projection_provenance?.org?.source).toBe('manual');
    // And HubSpot's view is not destroyed either — it coexists, one rung down.
    expect(store.listContactAttributes('ct_bob', 'org')).toHaveLength(2);
  });

  it('a company with NO recorded source becomes `derived`, never `manual`', () => {
    // The `null` case in `companySourceToContributionRung`. Guessing `manual`
    // would park an UNATTRIBUTED value at the top of the ladder, where no import
    // could ever correct it — provenance that lies, with teeth.
    seedLegacyRow({
      email: 'x@example.com',
      contact_id: 'ct_x',
      name: 'X',
      company: 'Mystery Co',
      company_source: null,
    });

    const store = createContactStore(db);
    expect(orgOf(store, 'ct_x')).toMatchObject({
      value: 'Mystery Co',
      source: 'derived',
    });
    // It round-trips: `derived` is a rung the narrow legacy enum cannot express,
    // so it projects back to a NULL `company_source` — the same value the column
    // held before, and correctly OUT of the D-138 domain-inference seed pool
    // (`WHERE company_source IN ('vendor_meta','manual')`).
    const row = db
      .prepare('SELECT company_source FROM contacts WHERE contact_id = ?')
      .get('ct_x') as { company_source: string | null };
    expect(row.company_source).toBeNull();

    // …and an address book CAN now correct it, which is the whole point.
    store.upsertContactAttribute({
      contact_id: 'ct_x', kind: 'org', value: 'Mystery Co Ltd',
      source: 'contact_book', source_id: 'google.personal.contact',
    });
    expect(store.materializeContactProjection('ct_x')?.company).toBe('Mystery Co Ltd');
  });

  it('a name that is only the email local-part is `derived`, not `manual`', () => {
    // A contact created through `contact.upsert` with an email and no name gets
    // `fallbackDisplayName(email)` written into the column. The user typed NO
    // name. Calling that `manual` would sit a placeholder at the top of the ladder
    // where the real name from the first address-book import could never beat it.
    seedLegacyRow({
      email: 'rsmith@example.com',
      contact_id: 'ct_fb',
      name: 'rsmith', // === fallbackDisplayName('rsmith@example.com')
      source: 'manual',
    });

    const store = createContactStore(db);
    expect(nameOf(store, 'ct_fb')).toMatchObject({ value: 'rsmith', source: 'derived' });

    store.upsertContactAttribute({
      contact_id: 'ct_fb', kind: 'name', value: 'Roberta Smith',
      source: 'contact_book', source_id: 'google.personal.contact',
    });
    expect(store.materializeContactProjection('ct_fb')?.name).toBe('Roberta Smith');
  });

  it('does NOT wipe the legacy columns — the whole reason the gate existed', () => {
    const addr = { address1: '9 elm street', city: 'boston', state: 'MA', zip: '02101', country: 'US' };
    seedLegacyRow({
      email: 'keep@example.com',
      contact_id: 'ct_keep',
      name: 'Keep Me',
      source: 'manual',
      phone: '+16175550111',
      company: 'Keeper Inc',
      company_source: 'manual',
      mailing_address: addr,
    });

    const store = createContactStore(db);
    const rec = store.get('keep@example.com');

    expect(rec?.name).toBe('Keep Me');
    expect(rec?.phone).toBe('+16175550111');
    expect(rec?.company).toBe('Keeper Inc');
    expect(rec?.mailing_address).toEqual(addr);
    // And the row is now stamped as projected — the marker that makes the cutover
    // exactly-once.
    expect(rec?.projection_provenance?.name?.source).toBe('manual');
  });

  it('is exactly-once: a re-boot does not resurrect a torn-down contribution', () => {
    seedLegacyRow({
      email: 'bob@example.com',
      contact_id: 'ct_bob',
      name: 'Bob',
      source: 'manual',
      company: 'Acme',
      company_source: 'manual',
    });

    const store = createContactStore(db);
    expect(store.listContactAttributes('ct_bob', 'org')).toHaveLength(1);

    // A Source is disconnected and its contributions are purged, then the column
    // is re-projected (org → NULL, because nothing asserts it any more).
    store.deleteContactAttributesForSource(CONTACT_SOURCE_ID_MANUAL);
    store.materializeContactProjection('ct_bob');
    expect(store.get('bob@example.com')?.company).toBeUndefined();

    // Re-boot. A backfill that re-derived contributions from the columns every
    // time would find nothing here (the column is NULL now) — but the guard is
    // what makes that safe in general: the row has already been projected, so the
    // pass skips it and cannot re-invent a `manual` provenance for data a
    // teardown deliberately removed.
    const rebooted = createContactStore(db);
    expect(rebooted.listContactAttributes('ct_bob', 'org')).toHaveLength(0);
    expect(rebooted.listContactAttributes('ct_bob', 'name')).toHaveLength(0);
    expect(rebooted.get('bob@example.com')?.company).toBeUndefined();
  });

  it('is idempotent across boots — no duplicate contributions', () => {
    seedLegacyRow({
      email: 'bob@example.com', contact_id: 'ct_bob', name: 'Bob',
      source: 'manual', company: 'Acme', company_source: 'manual',
    });
    createContactStore(db);
    const second = createContactStore(db);
    const third = createContactStore(db);

    expect(second.listContactAttributes('ct_bob')).toHaveLength(2); // name + org
    expect(third.listContactAliases('ct_bob')).toHaveLength(1); // email_alias
    expect(third.get('bob@example.com')?.company).toBe('Acme');
  });

  it('SKIPS tombstones — a merged-away row is a redirect, not a projection', () => {
    seedLegacyRow({ email: 'survivor@example.com', contact_id: 'ct_s', name: 'S', source: 'manual' });
    seedLegacyRow({
      email: 'loser@example.com',
      contact_id: 'ct_l',
      name: 'L',
      source: 'manual',
      merged_into: 'survivor@example.com',
    });

    const store = createContactStore(db);

    // No contributions minted for the tombstone, and — critically — no
    // `email_alias`: the loser's email belongs to the SURVIVOR, and wiring that
    // is slice 4's job, not something the cutover should pre-empt with a row
    // pointing at the dead contact.
    expect(store.listContactAttributes('ct_l')).toHaveLength(0);
    expect(store.listContactAliases('ct_l')).toHaveLength(0);
    expect(store.listContactAttributes('ct_s')).toHaveLength(1);
  });

  it('no-ops on a fresh warehouse', () => {
    const store = createContactStore(db);
    expect(store.count()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('D-192 C-2 slice 3 — `contact_id` NOT NULL, enforced', () => {
  it('refuses an INSERT with no contact_id', () => {
    createContactStore(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO contacts
             (email, name, first_seen, last_interaction, interaction_count, source,
              created_at, updated_at)
             VALUES ('orphan@x.com', 'O', 1, 1, 1, 'manual', 1, 1)`,
        )
        .run(),
    ).toThrow(/contact_id_required/);
  });

  it('refuses an UPDATE that blanks contact_id', () => {
    createContactStore(db);
    seedLegacyRow({ email: 'bob@x.com', contact_id: 'ct_bob', name: 'Bob' });
    expect(() =>
      db.prepare(`UPDATE contacts SET contact_id = '' WHERE email = 'bob@x.com'`).run(),
    ).toThrow(/contact_id_required/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('D-192 C-2 slice 3 — the wired write paths', () => {
  let store: ContactStore;
  beforeEach(() => {
    store = createContactStore(db);
  });

  it('`observe` contributes a derived name + email_alias for a new contact', () => {
    const rec = store.observe({
      email: 'bob@example.com',
      name: 'Bob Smith',
      source: 'email_from',
      event_at: 777,
    });
    const id = rec.contact_id!;

    expect(nameOf(store, id)).toMatchObject({
      value: 'Bob Smith',
      source: 'derived',
      source_id: CONTACT_SOURCE_ID_DERIVED,
      as_of: 777, // the EVENT time, not the ingestion clock (D-120 bistemporal)
    });
    expect(aliasOf(store, id, 'email_alias')).toMatchObject({
      alias_pattern: 'bob@example.com',
      source: 'derived',
    });
    expect(rec.name).toBe('Bob Smith');
    expect(rec.projection_provenance?.name?.source).toBe('derived');
  });

  // ── The provenance-laundering regression ─────────────────────────────────
  it('editing ONE field does not re-attribute the others to the user', () => {
    // The trap the old hand-rolled preserve-merge walked straight into. It read
    // every unsupplied field back out of the row and re-wrote it — which, under a
    // contribution model, would re-assert a HubSpot-sourced company as a `manual`
    // one. The company would then sit at the TOP of the ladder, outranking every
    // future HubSpot correction, forever — because the user changed a phone number.
    const created = store.upsertManual({ email: 'bob@example.com', name: 'Bob' });
    const id = created.contact_id!;
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme Corporation',
      source: 'vendor_meta', source_id: 'hubspot.prod.contact',
    });
    store.materializeContactProjection(id);
    expect(store.get('bob@example.com')?.company).toBe('Acme Corporation');

    // The user edits the PHONE, and only the phone.
    const after = store.upsertManual({ email: 'bob@example.com', phone: '+16175550100' });

    expect(after.phone).toBe('+16175550100');
    // The company is preserved (the D-138 behaviour) …
    expect(after.company).toBe('Acme Corporation');
    // … and it is STILL HubSpot's, not laundered into the user's own word.
    expect(after.projection_provenance?.org).toEqual({
      source: 'vendor_meta',
      source_id: 'hubspot.prod.contact',
      // D-205 — the entry now also carries the winner's `as_of` + `confidence`
      // (the ladder's two tiebreakers below the rung). The claim under test is
      // unchanged: the RUNG and the INSTANCE are still HubSpot's.
      as_of: expect.any(Number),
      confidence: expect.any(Number),
    });
    // Exactly one org contribution exists — the user did not silently mint a
    // second, stronger one by touching an unrelated field.
    expect(store.listContactAttributes(id, 'org')).toHaveLength(1);
  });

  it('`upsertManual` contributes what IS supplied, at `manual`', () => {
    const rec = store.upsertManual({
      email: 'bob@example.com',
      name: 'Bob Smith',
      phone: '+16175550100',
      company: 'Acme',
      mailing_address: { address1: '1 main street', city: 'boston', state: 'MA', zip: '02101', country: 'US' },
    });
    const id = rec.contact_id!;

    expect(rec.name).toBe('Bob Smith');
    expect(rec.company).toBe('Acme');
    expect(rec.phone).toBe('+16175550100');
    expect(rec.projection_provenance?.org?.source).toBe('manual');
    expect(rec.projection_provenance?.phone?.source_id).toBe(CONTACT_SOURCE_ID_MANUAL);
    expect(aliasOf(store, id, 'email_alias')).toMatchObject({ source: 'manual' });
    // D-138's blocking keys still land — they are recomputed from the projection.
    const row = db
      .prepare('SELECT name_key, company_norm FROM contacts WHERE contact_id = ?')
      .get(id) as { name_key: string | null; company_norm: string | null };
    expect(row.name_key).toBeTruthy();
    expect(row.company_norm).toContain('acme');
  });

  it('a contact created with no name gets a `derived` fallback, not a `manual` one', () => {
    const rec = store.upsertManual({ email: 'rsmith@example.com' });
    const id = rec.contact_id!;
    expect(rec.name).toBe('rsmith');
    expect(nameOf(store, id)).toMatchObject({ value: 'rsmith', source: 'derived' });

    // So the first real name to arrive wins — which it could not have done if the
    // placeholder had been recorded as something the user typed.
    store.upsertContactAttribute({
      contact_id: id, kind: 'name', value: 'Roberta Smith',
      source: 'contact_book', source_id: 'google.personal.contact',
    });
    expect(store.materializeContactProjection(id)?.name).toBe('Roberta Smith');
  });

  it('promotion gives a mention_only contact its first real email_alias', () => {
    const stub = store.createMentionOnlyContact({ name: 'Mom' });
    const id = stub.contact_id!;
    const synthetic = stub.email;
    // ⛔ THE RULE STILL HOLDS AT CREATION. The synthetic `mention-only-…@_recued.invalid`
    // placeholder is a PK filler, not an address — `createMentionOnlyContact` must NOT seed
    // the globally-unique email index with it. Unchanged by D-205.
    expect(store.listContactAliases(id, 'email_alias')).toHaveLength(0);
    expect(nameOf(store, id)).toMatchObject({ value: 'Mom', source: 'manual' });

    store.promoteMentionOnlyToVerified({ contact_id: id, email: 'mary@gmail.com' });

    // 🔑 D-205 — but PROMOTION is a different act, and it now retains the retired synthetic
    // as a REDIRECT. The rule above is about an address that was never anyone's; by the time
    // we promote, the synthetic WAS this contact's address of record and stored references
    // genuinely hold it (`assigned_contact_id`, `canonical_email`, `annotation.target_id` —
    // all of which hold an EMAIL). Retaining it records a historical fact; dropping it left
    // every one of those references pointing at nothing. So there are TWO email_aliases now:
    // the real address, and the retired one that redirects to it.
    const emails = store.listContactAliases(id, 'email_alias');
    expect(emails).toHaveLength(2);

    // The REAL address is the one that isn't a placeholder. ⚠ Any surface that lists "this
    // contact's email addresses" MUST filter with `isMentionOnlyEmail` — that predicate is
    // exactly why it exists.
    const real = emails.filter((a) => !isMentionOnlyEmail(a.alias_pattern));
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ alias_pattern: 'mary@gmail.com', source: 'manual' });

    // And the retired one is present + identifiable — it is the redirect, not an address.
    expect(emails.some((a) => a.alias_pattern === synthetic)).toBe(true);

    expect(store.get('mary@gmail.com')?.name).toBe('Mom');
    // The whole point: the dead address still resolves to her.
    expect(store.resolveCanonicalEmail(synthetic).canonical_email).toBe('mary@gmail.com');
  });

  it('a SPLIT restores the fields the merge blanked — a D-138 bug C-2 fixes free', () => {
    const bob = store.upsertManual({
      email: 'bob@example.com', name: 'Bob', phone: '+16175550100', company: 'Acme',
    });
    const survivor = store.upsertManual({ email: 'robert@example.com', name: 'Robert' });
    const loser = store.get('bob@example.com')!;

    store.setMergedInto([loser], survivor.email, 2_000);
    const tombstoned = store.get('bob@example.com');
    expect(tombstoned?.merged_into).toBe('robert@example.com');
    // Tombstoned: columns blanked, and the stale per-field provenance goes with
    // them (a tombstone must not keep ASSERTING where its now-absent company came
    // from).
    expect(tombstoned?.company).toBeUndefined();
    expect(tombstoned?.phone).toBeUndefined();
    expect(tombstoned?.projection_provenance).toBeUndefined();
    // …but the CONTRIBUTIONS survive. Nothing was destroyed.
    expect(store.listContactAttributes(bob.contact_id!, 'org')).toHaveLength(1);

    // Undo the merge.
    store.setMergedInto([tombstoned!], null, 3_000);
    const restored = store.get('bob@example.com');

    // Pre-C-2 the split cleared `merged_into` and NOTHING ever refilled these —
    // an undone merge left the contact permanently stripped of its own fields.
    expect(restored?.merged_into).toBeUndefined();
    expect(restored?.company).toBe('Acme');
    expect(restored?.phone).toBe('+16175550100');
    expect(restored?.projection_provenance?.org?.source).toBe('manual');
  });

  // ── Review folds ─────────────────────────────────────────────────────────
  it('an empty phone / company is NOT SUPPLIED — it does not throw, and it does not gag a vendor', () => {
    // Before the fold this threw `alias_pattern_empty` out of the `contact.upsert`
    // rpc as a 500: `upsertContactAlias` rejects an empty `alias_pattern`, and the
    // pre-C-2 code had happily written `''` straight into the column.
    const rec = store.upsertManual({ email: 'bob@example.com', name: 'Bob', phone: '' });
    expect(rec.phone).toBeUndefined();
    expect(store.listContactAliases(rec.contact_id!, 'phone_alias')).toHaveLength(0);

    // And the company case, which is nastier than a crash. `company: ''` would mint
    // a `manual` org contribution holding an empty string — TOP of the ladder, and
    // it projects to NULL through the shape guard. The user's company would appear
    // to clear, and every future HubSpot sync would be silently outranked by the
    // empty string, forever.
    store.upsertContactAttribute({
      contact_id: rec.contact_id!, kind: 'org', value: 'Acme Corporation',
      source: 'vendor_meta', source_id: 'hubspot.prod.contact',
    });
    store.materializeContactProjection(rec.contact_id!);
    const after = store.upsertManual({ email: 'bob@example.com', company: '   ' });
    expect(after.company).toBe('Acme Corporation');
    expect(store.listContactAttributes(rec.contact_id!, 'org')).toHaveLength(1);
  });

  it('is ATOMIC — a rejected contribution leaves NO half-built contact behind', () => {
    // `upsertManual` is no longer one UPDATE: it is an insert, up to four
    // contribution writes, and a materialize. Without a transaction, a rejection
    // part-way through left a contact row on disk carrying SOME of its contributions
    // and NO projection — a contact whose columns disagree with its own
    // contributions, the exact split-brain this substrate exists to prevent.
    //
    // A malformed `mailing_address` is the rejection: `upsertContactAttribute`
    // JSON-stringifies the value, and a circular object throws there — AFTER the row,
    // its `email_alias` and its `name` contribution have all been written.
    const circular: Record<string, unknown> = { address1: '1 main street' };
    circular.self = circular;

    expect(() =>
      store.upsertManual({
        email: 'bob@example.com',
        name: 'Bob',
        mailing_address: circular as never,
      }),
    ).toThrow(/[Cc]ircular/);

    // Rolled back whole. Not a row, not an alias, not a stray name.
    expect(store.get('bob@example.com')).toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM contact_attribute').get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM contact_alias').get(),
    ).toEqual({ n: 0 });
  });

  it('deleting a contact cascades its contributions — no orphaned personal data', () => {
    const rec = store.upsertManual({
      email: 'bob@example.com', name: 'Bob', company: 'Acme', phone: '+16175550100',
    });
    const id = rec.contact_id!;
    store.upsertContactSourceBlob({
      contact_id: id, source_id: 'hubspot.work.contact', vendor: 'hubspot', remote_id: 'r1',
      blob: { email: 'bob@example.com' }, snapshot_hash: 'h1',
    });
    expect(store.listContactAttributes(id).length).toBeGreaterThan(0);

    expect(store.delete('bob@example.com')).toBe(true);

    // On a substrate whose premise is that personal data stays local and REMOVABLE,
    // a delete that silently retains the person's employer and mailing address is a
    // defect, not an untidiness.
    expect(store.listContactAttributes(id)).toHaveLength(0);
    expect(store.listContactAliases(id)).toHaveLength(0);
    expect(store.listContactSourceBlobs(id)).toHaveLength(0);
  });
});
