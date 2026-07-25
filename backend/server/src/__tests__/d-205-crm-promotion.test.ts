/** D-205 #5 — selective CRM promotion, and the provenance hole it exposed.
 *
 *  ## The cliff
 *  A CRM is `hydrate_on_match`: a record matching no local contact is SKIPPED, never
 *  created. Right posture — a 10k-row CRM is your COMPANY's list, mostly strangers.
 *  But on an EMPTY graph it mints **zero** contacts: connect HubSpot with ten
 *  thousand records and `#data/contact` stays empty. Correct, and it reads as broken.
 *
 *  The strangers are already on disk (the reconcilers mirror every CRM contact
 *  regardless), and the sync already COUNTS them. So this is a PICKER, not an import.
 *
 *  ## The hole it exposed, which is the sharper half of this slice
 *  `createImportedContact` writes the identity and DELIBERATELY no contributions — the
 *  Source's write pass owns those, at its own rung with its own id. That leaves
 *  `projection_provenance` NULL for a moment… and the C-2 cutover backfill identifies
 *  pre-C-2 rows by exactly `projection_provenance IS NULL`.
 *
 *  So the backfill could grab a freshly-minted imported row and write its `name` at
 *  `derived` / `recued.derived` — **Recued claiming it pulled out of a mail header a
 *  name that HubSpot asserted.** An import never predates contributions; it is
 *  post-C-2 by construction, and the guard now says so. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTACT_IMPORT_ROW_SOURCES,
  composeConnectionTargetIdPrefix,
  composeVendorEntityScope,
  contactSourceToContributionRung,
} from '@recued/contracts';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';
import { makeContactImportHandlers } from '../contact-import-handler.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;
let mirror: CrmRecordMirrorStore;

const SOURCE_ID = 'hubspot.work.contact';
const SCOPE = composeVendorEntityScope('hubspot', 'contact');
const PREFIX = composeConnectionTargetIdPrefix('hubspot', 'contact', 'work');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-205-promo-'));
  db = new Database(join(dir, 'test.db'));
  store = createContactStore(db);
  ensureCrmRecordMirrorSchema(db);
  mirror = createCrmRecordMirrorStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A CRM record, as the reconcilers mirror it: the canonical `EnrichmentMeta`,
 *  inside the snapshot envelope the mirror validates on write. */
const crmRecord = (id: string, meta: Record<string, unknown>): string => {
  const target_id = `${PREFIX}${id}`;
  mirror.upsert({
    scope: SCOPE as never,
    target_id,
    meta: { ...meta, snapshot_at: 1_000, snapshot_hash: `h_${id}` } as never,
    now: 1_000,
  });
  return target_id;
};

const rpc = () => {
  const slice = makeContactImportHandlers({ store, mirror, now: () => 5_000 });
  if (slice === undefined) throw new Error('no slice');
  return slice.handlers;
};

const candidates = async (args: Record<string, unknown> = {}) =>
  (await rpc()['contact.import.candidates']!(
    { source_id: SOURCE_ID, ...args } as never,
    undefined as never,
  )) as { candidates: readonly { target_id: string; email: string; name?: string }[]; total: number; mirrored: number };

const promote = async (target_ids: readonly string[]) =>
  (await rpc()['contact.import.promote']!(
    { source_id: SOURCE_ID, target_ids } as never,
    undefined as never,
  )) as { created: number; already_known: number; failures: readonly string[] };

