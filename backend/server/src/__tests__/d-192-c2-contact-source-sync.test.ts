/** D-192 C-2 slice 6 — `runContactSourceSync` (the `contact_import` posture).
 *
 *  Driven through the REAL contact store against real SQLite. Only the vendor IO
 *  (the list leaf) is stubbed — the projection, the C-2a ladder, the address space,
 *  the unique indexes and the merge machinery are all live. A mocked store would
 *  assert nothing about the invariants that actually matter here, every one of which
 *  lives in the substrate: what the ladder does with a CRM rung, what the alias index
 *  does with a contested address, what the delete diff does to a blocking key.
 *
 *  The two blocks that carry the slice are `the supplies promise` (a leaf that
 *  forgets a kind must fail LOUDLY, not drain a column) and `deletes`
 *  (absence-based tombstoning is fail-closed, and it must NEVER withdraw an
 *  identifier).
 *
 *  Spec: D-192 step 6. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getContactSourceDeclaration,
  type ContactSourceDeclaration,
} from '@recued/contracts';

import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import {
  createContactSourceSyncStateStore,
  ensureContactSourceSyncStateSchema,
  type ContactSourceSyncStateStore,
} from '../storage/contact-source-sync-state.js';
import {
  runContactSourceSync,
  type ContactSourceListFn,
  type ContactSourceListOutcome,
  type ContactSourceRecord,
} from '../contact-source-sync.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;
/** The REAL state store over the same SQLite — the runner records its own health, so
 *  a mock here would assert nothing about the thing under test (D-205 item #1). */
let syncState: ContactSourceSyncStateStore;

const SOURCE_ID = 'hubspot.work.contact';
/** The real shipped declaration — hubspot supplies email+phone / name+org+address. */
const HUBSPOT = getContactSourceDeclaration('hubspot') as ContactSourceDeclaration;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-source-sync-'));
  db = new Database(join(dir, 'test.db'));
  store = createContactStore(db);
  ensureContactSourceSyncStateSchema(db);
  syncState = createContactSourceSyncStateStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Mint a real local contact from warehouse traffic (the `derived` rung) — the
 *  person a CRM record will be matched AGAINST. */
const seedContact = (email: string, name = 'Seed'): string => {
  store.observe({ email, name, source: 'email_from', event_at: 1_000 });
  const contact_id = store.get(email)?.contact_id;
  if (!contact_id) throw new Error('seed contact has no contact_id');
  return contact_id;
};

/** A well-formed HubSpot record: every promised kind present, `null`/`[]` for
 *  "the leaf looked and found none". Overrides merge shallowly. */
const record = (over: Partial<ContactSourceRecord> = {}): ContactSourceRecord => ({
  remote_id: 'hs_1',
  as_of: 5_000,
  raw: { properties: { email: 'bob@example.com' } },
  aliases: { email_alias: ['bob@example.com'], phone_alias: [] },
  attributes: { name: 'Robert Smith', org: 'Acme', address: null },
  ...over,
});

/** A leaf that returns exactly these records, claiming a complete walk. */
const leafOf = (
  records: ContactSourceRecord[],
  complete = true,
): ContactSourceListFn => async (): Promise<ContactSourceListOutcome> =>
  ({ ok: true, records, complete });

const run = (leaf: ContactSourceListFn, declaration = HUBSPOT) =>
  runContactSourceSync(
    { store, syncState, listContacts: leaf, now: () => 10_000 },
    { source_id: SOURCE_ID, connection_name: 'work', declaration },
  );

// ────────────────────────────────────────────────────────────────

