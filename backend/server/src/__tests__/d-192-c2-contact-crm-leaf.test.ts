/** D-192 C-2 slice 7 — the CRM contact leaf + the link that never existed.
 *
 *  Driven through the REAL crm_record_mirror and the REAL contact store against real
 *  SQLite — no mocks anywhere. The invariants under test all live in the substrate:
 *  what a CAPPED read does to a delete diff, what an EMPTY mirror proves, and whether
 *  a CRM record ever actually reaches `data.contact`.
 *
 *  The headline is `the uncapped read`. `mirror.list()` clamps to 200 because it
 *  feeds a bounded chat surface; reusing it here would make every contact past the
 *  200th look ABSENT from a walk claiming to be complete, and the sync would tear out
 *  their CRM contributions. Silently, and with nothing failing. That test seeds 250.
 *
 *  Spec: `docs/d-192-contact-source-family.md` step 7. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeConnectionTargetIdPrefix,
  composePlatformRecordTargetId,
  composeVendorEntityScope,
  getContactSourceDeclaration,
  type ContactSourceDeclaration,
  type EnrichmentMeta,
} from '@recued/contracts';

import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';
import {
  createContactSourceSyncStateStore,
  ensureContactSourceSyncStateSchema,
  type ContactSourceSyncStateStore,
} from '../storage/contact-source-sync-state.js';
import { buildCrmMirrorContactLeaf } from '../contact-source-adapters/crm-mirror-leaf.js';
import { runContactSourceSync } from '../contact-source-sync.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;
let mirror: CrmRecordMirrorStore;
/** The REAL state store over the same SQLite (D-205 item #1) — the runner records its
 *  own health, so a stub would hide the very thing under test. */
let syncState: ContactSourceSyncStateStore;

const CONN = 'work';
const SOURCE_ID = `hubspot.${CONN}.contact`;
const HUBSPOT = getContactSourceDeclaration('hubspot') as ContactSourceDeclaration;
const SALESFORCE = getContactSourceDeclaration('salesforce') as ContactSourceDeclaration;
const PIPEDRIVE = getContactSourceDeclaration('pipedrive') as ContactSourceDeclaration;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-crm-leaf-'));
  db = new Database(join(dir, 'test.db'));
  store = createContactStore(db);
  ensureCrmRecordMirrorSchema(db);
  mirror = createCrmRecordMirrorStore(db);
  ensureContactSourceSyncStateSchema(db);
  syncState = createContactSourceSyncStateStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Mirror one CRM contact exactly as the reconcilers do — connection-qualified
 *  target_id, canonical `EnrichmentMeta`. */
const mirrorContact = (
  nativeId: string,
  /** Partial so a test states only the canonical fields it cares about — the two
   *  reconciler stamps (`snapshot_at` / `snapshot_hash`) are defaulted below and
   *  remain overridable. */
  meta: Partial<EnrichmentMeta>,
  opts: { vendor?: string; entity?: string; connection?: string } = {},
): string => {
  const vendor = opts.vendor ?? 'hubspot';
  const entity = opts.entity ?? 'contact';
  const connection = opts.connection ?? CONN;
  const target_id = composePlatformRecordTargetId(vendor, entity, connection, nativeId);
  mirror.upsert({
    scope: composeVendorEntityScope(vendor, entity),
    target_id,
    meta: { snapshot_at: 5_000, snapshot_hash: `h_${nativeId}`, ...meta },
    now: 5_000,
  });
  return target_id;
};

const seedContact = (email: string): string => {
  store.observe({ email, name: 'Seed', source: 'email_from', event_at: 1_000 });
  const contact_id = store.get(email)?.contact_id;
  if (!contact_id) throw new Error('seed contact has no contact_id');
  return contact_id;
};

const leaf = () => buildCrmMirrorContactLeaf({ mirror });

const callLeaf = (declaration = HUBSPOT, connection = CONN) =>
  leaf()({
    source_id: SOURCE_ID,
    connection_name: connection,
    vendor: declaration.vendor,
    declaration,
  });

const sync = (declaration = HUBSPOT) =>
  runContactSourceSync(
    { store, syncState, listContacts: leaf(), now: () => 10_000 },
    { source_id: SOURCE_ID, connection_name: CONN, declaration },
  );

// ────────────────────────────────────────────────────────────────