describe('D-205 #5 — the strangers are already on disk', () => {
  it('lists the people Recued does NOT know, and counts the ones it does', async () => {
    // Recued knows Bob from mail. It has never heard of Carol or Dave.
    store.observe({ email: 'bob@acme.com', name: 'Bob', source: 'email_from', event_at: 1 });
    crmRecord('hs_1', { email: 'bob@acme.com', name: 'Bob Smith' });
    crmRecord('hs_2', { email: 'carol@acme.com', name: 'Carol Jones', company: 'Acme' });
    crmRecord('hs_3', { email: 'dave@acme.com', name: 'Dave Lee' });

    const out = await candidates();
    expect(out.mirrored).toBe(3); // every record the CRM mirrors
    expect(out.total).toBe(2); // …minus the one person you have corresponded with
    expect(out.candidates.map((c) => c.email)).toEqual(['carol@acme.com', 'dave@acme.com']);
  });

  it('🔑 the STRANGER TEST rides the ADDRESS SPACE, not a naive email lookup', async () => {
    // Recued knows Bob as bob@home.com. HubSpot has him as bob@work.com — an address
    // the contact ALSO answers to (an import attached it as an `email_alias`).
    //
    // A naive `store.get(crmEmail)` would call him a stranger and offer to create his
    // duplicate. The stranger test must resolve through the same address space the
    // sync's match does.
    const bob = store.observe({
      email: 'bob@home.com',
      name: 'Bob',
      source: 'email_from',
      event_at: 1,
    });
    store.upsertContactAlias({
      contact_id: bob.contact_id!,
      kind: 'email_alias',
      alias_pattern: 'bob@work.com',
      source: 'vendor_meta',
      source_id: SOURCE_ID,
    });
    crmRecord('hs_1', { email: 'bob@work.com', name: 'Bob Smith' });

    const out = await candidates();
    expect(out.mirrored).toBe(1);
    expect(out.total).toBe(0); // ← NOT a stranger. Recued knows him.
  });

  it('a record with no usable email is not offered — identity resolves on the address', async () => {
    crmRecord('hs_1', { name: 'Nameless Corp Contact' }); // no email
    crmRecord('hs_2', { email: 'carol@acme.com', name: 'Carol' });

    const out = await candidates();
    expect(out.mirrored).toBe(2);
    expect(out.total).toBe(1); // filtered, not offered-then-refused
    expect(out.candidates[0]!.email).toBe('carol@acme.com');
  });

  it('searches by name / email / company — all three, independently', async () => {
    crmRecord('hs_1', { email: 'carol@acme.com', name: 'Carol Jones', company: 'Acme Inc' });
    crmRecord('hs_2', { email: 'dave@globex.com', name: 'Dave Lee', company: 'Globex' });
    // 🔑 Erin's COMPANY is Acme but her address is not — the only row that proves the
    // company field is searched at all. Without her, "acme" would match on email alone
    // and a company-blind search would pass. [[feedback_fixture_value_coincidence_masks_field_confusion]]
    crmRecord('hs_3', { email: 'erin@personal.example', name: 'Erin Fox', company: 'Acme Inc' });

    expect((await candidates({ query: 'globex' })).total).toBe(1); // company only
    expect((await candidates({ query: 'carol' })).total).toBe(1); // name only
    expect((await candidates({ query: 'personal.example' })).total).toBe(1); // email only
    // Carol (email + company) and Erin (company alone).
    expect((await candidates({ query: 'acme' })).total).toBe(2);
  });

  it('⛔ a CONTACT BOOK has no strangers — full_import already took everyone', async () => {
    const out = (await rpc()['contact.import.candidates']!(
      { source_id: 'google.personal.contact' } as never,
      undefined as never,
    )) as { total: number; mirrored: number };
    expect(out.total).toBe(0);
    expect(out.mirrored).toBe(0);
  });
});