describe('D-192 C-2 slice 6 — the supplies promise (the anti-silence device)', () => {
  it('FAILS a record whose leaf never looked for a promised kind', async () => {
    // The headline invariant. HubSpot's declaration promises `address`. A leaf that
    // omits the KEY entirely never looked — and that is exactly the regression this
    // mechanism exists to catch, because its symptom is invisible: `address` feeds
    // D-138's `address_zip_country_key`, and a MISSING blocking key produces NO
    // match rather than a wrong one, so the merge detector silently stops seeing
    // duplicates. Nobody would get an exception. So we manufacture one.
    seedContact('bob@example.com');
    const noAddress = record({ attributes: { name: 'Robert', org: 'Acme' } });

    const res = await run(leafOf([noAddress]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.failed_rows).toBe(1);
    expect(res.hydrated).toBe(0);
    // Nothing was contributed — the record is refused whole, not partially applied.
    expect(store.listContactAttributes(store.get('bob@example.com')!.contact_id!)
      .some((a) => a.source_id === SOURCE_ID)).toBe(false);
  });

  it('ACCEPTS an explicit null — "I looked; this record has none"', async () => {
    // The distinction the whole mechanism turns on: `in` vs truthiness. Without it,
    // "this contact has no address" and "this leaf has forgotten how to read
    // addresses" are the same observation.
    seedContact('bob@example.com');

    const res = await run(leafOf([record({ attributes: { name: 'R', org: 'Acme', address: null } })]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.failed_rows).toBe(0);
    expect(res.hydrated).toBe(1);
  });

  it('FAILS a record supplying a kind the declaration does NOT cover', async () => {
    // The other direction: a leaf producing `title` under a declaration that never
    // promised it means the declaration is stale, and the user's understanding of
    // what this Source writes is wrong.
    seedContact('bob@example.com');
    const withTitle = record({
      attributes: { name: 'R', org: 'Acme', address: null, title: 'VP' },
    });

    const res = await run(leafOf([withTitle]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.failed_rows).toBe(1);
  });

  it('a forgetful leaf fails EVERY record — the failure is total, not a slow drain', async () => {
    seedContact('bob@example.com');
    seedContact('ann@example.com');
    const broken = (id: string, email: string): ContactSourceRecord =>
      record({ remote_id: id, aliases: { email_alias: [email], phone_alias: [] },
        attributes: { name: 'X', org: 'Y' } }); // no `address` key

    const res = await run(leafOf([broken('a', 'bob@example.com'), broken('b', 'ann@example.com')]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.failed_rows).toBe(2);
    expect(res.hydrated).toBe(0);
  });
});

describe('D-192 C-2 slice 6 — hydrate_on_match', () => {
  it('SKIPS a stranger — a CRM is mostly people you do not know', async () => {
    const res = await run(leafOf([record({
      aliases: { email_alias: ['stranger@nowhere.com'], phone_alias: [] },
    })]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skipped).toBe(1);
    expect(res.hydrated).toBe(0);
    // And it minted nobody — importing a 10k-row CRM would drown the contact graph.
    expect(store.get('stranger@nowhere.com')).toBeNull();
  });

  it('matches through the SLICE-4 ADDRESS SPACE — a secondary alias, not just the PK', async () => {
    // Bob's row is keyed `bob@home.com`; his work address is a secondary alias. A CRM
    // record carrying only the work address IS Bob. Asking "does a contacts row have
    // this PK?" would have missed him.
    const bob = seedContact('bob@home.com');
    store.upsertContactAlias({
      contact_id: bob, kind: 'email_alias', alias_pattern: 'bob@work.com',
      source: 'derived', source_id: 'recued.derived',
    });

    const res = await run(leafOf([record({
      aliases: { email_alias: ['bob@work.com'], phone_alias: [] },
      attributes: { name: 'Robert Smith', org: 'Acme', address: null },
    })]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hydrated).toBe(1);
    expect(store.get('bob@home.com')?.company).toBe('Acme');
  });

  it('projects the CRM contribution onto the contact, with its provenance', async () => {
    seedContact('bob@example.com');

    await run(leafOf([record()]));

    const bob = store.get('bob@example.com')!;
    expect(bob.company).toBe('Acme');
    // The `derived` name from mail traffic loses to the CRM's `vendor_meta` — a
    // curated record outranks a header-scraped one.
    expect(bob.name).toBe('Robert Smith');
    const attrs = store.listContactAttributes(bob.contact_id!);
    const org = attrs.find((a) => a.kind === 'org');
    expect(org?.source).toBe('vendor_meta');
    expect(org?.source_id).toBe(SOURCE_ID);
  });

  it('a CRM import NEVER outranks a hand edit', async () => {
    // The structural guarantee `CONTACT_IMPORT_RUNGS` encodes, proved through the
    // REAL ladder rather than asserted at the type level.
    store.upsertManual({ email: 'bob@example.com', name: 'Bob (I typed this)', company: 'MyCo' });

    await run(leafOf([record()]));

    const bob = store.get('bob@example.com')!;
    expect(bob.name).toBe('Bob (I typed this)');
    expect(bob.company).toBe('MyCo');
    // The CRM's view still EXISTS — it is recorded, just outranked. Storing only the
    // winner would throw the evidence away the moment the manual edit is withdrawn.
    expect(
      store.listContactAttributes(bob.contact_id!).some(
        (a) => a.source_id === SOURCE_ID && a.value === 'Acme',
      ),
    ).toBe(true);
  });
});

describe('D-192 C-2 slice 6 — the incremental seam', () => {
  it('hash-skips an unchanged re-list — no re-write, no re-materialize', async () => {
    seedContact('bob@example.com');
    await run(leafOf([record()]));

    const second = await run(leafOf([record()]));

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.unchanged).toBe(1);
    expect(second.hydrated).toBe(0);
  });

  it('re-hydrates when the canonical contribution set actually changed', async () => {
    seedContact('bob@example.com');
    await run(leafOf([record()]));

    const moved = record({ attributes: { name: 'Robert Smith', org: 'Globex', address: null } });
    const second = await run(leafOf([moved]));

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.hydrated).toBe(1);
    expect(store.get('bob@example.com')?.company).toBe('Globex');
  });
});

describe('D-205 §1 — a vendor delete DISCONNECTS; it withdraws nothing', () => {
  /** Hydrate Bob from one HubSpot record, then hand back his contact_id. */
  const hydrateBob = async (): Promise<string> => {
    const bob = seedContact('bob@example.com');
    await run(leafOf([record()]));
    return bob;
  };

  it('KEEPS everything the Source contributed when its record vanished', async () => {
    // 🔴 The inversion. This shipped doing the exact opposite — a vendor-plane
    // deletion cascaded into a core-plane DATA WITHDRAWAL, and it fired *only* on
    // contacts that had a core record to damage (an unmatched record never enters
    // `contact_source_blob` at all).
    //
    // The ruling: after import the Recued contact is ONE OF the sources of truth.
    // HubSpot deleting *their* copy is not a retraction of what Recued learned, and
    // `as_of` already carries the historical truth — "HubSpot asserted, as of <date>,
    // that Bob works at Acme". So the delete cuts the LINKAGE and nothing else.
    const bob = await hydrateBob();
    expect(store.get('bob@example.com')?.company).toBe('Acme');
    expect(store.lookupPlatformLink('hubspot', 'hs_1')).toBe('bob@example.com');

    const res = await run(leafOf([])); // complete walk, record gone

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.disconnected).toBe(1);

    // Bob keeps what he learned. Both the projection and the contribution behind it.
    expect(store.get('bob@example.com')?.company).toBe('Acme');
    expect(
      store.listContactAttributes(bob).some((a) => a.source_id === SOURCE_ID),
    ).toBe(true);

    // The ONE thing that goes: the link. It said "this person IS HubSpot record
    // hs_1", and that record no longer exists — a fact that stopped being true, not
    // a fact we are forgetting.
    expect(store.lookupPlatformLink('hubspot', 'hs_1')).toBeNull();
  });

  it('SOFT-MARKS the blob — the claim stands, so the receipt must too', async () => {
    // The blob is the EVIDENCE behind a contribution that now stands on its own.
    // Hard-deleting it would keep the claim and destroy the receipt, and the contact
    // detail page's provenance ("org: Acme — from HubSpot") would have nothing to
    // point at.
    await hydrateBob();

    await run(leafOf([]));

    const blob = store.getContactSourceBlob(SOURCE_ID, 'hs_1');
    expect(blob).not.toBeNull();
    expect(blob?.disconnected_at).toBe(10_000); // the injected `now`
    // And it still carries the raw payload the claim was derived from.
    expect(blob?.blob).toEqual({ properties: { email: 'bob@example.com' } });
  });

  it('does NOT re-fire on an already-disconnected record, cycle after cycle', async () => {
    // The soft mark's second job. A disconnected row that stayed in the hash map
    // would look "prior but not polled" to the absence diff on EVERY subsequent
    // cycle — re-unlinking, re-counting, forever.
    await hydrateBob();
    const first = await run(leafOf([]));
    expect(first.ok && first.disconnected).toBe(1);

    const second = await run(leafOf([]));
    const third = await run(leafOf([]));

    expect(second.ok && second.disconnected).toBe(0);
    expect(third.ok && third.disconnected).toBe(0);
  });

  it('RE-CONNECTS a record that comes back — the mark clears', async () => {
    // Undeleted upstream (or restored from the vendor's trash). The blob is still
    // there, so the record is re-hydrated and re-linked, and the mark is cleared —
    // without which it would be omitted from the hash map forever, and therefore
    // re-contributed on every single cycle.
    await hydrateBob();
    await run(leafOf([]));
    expect(store.getContactSourceBlob(SOURCE_ID, 'hs_1')?.disconnected_at).toBe(10_000);

    const res = await run(leafOf([record()]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hydrated).toBe(1);
    expect(store.getContactSourceBlob(SOURCE_ID, 'hs_1')?.disconnected_at).toBeNull();
    expect(store.lookupPlatformLink('hubspot', 'hs_1')).toBe('bob@example.com');

    // And the NEXT cycle hash-skips it again — it is fully back in the normal seam.
    const after = await run(leafOf([record()]));
    expect(after.ok && after.unchanged).toBe(1);
  });

  it('NEVER withdraws an email alias — an address that reached Bob still reaches Bob', async () => {
    // The identity guard, and the reason the delete path is attributes-only.
    // `contact_alias` is keyed on the VALUE per contact — ONE row per address,
    // stamped with whichever source currently outranks. Bob's `bob@example.com` was
    // first DERIVED from his mail and then PROMOTED to `vendor_meta` when HubSpot
    // asserted it too. Withdrawing "HubSpot's aliases" would delete the address his
    // mail traffic discovered, and Bob would stop resolving entirely.
    await hydrateBob();

    await run(leafOf([])); // the CRM record is deleted

    // He is still reachable at his own address.
    expect(store.get('bob@example.com')).not.toBeNull();
    expect(store.resolveCanonicalEmail('bob@example.com').canonical_email)
      .toBe('bob@example.com');
  });

  it('an INCOMPLETE walk disconnects NOTHING — absence proves nothing (D-190)', async () => {
    await hydrateBob();

    const res = await run(leafOf([], /* complete */ false));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.disconnected).toBe(0);
    expect(store.lookupPlatformLink('hubspot', 'hs_1')).toBe('bob@example.com');
    expect(store.get('bob@example.com')?.company).toBe('Acme');
  });

  it('an UNKEYABLE record fail-closes the whole absence diff', async () => {
    // A record we could not key is a record we cannot prove absent — so if ANY row
    // is unkeyable we suppress ALL disconnects this cycle, exactly as the file family
    // does.
    await hydrateBob();

    const res = await run(leafOf([record({ remote_id: '' })]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.unkeyable).toBe(1);
    expect(res.disconnected).toBe(0);
    expect(store.lookupPlatformLink('hubspot', 'hs_1')).toBe('bob@example.com');
  });

  it('re-elects the surviving SIBLING as the Source’s best record (the same cycle)', async () => {
    // The `resettled` re-election, and why the hash-skip must be invalidated for a
    // contact whose record set MOVED. Two HubSpot records for Bob (Salesforce and
    // Pipedrive both permit duplicate contacts). The fresher one wins, so the Source's
    // ONE contribution row for Bob — the key is `(contact_id, kind, source_id)` —
    // holds 'NewCo'.
    //
    // When that record is deleted, nothing is withdrawn (D-205 §1) — but the surviving
    // record is now this Source's best record for Bob, and it says 'OldCo'. It is
    // UNCHANGED, so a naive hash-skip would skip it and the row would keep quoting
    // 'NewCo' — a record HubSpot no longer has — while the record it DOES have says
    // otherwise. Provenance that lies. So the survivor RE-ASSERTS in the same cycle.
    seedContact('bob@example.com');
    const older = record({
      remote_id: 'hs_old', as_of: 1_000,
      attributes: { name: 'Bob Smith', org: 'OldCo', address: null },
    });
    const fresher = record({
      remote_id: 'hs_new', as_of: 9_000,
      attributes: { name: 'Robert Smith', org: 'NewCo', address: null },
    });

    const first = await run(leafOf([older, fresher]));
    expect(first.ok && first.ambiguous).toBe(1);
    expect(store.get('bob@example.com')?.company).toBe('NewCo');

    // The fresher record is deleted upstream; only the older survives.
    const second = await run(leafOf([older]));

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.disconnected).toBe(1);
    // Bob is NOT left blank, and he is NOT left quoting the departed record — the
    // survivor re-asserted in the same cycle.
    expect(store.get('bob@example.com')?.company).toBe('OldCo');
  });
});

describe('D-192 C-2 slice 6 — duplicate remote records for one person', () => {
  it('picks the FRESHEST deterministically — the projection must not flicker', async () => {
    // Contributions are keyed `(contact_id, kind, source_id)` — one row per Source —
    // so two records of one Source would overwrite each other and whichever the vendor
    // returned LAST would win. Across cycles the projection would FLICKER, which is
    // worse than being wrong: a wrong value is at least reproducible.
    seedContact('bob@example.com');
    const a = record({ remote_id: 'hs_a', as_of: 1_000,
      attributes: { name: 'A', org: 'AlphaCo', address: null } });
    const b = record({ remote_id: 'hs_b', as_of: 9_000,
      attributes: { name: 'B', org: 'BetaCo', address: null } });

    await run(leafOf([a, b]));
    expect(store.get('bob@example.com')?.company).toBe('BetaCo');

    // The SAME answer with the vendor's page order reversed — the winner cannot
    // depend on which page a record landed on. A whole fresh database, so the second
    // walk cannot ride any state the first one left behind.
    db.close();
    dir = mkdtempSync(join(tmpdir(), 'contact-source-sync-'));
    db = new Database(join(dir, 'test.db'));
    store = createContactStore(db);
    ensureContactSourceSyncStateSchema(db);
    syncState = createContactSourceSyncStateStore(db);
    seedContact('bob@example.com');

    await run(leafOf([b, a]));
    expect(store.get('bob@example.com')?.company).toBe('BetaCo');
  });
});

describe('D-192 C-2 slice 6 — the contested address', () => {
  it('counts a contested email as CONFLICTED — a merge signal, never a theft', async () => {
    // The CRM says an address we hold for SOMEONE ELSE belongs to this person. That
    // is the strongest merge signal there is — but it is not licence to move an
    // identifier off its current owner behind the user's back.
    seedContact('bob@example.com');
    const ann = seedContact('ann@example.com');

    const res = await run(leafOf([record({
      // Matches Bob by his own address, but ALSO claims Ann's.
      aliases: { email_alias: ['bob@example.com', 'ann@example.com'], phone_alias: [] },
    })]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.conflicted).toBe(1);
    // Not fatal — Bob still hydrated.
    expect(res.hydrated).toBe(1);
    expect(store.get('bob@example.com')?.company).toBe('Acme');
    // And Ann still owns her own address.
    expect(store.resolveCanonicalEmail('ann@example.com').canonical_email)
      .toBe('ann@example.com');
    expect(store.get('ann@example.com')?.contact_id).toBe(ann);
  });
});

describe('D-192 C-2 slice 6 — fail-closed guards', () => {
  it('REFUSES to run when the join key is not backed by the vendor entity', async () => {
    // Unbacked, hydration matches ZERO contacts forever without ever erroring —
    // indistinguishable from "the CRM had no matches". So it must refuse to run
    // rather than run and report success over nothing.
    const bogus: ContactSourceDeclaration = { ...HUBSPOT, vendor_entity: 'deal' };
    const leaf = vi.fn(leafOf([record()]));

    const res = await run(leaf, bogus);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('config');
    expect(res.reason).toMatch(/failed its vendor binding/);
    // And it never even called the vendor.
    expect(leaf).not.toHaveBeenCalled();
  });

  it('REFUSES full_import at a rung it cannot ATTRIBUTE — it will not improvise', async () => {
    // ⚠ D-205 #4b — this test used to pin "full_import is not implemented at all".
    // It is implemented now (`d-205-full-import-sync.test.ts` covers the positive
    // case end to end). What SURVIVES, and is the sharper invariant, is the reason
    // it was refused in the first place: a CREATED row must be attributable.
    //
    // `contacts.source` needs a `ContactSource`, and only `contact_book` has one —
    // a CRM rung has none, because no CRM is `full_import` (a 10k-row CRM is mostly
    // strangers; that is the whole posture). The two improvisations available both
    // corrupt: `manual` would park a vendor's assertion at the TOP of the C-2a
    // ladder where the user's own typing could never correct it, and `derived`
    // would claim Recued pulled it out of warehouse traffic it never saw.
    //
    // So a `vendor_meta` Source declaring `full_import` refuses the cycle — and,
    // critically, refuses it BEFORE the leaf is ever called.
    const crmThatWantsToCreate: ContactSourceDeclaration = {
      ...HUBSPOT, // rung: 'vendor_meta'
      import_scope: 'full_import',
    };
    const leaf = vi.fn(leafOf([record()]));

    const res = await run(leaf, crmThatWantsToCreate);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('config');
    expect(res.reason).toMatch(/no ContactSource to stamp/i);
    expect(leaf).not.toHaveBeenCalled();
  });

  it('surfaces a leaf failure as a recorded outcome, not a throw', async () => {
    const failing: ContactSourceListFn = async () =>
      ({ ok: false, kind: 'config', reason: 'no credential' });

    const res = await run(failing);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('config');
  });

  it('REFUSES a join key it cannot resolve, rather than skipping it', async () => {
    // `phone_alias` is a legal `match_on` kind and the vendor binding passes it
    // (hubspot.contact declares a projectable `phone`), but this runner has no
    // phone→contact resolver. Skipping it quietly would produce a cycle reporting
    // `ok: true` with every record counted as a miss — hydrating ZERO contacts
    // forever, indistinguishable from "the CRM had no matches". The exact silent
    // failure every other guard in this file exists to prevent, arriving by the one
    // door left open.
    const phoneKeyed: ContactSourceDeclaration = { ...HUBSPOT, match_on: ['phone_alias'] };
    const leaf = vi.fn(leafOf([record()]));

    const res = await run(leaf, phoneKeyed);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('config');
    expect(res.reason).toMatch(/no resolver/);
    expect(leaf).not.toHaveBeenCalled();
  });
});

describe('D-192 C-2 slice 6 — a failed write is RETRIED, not buried', () => {
  it('does not advance the hash of a record whose write failed', async () => {
    // The retry guard. The blob carries the snapshot_hash, so mirroring a record whose
    // contribution write FAILED would make the next cycle see it as `unchanged`,
    // hash-skip it, and never try again — one degraded cycle, then a clean
    // `unchanged: 1` forever while the data is simply missing. A transient error would
    // become PERMANENT and INVISIBLE.
    //
    // Spying on the one store method IS the IO here — the behaviour under test is the
    // runner's retry decision, and a transient storage failure is exactly what it must
    // survive.
    seedContact('bob@example.com');
    const spy = vi
      .spyOn(store, 'upsertContactAttribute')
      .mockImplementationOnce(() => { throw new Error('disk hiccup'); });

    const first = await run(leafOf([record()]));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.failed_rows).toBe(1);
    expect(first.hydrated).toBe(0);
    // The blob was NOT mirrored — its hash must stay unknown, or the retry is lost.
    expect(store.getContactSourceBlob(SOURCE_ID, 'hs_1')).toBeNull();

    // The hiccup passes; the SAME unchanged record must be RE-ATTEMPTED, not skipped.
    spy.mockRestore();
    const second = await run(leafOf([record()]));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.unchanged).toBe(0);
    expect(second.hydrated).toBe(1);
    expect(store.get('bob@example.com')?.company).toBe('Acme');
  });

  it('an UNHASHABLE record fails alone — it must not abort the cycle', async () => {
    // The hash walks the record's own structure, so a leaf emitting something
    // pathological throws BEFORE any downstream try/catch. Unguarded, one bad record
    // would take the whole cycle down — and a housekeeping throw is reserved for
    // programming errors, not for a vendor payload we did not like.
    seedContact('bob@example.com');
    seedContact('ann@example.com');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const res = await run(leafOf([
      record({ remote_id: 'bad', attributes: { name: 'X', org: cyclic, address: null } }),
      record({ remote_id: 'good', aliases: { email_alias: ['ann@example.com'], phone_alias: [] } }),
    ]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.failed_rows).toBe(1);
    // The other contact still landed.
    expect(res.hydrated).toBe(1);
    expect(store.get('ann@example.com')?.company).toBe('Acme');
  });
});

describe('D-205 §1 — a re-pointed record: connect the new, keep the old', () => {
  it('gives the NEW contact the contributions and leaves the OLD one intact', async () => {
    // 🔴 The second inversion. The record still EXISTS, so the absence diff never sees
    // it — it simply points at a different person now (its email was edited upstream).
    // This path used to WITHDRAW the Source's contributions from the old contact, on
    // the reasoning that Bob should not keep a company from a record that no longer
    // refers to him.
    //
    // The ruling is the reverse, and it is the same rule as the delete: disconnect
    // from the old, connect to the new. What Bob learned is Bob's — `as_of` carries
    // when HubSpot asserted it, and a vendor re-assigning a record is not a retraction.
    const bob = seedContact('bob@example.com');
    const ann = seedContact('ann@example.com');

    await run(leafOf([record()])); // hs_1 → Bob
    expect(store.get('bob@example.com')?.company).toBe('Acme');

    // Someone re-assigns hs_1 to Ann upstream. SAME remote_id.
    const moved = record({
      aliases: { email_alias: ['ann@example.com'], phone_alias: [] },
      attributes: { name: 'Ann Smith', org: 'Globex', address: null },
    });
    const res = await run(leafOf([moved]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repointed).toBe(1);

    // Ann now carries it — and the mirror row followed her.
    expect(store.get('ann@example.com')?.company).toBe('Globex');
    expect(
      store.listContactAttributes(ann).some((a) => a.source_id === SOURCE_ID),
    ).toBe(true);
    expect(store.getContactSourceBlob(SOURCE_ID, 'hs_1')?.contact_id).toBe(ann);

    // ...and Bob KEEPS what he learned. Not blanked, not re-projected to null.
    expect(store.get('bob@example.com')?.company).toBe('Acme');
    expect(
      store.listContactAttributes(bob).some((a) => a.source_id === SOURCE_ID),
    ).toBe(true);
  });

  it('follows a LOCAL MERGE — a re-point whose payload never changed', async () => {
    // The case the hash-skip alone cannot see, and the reason `changed` is
    // destination-aware rather than payload-only.
    //
    // Nothing about the vendor record moves here. Bob is merged into Ann LOCALLY, so
    // `resolveCanonicalEmail` now resolves his address to HER — and hs_1, byte for
    // byte identical, suddenly belongs to a different contact. A payload-only
    // hash-skip would call it `unchanged`, skip it, and Ann would never receive the
    // contributions while the mirror row kept pointing at the tombstone — with the
    // re-point re-detecting, and re-doing nothing, every cycle forever.
    const bob = seedContact('bob@example.com');
    const ann = seedContact('ann@example.com');

    await run(leafOf([record()])); // hs_1 → Bob
    expect(store.getContactSourceBlob(SOURCE_ID, 'hs_1')?.contact_id).toBe(bob);

    // The D-138 merge: Bob is absorbed into Ann. Nothing moves — an edge is recorded.
    store.setMergedInto([store.get('bob@example.com')!], 'ann@example.com', 20_000);

    // The SAME record, unchanged. Its destination is what moved.
    const res = await run(leafOf([record()]));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repointed).toBe(1);
    expect(res.unchanged).toBe(0); // NOT hash-skipped — the destination moved
    expect(res.hydrated).toBe(1);
    // The mirror follows the survivor, so the next cycle is a clean hash-skip rather
    // than a re-point that never converges.
    expect(store.getContactSourceBlob(SOURCE_ID, 'hs_1')?.contact_id).toBe(ann);

    const after = await run(leafOf([record()]));
    expect(after.ok && after.repointed).toBe(0);
    expect(after.ok && after.unchanged).toBe(1);
  });
});

describe('D-205 item #1 — the cycle is RECORDED, not returned into the void', () => {
  // The runner's counts used to go NOWHERE: the housekeeping step `await`ed the
  // result and discarded it whole, while its own comment claimed "a failed / degraded
  // cycle is a RECORDED outcome." So a leaf that forgot a promised field failed EVERY
  // record on EVERY cycle, forever, and the only observable effect was that contacts
  // quietly stopped gaining addresses. These tests are the "somebody is listening".

  it('records a CLEAN cycle — success bumps, no error, counts persisted', async () => {
    seedContact('bob@example.com');

    await run(leafOf([record()]));

    const state = syncState.get(SOURCE_ID);
    expect(state?.degraded).toBe(false);
    expect(state?.last_success_at).toBe(10_000);
    expect(state?.last_sync_started_at).toBe(10_000);
    expect(state?.last_error_code).toBeNull();
    expect(state?.last_cycle?.hydrated).toBe(1);
    expect(state?.last_cycle?.failed_rows).toBe(0);
    expect(state?.last_cycle?.complete).toBe(true);
  });

  it('🔴 a leaf that FORGOT a promised kind degrades the Source — with the reason', async () => {
    // THE headline. HubSpot's declaration promises `address`; a leaf that stops
    // emitting the key fails every record. Before this the cycle returned
    // `ok: true, failed_rows: 2` and nobody ever saw it: no error, no log, no state.
    // The only symptom was `address_zip_country_key` draining to NULL, which makes the
    // merge detector stop finding duplicates — a feature silently ceasing to work.
    seedContact('bob@example.com');
    seedContact('ann@example.com');
    const forgetful = (id: string, email: string): ContactSourceRecord =>
      record({
        remote_id: id,
        aliases: { email_alias: [email], phone_alias: [] },
        attributes: { name: 'X', org: 'Y' }, // no `address` key — never looked
      });

    const res = await run(leafOf([
      forgetful('a', 'bob@example.com'),
      forgetful('b', 'ann@example.com'),
    ]));

    expect(res.ok && res.failed_rows).toBe(2);

    const state = syncState.get(SOURCE_ID);
    expect(state?.degraded).toBe(true);
    expect(state?.last_error_code).toBe('records_failed');
    // A count says something broke. The SAMPLE says WHAT — and the runner has always
    // collected these and then dropped them on the floor.
    expect(state?.last_error_message).toMatch(/2 record\(s\) failed/);
    expect(state?.last_error_message).toMatch(/attributes\.address promised by the declaration/);
    // The counts of a DEGRADED cycle are kept — they are the diagnosis.
    expect(state?.last_cycle?.failed_rows).toBe(2);
    expect(state?.last_cycle?.hydrated).toBe(0);
  });

  it('a degraded cycle does NOT bump last_success_at — it reads stale however recently it ran', async () => {
    // The freshness contract. A Source that runs every idle window and fails every
    // record must not look fresh just because it ran.
    seedContact('bob@example.com');
    await run(leafOf([record()]));
    expect(syncState.get(SOURCE_ID)?.last_success_at).toBe(10_000);

    const broken = record({ attributes: { name: 'X', org: 'Y' } }); // forgot `address`
    await run(leafOf([broken]));

    const state = syncState.get(SOURCE_ID);
    expect(state?.degraded).toBe(true);
    // Still the FIRST cycle's success — the broken one earned nothing.
    expect(state?.last_success_at).toBe(10_000);
    expect(state?.last_sync_completed_at).toBe(10_000);
  });

  it('an UNKEYABLE record degrades — it silently suppressed the delete diff', async () => {
    seedContact('bob@example.com');

    await run(leafOf([record(), record({ remote_id: '' })]));

    const state = syncState.get(SOURCE_ID);
    expect(state?.degraded).toBe(true);
    expect(state?.last_error_code).toBe('records_unkeyed');
    expect(state?.last_error_message).toMatch(/deletes suppressed/);
  });

  it('a MIRROR failure degrades — it would re-hydrate everything, every cycle, forever', async () => {
    // The runner counts `mirror_failed` precisely because a systematically failing
    // mirror makes every cycle re-derive from scratch while reporting success. Counting
    // it and then discarding the count achieved nothing.
    seedContact('bob@example.com');
    vi.spyOn(store, 'upsertContactSourceBlob').mockImplementation(() => {
      throw new Error('disk full');
    });

    const res = await run(leafOf([record()]));

    expect(res.ok && res.mirror_failed).toBe(1);
    const state = syncState.get(SOURCE_ID);
    expect(state?.degraded).toBe(true);
    expect(state?.last_error_code).toBe('mirror_failed');
  });

  it('RECOVERS — a clean cycle after a degraded one clears the flags', async () => {
    seedContact('bob@example.com');
    await run(leafOf([record({ attributes: { name: 'X', org: 'Y' } })])); // broken
    expect(syncState.get(SOURCE_ID)?.degraded).toBe(true);

    await run(leafOf([record()])); // the leaf is fixed

    const state = syncState.get(SOURCE_ID);
    expect(state?.degraded).toBe(false);
    expect(state?.last_error_code).toBeNull();
    expect(state?.last_error_message).toBeNull();
    expect(state?.last_success_at).toBe(10_000);
  });

  it('records a REFUSED cycle — the fail-closed guards were shouting at nobody', async () => {
    // The four config guards (unbacked join key / unresolvable match_on / unimplemented
    // full_import / leaf failure) each refuse the cycle to avoid a silent zero-import —
    // and then handed the reason to a caller that dropped it. The refusal is the whole
    // point; it has to land somewhere.
    const phoneKeyed: ContactSourceDeclaration = { ...HUBSPOT, match_on: ['phone_alias'] };

    const res = await run(leafOf([record()]), phoneKeyed);

    expect(res.ok).toBe(false);
    const state = syncState.get(SOURCE_ID);
    expect(state?.degraded).toBe(true);
    expect(state?.last_error_code).toBe('config');
    expect(state?.last_error_message).toMatch(/no resolver/);
    // A refused cycle never WALKED, so it has no counts — and it must not pretend to.
    expect(state?.last_cycle).toBeNull();
  });

  it('a refusal does not BLANK the counts of the last cycle that actually walked', async () => {
    // A credential expires and the leaf starts refusing. The last real cycle's counts
    // are the most recent thing anyone knows about this Source — losing them on every
    // subsequent refusal would throw away the diagnosis at the moment it is wanted.
    seedContact('bob@example.com');
    await run(leafOf([record()]));
    expect(syncState.get(SOURCE_ID)?.last_cycle?.hydrated).toBe(1);

    const failing: ContactSourceListFn = async () =>
      ({ ok: false, kind: 'config', reason: 'no credential' });
    await run(failing);

    const state = syncState.get(SOURCE_ID);
    expect(state?.degraded).toBe(true);
    expect(state?.last_error_code).toBe('config');
    // Still there.
    expect(state?.last_cycle?.hydrated).toBe(1);
  });

  it('an INCOMPLETE walk is RECORDED but is NOT degradation', async () => {
    // `complete: false` means the leaf could not prove it saw everything — for the CRM
    // leaf, an empty mirror: cold, purged, or a CRM with genuinely no contacts. The
    // runner cannot tell those apart from the inside, so claiming a health verdict it
    // cannot prove would be a false alarm on every cold start (and would feed
    // `partial_api_failure` into the AI-context omission decision). Record the fact;
    // do not editorialize it.
    const res = await run(leafOf([], /* complete */ false));

    expect(res.ok).toBe(true);
    const state = syncState.get(SOURCE_ID);
    expect(state?.degraded).toBe(false);
    expect(state?.last_cycle?.complete).toBe(false);
  });
});