describe('D-192 C-2 slice 7 — the uncapped read (the catastrophe this guards)', () => {
  it('walks ALL 250 mirrored contacts — `list()` would have stopped at 200', async () => {
    // `mirror.list()` clamps to MIRROR_MAX_LIMIT (200) because it feeds a bounded
    // CHAT surface, where returning fewer rows is simply a smaller answer. Here the
    // consumer is a walk whose ABSENCE-BASED delete diff is gated on a completeness
    // proof — so an under-returning read is not a smaller answer, it is a silent MASS
    // WITHDRAWAL. Nothing would fail; the data would just quietly go.
    for (let i = 0; i < 250; i++) {
      mirrorContact(`hs_${i}`, { email: `person${i}@example.com`, name: `Person ${i}` });
    }

    const outcome = await callLeaf();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records).toHaveLength(250);
    expect(outcome.complete).toBe(true);
  });

  it('a second cycle over 250 contacts DELETES NOTHING — the regression, end to end', async () => {
    // The bug in its real shape. With a capped read, cycle 2 would see only 200 of
    // the 250 mirrored records, the other 50 would look ABSENT from a "complete" walk,
    // and their CRM contributions would be withdrawn — 50 people silently stripped.
    for (let i = 0; i < 250; i++) {
      seedContact(`person${i}@example.com`);
      mirrorContact(`hs_${i}`, {
        email: `person${i}@example.com`, name: `Person ${i}`, company: 'Acme',
      });
    }

    const first = await sync();
    expect(first.ok && first.hydrated).toBe(250);

    const second = await sync();

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.disconnected).toBe(0);
    expect(second.unchanged).toBe(250);
    // And the 201st person still carries her CRM company.
    expect(store.get('person222@example.com')?.company).toBe('Acme');
  });
});

describe('D-192 C-2 slice 7 — the completeness proof, fail-closed', () => {
  it('an EMPTY mirror proves NOTHING — cold and purged look like "no contacts"', async () => {
    // A cold mirror (the reconciler has not run yet) and a purged one (the CRM
    // connection was torn down) are indistinguishable from a CRM with no contacts.
    // Acting on that ambiguity would withdraw every CRM contribution the warehouse
    // holds, so zero rows ⇒ not complete ⇒ zero deletes.
    const outcome = await callLeaf();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records).toHaveLength(0);
    expect(outcome.complete).toBe(false);
  });

  it('so a purged mirror does NOT strip an already-hydrated contact', async () => {
    seedContact('bob@example.com');
    mirrorContact('hs_1', { email: 'bob@example.com', name: 'Robert', company: 'Acme' });
    await sync();
    expect(store.get('bob@example.com')?.company).toBe('Acme');

    // The CRM connection is torn down; its mirror rows go.
    mirror.deleteForConnection(
      composeVendorEntityScope('hubspot', 'contact'),
      composeConnectionTargetIdPrefix('hubspot', 'contact', CONN),
    );

    const res = await sync();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.complete).toBe(false);
    expect(res.disconnected).toBe(0);
    // Bob keeps what he had. Withdrawing imported data is the user's explicit
    // Source-teardown decision, never an inference from an empty table.
    expect(store.get('bob@example.com')?.company).toBe('Acme');
  });

  it('is CONNECTION-scoped — one connection never sees another’s records', async () => {
    // The mirror scope is shared across a vendor's connections. A whole-scope read
    // would hand connection A the records of connection B, and A's delete diff would
    // then find every one of them "absent".
    mirrorContact('hs_1', { email: 'a@example.com' }, { connection: 'work' });
    mirrorContact('hs_2', { email: 'b@example.com' }, { connection: 'personal' });

    const work = await callLeaf(HUBSPOT, 'work');
    const personal = await callLeaf(HUBSPOT, 'personal');

    expect(work.ok && work.records).toHaveLength(1);
    expect(personal.ok && personal.records).toHaveLength(1);
    if (!work.ok || !personal.ok) return;
    expect(work.records[0]?.remote_id).toBe('hubspot_contact_work_hs_1');
    expect(personal.records[0]?.remote_id).toBe('hubspot_contact_personal_hs_2');
  });
});