describe('D-205 #5 — promotion mints an IDENTITY, not a fact', () => {
  it('creates the contact, stamped crm_import — and writes NO contributions', async () => {
    const t = crmRecord('hs_2', { email: 'carol@acme.com', name: 'Carol Jones', company: 'Acme' });

    const out = await promote([t]);
    expect(out.created).toBe(1);
    expect(out.failures).toEqual([]);

    const carol = store.get('carol@acme.com');
    expect(carol).not.toBeNull();
    expect(carol!.source).toBe('crm_import');
    expect(carol!.name).toBe('Carol Jones');

    // 🔑 NOTHING is contributed here. The Source's next cycle now MATCHES her and
    // hydrates every field at `vendor_meta`, carrying its own `source_id`. This path
    // has no `source_id` to attribute anything TO, so anything it wrote would lie.
    expect(store.listContactAttributes(carol!.contact_id!)).toEqual([]);
    expect(carol!.company).toBeUndefined(); // not yet — the sync owns that
  });

  it('🔑 `crm_import` maps to the CRM rung, NOT to manual', () => {
    // The user chose the PERSON. They did not type the person's phone number.
    // Stamping `manual` would park the CRM's assertions at the TOP of the C-2a ladder
    // where the user's own typing could never correct them.
    expect(contactSourceToContributionRung('crm_import')).toBe('vendor_meta');
    expect(contactSourceToContributionRung('crm_import')).not.toBe('manual');
  });

  it('re-checks the stranger test at the ACT site — a race is counted, not an error', async () => {
    const t = crmRecord('hs_2', { email: 'carol@acme.com', name: 'Carol Jones' });

    // Between the user seeing the list and clicking add, Carol emailed them — so the
    // mail stack already minted her. Re-creating would duplicate someone Recued knows.
    store.observe({ email: 'carol@acme.com', name: 'Carol', source: 'email_from', event_at: 2 });

    const out = await promote([t]);
    expect(out.created).toBe(0);
    expect(out.already_known).toBe(1);
    expect(out.failures).toEqual([]);
    expect(store.list({ limit: 10 })).toHaveLength(1);
  });

  it('⛔ the SERVER decides what a target_id means — a client cannot mint a phantom', async () => {
    // The client sends an ID. A client-supplied name/email would let a caller mint a
    // contact that exists in no CRM at all — stamped `crm_import`, i.e. carrying the
    // CRM's authority.
    const out = await promote([`${PREFIX}hs_does_not_exist`]);
    expect(out.created).toBe(0);
    expect(out.failures[0]).toMatch(/no such record/i);
    expect(store.list({ limit: 10 })).toHaveLength(0);
  });
});

describe('D-205 #5 — 🔑 the C-2 cutover backfill must NEVER launder an import', () => {
  /** The cutover is an idempotent convergence pass that runs inside
   *  `createContactStore` — so re-creating the store over the same database IS a
   *  reboot. That is what these tests do: they exercise the STORE's guard, not a
   *  copy of its SQL. (My first pass at them re-implemented the WHERE clause in the
   *  test, which would have passed happily with the guard deleted.) */
  const reboot = (): ContactStore => createContactStore(db);

  it('an imported row survives a BOOT with its provenance intact', () => {
    // `createImportedContact` writes the identity and no contributions, so
    // `projection_provenance` is NULL — which is EXACTLY how the cutover identifies a
    // pre-C-2 row. Boot inside that window and, without the guard, it writes the name
    // at `derived` / `recued.derived`: Recued claiming it pulled out of a mail header
    // a name that HubSpot asserted.
    const carol = store.createImportedContact({
      email: 'carol@acme.com',
      name: 'Carol Jones',
      source: 'crm_import',
    });
    expect(
      (
        db
          .prepare('SELECT projection_provenance AS p FROM contacts WHERE contact_id = ?')
          .get(carol.contact_id!) as { p: string | null }
      ).p,
    ).toBeNull(); // the window is real…

    reboot(); // …the cutover runs…

    // …and touches NOTHING. An import never predates contributions; the Source that
    // created it owns every value on it, and it will contribute them at `vendor_meta`
    // carrying its own id.
    expect(store.listContactAttributes(carol.contact_id!)).toEqual([]);
  });

  it('…but a genuinely pre-C-2 row IS still converged — the guard did not disarm the pass', () => {
    // The mirror image, and the reason this is a GUARD and not a deletion: a row from
    // before the contribution substrate must still be picked up. A test that only
    // proved "the import is skipped" would pass just as happily against a backfill
    // that had been turned off entirely. [[feedback_retire_obsolete_sweep_repoint_core]]
    db.prepare(
      `INSERT INTO contacts (email, name, first_seen, last_interaction, interaction_count,
                             source, created_at, updated_at, platform_ids, rejected_pairs, contact_id)
       VALUES ('legacy@x.com', 'Legacy Person', 1, 1, 1, 'email_from', 1, 1, '[]', '[]', 'legacy_id')`,
    ).run();

    reboot();

    const converged = store.listContactAttributes('legacy_id');
    expect(converged.length).toBeGreaterThan(0);
    const name = converged.find((a) => a.kind === 'name');
    expect(name?.value).toBe('Legacy Person');
    // Recued DID derive this one from warehouse traffic — so `derived` is the truth.
    expect(name?.source).toBe('derived');
  });

  it('the two import sources are the ones excluded — and nothing else is', () => {
    expect([...CONTACT_IMPORT_ROW_SOURCES]).toEqual(['contact_book', 'crm_import']);
  });
});