describe('D-192 C-2 slice 7 — the leaf keeps each vendor’s supplies promise', () => {
  it('hubspot supplies name + org + address, each as an explicit key', async () => {
    mirrorContact('hs_1', {
      email: 'bob@example.com',
      name: 'Robert Smith',
      phone: '+16175550100',
      company: 'Acme',
      mailing_address: {
        address1: '1 Main St', city: 'Boston', state: 'MA', zip: '02101', country: 'US',
      },
    });

    const outcome = await callLeaf(HUBSPOT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const rec = outcome.records[0]!;
    expect(rec.aliases).toEqual({
      email_alias: ['bob@example.com'],
      phone_alias: ['+16175550100'],
    });
    expect(rec.attributes.name).toBe('Robert Smith');
    expect(rec.attributes.org).toBe('Acme');
    // The structured address the RECONCILER composed — the mapping the vendor
    // registry does not have (its `mailing_address` meta-field is a phantom).
    expect(rec.attributes.address).toMatchObject({ zip: '02101', city: 'Boston' });
  });

  it('an absent value is an explicit null / [], NEVER a missing key', async () => {
    // The distinction the whole `supplies` mechanism turns on. A contact with no
    // company must say `org: null` ("I looked; none"), not omit the key — which would
    // mean "this leaf never looks at companies" and fail the record.
    mirrorContact('hs_1', { email: 'bob@example.com', name: 'Bob' });

    const outcome = await callLeaf(HUBSPOT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const rec = outcome.records[0]!;
    expect('org' in rec.attributes).toBe(true);
    expect(rec.attributes.org).toBeNull();
    expect('address' in rec.attributes).toBe(true);
    expect(rec.attributes.address).toBeNull();
    expect('phone_alias' in rec.aliases).toBe(true);
    expect(rec.aliases.phone_alias).toEqual([]);
    // And the runner accepts it — an explicit absence is a real answer.
    seedContact('bob@example.com');
    const res = await sync();
    expect(res.ok && res.failed_rows).toBe(0);
    expect(res.ok && res.hydrated).toBe(1);
  });

  it('salesforce supplies NO org — a SF Contact has no Company field', async () => {
    mirrorContact('sf_1',
      { email: 'ann@example.com', name: 'Ann', company: 'IGNORED' },
      { vendor: 'salesforce' });

    const outcome = await leaf()({
      source_id: `salesforce.${CONN}.contact`,
      connection_name: CONN,
      vendor: 'salesforce',
      declaration: SALESFORCE,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Not merely absent — the key is NOT THERE, because the declaration never
    // promised it. A supplied-but-undeclared kind would FAIL the record at the runner.
    expect('org' in outcome.records[0]!.attributes).toBe(false);
    expect('address' in outcome.records[0]!.attributes).toBe(true);
  });

  it('pipedrive supplies name only — its generic reconciler projects no address', async () => {
    // Pipedrive rides D-190's GENERIC reconciler, whose projection comes from
    // `entityFieldsFromRegistry` — which SKIPS `mailing_address` (the phantom
    // meta-field: declared `type: 'object'` with neither a source_path nor a
    // derivation). So it genuinely cannot supply an address, and its declaration
    // says so.
    mirrorContact('pd_1',
      { email: 'ann@example.com', name: 'Ann' },
      { vendor: 'pipedrive', entity: 'person' });

    const outcome = await leaf()({
      source_id: `pipedrive.${CONN}.contact`,
      connection_name: CONN,
      vendor: 'pipedrive',
      declaration: PIPEDRIVE,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.records[0]!.attributes)).toEqual(['name']);
  });
});

describe('D-192 C-2 slice 7 — the CRM link (the half that never existed)', () => {
  it('LINKS the contact to its platform record — linked_by was never written before', async () => {
    // `PlatformIdEntry.linked_by` has documented `'auto:email_match'` since D-138 and
    // NOTHING has ever written it. `resolveCompanyForDomain` is fully built with zero
    // production callers, because nothing ever linked a contact to a CRM record for it
    // to resolve from. This is that write.
    seedContact('bob@example.com');
    mirrorContact('hs_47291', { email: 'bob@example.com', name: 'Robert', company: 'Acme' });

    const res = await sync();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.linked).toBe(1);

    const bob = store.get('bob@example.com')!;
    const link = bob.platform_ids?.[0];
    expect(link?.vendor).toBe('hubspot');
    // The CONNECTION-QUALIFIED target id — so two portals of one vendor cannot
    // collide on the link's `(vendor, platform_id)` key.
    expect(link?.platform_id).toBe('hubspot_contact_work_hs_47291');
    expect(link?.state).toBe('auto');
  });

  it('resolves the contact FROM the platform id — the reverse lookup now has data', async () => {
    seedContact('bob@example.com');
    mirrorContact('hs_47291', { email: 'bob@example.com', name: 'Robert' });

    await sync();

    expect(store.lookupPlatformLink('hubspot', 'hubspot_contact_work_hs_47291'))
      .toBe('bob@example.com');
  });

  it('links EVERY matched record, including a dedupe loser', async () => {
    // A link is a cross-reference, not a contribution, so it cannot conflict. A
    // duplicate CRM record for one person (Salesforce and Pipedrive both permit them)
    // genuinely IS that person, and the D-138 surfaces that reconcile the two need to
    // be able to find it. Only the CONTRIBUTIONS dedupe.
    seedContact('bob@example.com');
    mirrorContact('hs_old', { email: 'bob@example.com', name: 'Bob', company: 'OldCo' });
    mirrorContact('hs_new', { email: 'bob@example.com', name: 'Robert', company: 'NewCo' });

    const res = await sync();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ambiguous).toBe(1); // one lost the contribution tiebreak…
    expect(res.linked).toBe(2); // …but BOTH are linked.
    expect(store.lookupPlatformLink('hubspot', 'hubspot_contact_work_hs_old'))
      .toBe('bob@example.com');
    expect(store.lookupPlatformLink('hubspot', 'hubspot_contact_work_hs_new'))
      .toBe('bob@example.com');
  });

  it('UNLINKS a deleted CRM record — and withdraws NOTHING (D-205 §1)', async () => {
    // The D-205 ruling, end to end through the REAL leaf and the REAL mirror: a
    // vendor deleting their record cuts the linkage and does nothing else.
    seedContact('bob@example.com');
    seedContact('ann@example.com'); // keeps the mirror non-empty so the walk is complete
    mirrorContact('hs_1', { email: 'bob@example.com', name: 'Robert' });
    mirrorContact('hs_2', { email: 'ann@example.com', name: 'Ann' });
    await sync();
    expect(store.lookupPlatformLink('hubspot', 'hubspot_contact_work_hs_1')).toBe('bob@example.com');
    // HubSpot's `vendor_meta` name outranks the `derived` one his mail traffic gave.
    expect(store.get('bob@example.com')?.name).toBe('Robert');

    // Bob's CRM record is deleted upstream; the reconciler drops its mirror row.
    mirror.deleteForSource(
      composeVendorEntityScope('hubspot', 'contact'),
      'hubspot_contact_work_hs_1',
    );

    const res = await sync();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.disconnected).toBe(1);
    // The link is gone — it said "this person IS HubSpot record 1", and that record no
    // longer exists. A fact that stopped being true, not one we are forgetting.
    expect(store.lookupPlatformLink('hubspot', 'hubspot_contact_work_hs_1')).toBeNull();
    // But everything Recued LEARNED from that record stays. HubSpot deleting their
    // copy is not a retraction; after import the core contact is one of the sources
    // of truth. This assertion was `not.toBeNull()` while the shipped code was
    // silently blanking him back to 'Seed'.
    expect(store.get('bob@example.com')?.name).toBe('Robert');
  });
});

describe('D-192 C-2 slice 7 — end to end: a CRM record reaches data.contact', () => {
  it('hydrates name + company + address onto a contact known only from mail', async () => {
    // The whole arc, in one test. Before slice 7 this path was entirely dead: no
    // reconciler touched the contact store, so a CRM contact neither hydrated NOR
    // linked, and every one of these assertions would have been false.
    seedContact('bob@example.com'); // known only from a mail From header (rung: derived)
    expect(store.get('bob@example.com')?.company).toBeFalsy();

    mirrorContact('hs_47291', {
      email: 'bob@example.com',
      name: 'Robert Smith',
      phone: '+16175550100',
      company: 'Acme Corp',
      mailing_address: {
        address1: '1 Main St', city: 'Boston', state: 'MA', zip: '02101', country: 'US',
      },
    });

    const res = await sync();
    expect(res.ok && res.hydrated).toBe(1);

    const bob = store.get('bob@example.com')!;
    // The CRM's curated view outranks the header-scraped one (`vendor_meta` beats
    // `derived`), field by field, through the one C-2a ladder.
    expect(bob.name).toBe('Robert Smith');
    expect(bob.company).toBe('Acme Corp');
    expect(bob.mailing_address?.zip).toBe('02101');
    expect(bob.phone).toBe('+16175550100');
    // With per-field provenance, and a link back to the record that said so.
    const org = store.listContactAttributes(bob.contact_id!).find((a) => a.kind === 'org');
    expect(org?.source).toBe('vendor_meta');
    expect(org?.source_id).toBe(SOURCE_ID);
    expect(bob.platform_ids?.[0]?.platform_id).toBe('hubspot_contact_work_hs_47291');
  });
});
