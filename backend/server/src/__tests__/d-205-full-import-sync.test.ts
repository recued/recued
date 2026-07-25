/** D-205 #4b — `full_import`: the contact-book posture, and the hole underneath it.
 *
 *  ## The bug this pins, and it is the whole slice
 *
 *  "Create the contact on a miss" is what `full_import` means, and taken literally
 *  it is a disaster. `matchLocalContact` resolves `email_alias` and NOTHING else —
 *  it is the only kind with a contact-store resolver. So an entry with **no
 *  address** — the dentist, `{name, phone, address}`, and the entire reason this
 *  posture exists — has nothing to match on and can **never** match. It is a miss
 *  on cycle 1, and a miss on every cycle after, forever.
 *
 *  A create-on-miss that trusted the match alone would therefore mint **a new
 *  dentist every cycle**: one human, fanned across a growing pile of contacts, each
 *  one an identity the user never made and cannot easily undo. The counter
 *  (`created`) would look like a healthy import right up until you scrolled.
 *
 *  So identity resolves in THREE steps, and the ORDER is the design:
 *    1. the ADDRESS wins   — the slice-4 address space, the strongest signal there is
 *    2. the MIRROR re-identifies — `remote_id` is stable, so the mirror row IS the
 *       memory of "this record is already that contact"
 *    3. CREATE             — genuinely new
 *
 *  Plus the lifecycle that closes it: a record that ACQUIRES an address it never had
 *  (the dentist finally emails you) is PROMOTED — the synthetic placeholder is
 *  re-keyed to the real thing. Safe only because a contact's reads now span its whole
 *  address set (D-205 #3.5b); before that, promotion silently orphaned every row
 *  still keyed on the synthetic. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildContactSourceDeclaration,
  type ContactSourceDeclaration,
} from '@recued/contracts';
import {
  createContactStore,
  isMentionOnlyEmail,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  createContactSourceSyncStateStore,
  ensureContactSourceSyncStateSchema,
  type ContactSourceSyncStateStore,
} from '../storage/contact-source-sync-state.js';
import {
  runContactSourceSync,
  type ContactSourceListFn,
  type ContactSourceRecord,
} from '../contact-source-sync.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;
let syncState: ContactSourceSyncStateStore;

const SOURCE_ID = 'google.personal.contact';

/** The contact-book declaration #4c will ship — declared here so the RUNNER can be
 *  tested before the vendor exists. `vendor_entity: null` (a contact book has no
 *  platform record), `full_import`, the `contact_book` rung. */
const GOOGLE: ContactSourceDeclaration = buildContactSourceDeclaration({
  vendor: 'google',
  display_name: 'Google Contacts',
  rung: 'contact_book',
  import_scope: 'full_import',
  vendor_entity: null,
  supplies: {
    aliases: ['email_alias', 'phone_alias'],
    attributes: ['name'],
  },
  match_on: ['email_alias'],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-205-full-import-'));
  db = new Database(join(dir, 'test.db'));
  store = createContactStore(db);
  ensureContactSourceSyncStateSchema(db);
  syncState = createContactSourceSyncStateStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A People record, in the leaf's canonical shape. Every kind the declaration
 *  `supplies` must be PRESENT — `[]` / `null` means "I looked and found none"; a
 *  MISSING key is a hard record failure (the anti-silence promise). */
const rec = (
  remote_id: string,
  opts: { email?: string; phone?: string; name?: string | null; as_of?: number } = {},
): ContactSourceRecord => ({
  remote_id,
  as_of: opts.as_of ?? 1_000,
  raw: { resourceName: remote_id },
  aliases: {
    email_alias: opts.email ? [opts.email] : [],
    phone_alias: opts.phone ? [opts.phone] : [],
  },
  attributes: { name: opts.name === undefined ? 'Dr. Smith' : opts.name },
});

const leafOf =
  (records: readonly ContactSourceRecord[], complete = true): ContactSourceListFn =>
  async () => ({ ok: true, records, complete });

const sync = async (records: readonly ContactSourceRecord[], complete = true) =>
  runContactSourceSync(
    { store, listContacts: leafOf(records, complete), syncState },
    { source_id: SOURCE_ID, connection_name: 'personal', declaration: GOOGLE },
  );

describe('D-205 #4b — full_import creates', () => {
  it('an entry with an ADDRESS creates a verified contact keyed on it', async () => {
    const out = await sync([rec('people/c1', { email: 'bob@example.com', name: 'Bob Smith' })]);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toBe(1);
    expect(out.skipped).toBe(0); // a contact book NEVER skips a stranger

    const bob = store.get('bob@example.com');
    expect(bob?.identity_status).toBe('verified');
    expect(bob?.source).toBe('contact_book');
    expect(bob?.name).toBe('Bob Smith');
    // The name is attributed to the SOURCE, at the contact_book rung — not to
    // Recued, and not to the user.
    expect(bob?.projection_provenance?.name?.source).toBe('contact_book');
    expect(bob?.projection_provenance?.name?.source_id).toBe(SOURCE_ID);
  });

  it('🔑 THE DENTIST — no address, but a phone → a PARTIAL contact', async () => {
    const out = await sync([rec('people/c2', { phone: '+15550100', name: 'Dr. Smith' })]);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toBe(1);

    const all = store.list({ limit: 10 });
    expect(all).toHaveLength(1);
    const dentist = all[0]!;
    expect(dentist.name).toBe('Dr. Smith');
    expect(dentist.identity_status).toBe('partial'); // a phone makes him findable
    expect(isMentionOnlyEmail(dentist.email)).toBe(true); // keyed on a placeholder
    expect(dentist.phone).toBe('+15550100');
  });

  it('an entry Recued ALREADY KNOWS hydrates — it does not create a second row', async () => {
    // Bob emailed you first. The contact book then supplies his org/phone.
    store.observe({ email: 'bob@example.com', name: 'Bob', source: 'email_from', event_at: 1 });

    const out = await sync([
      rec('people/c1', { email: 'bob@example.com', phone: '+15550111', name: 'Bob Smith' }),
    ]);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toBe(0); // ← the graph grows by exactly the people you have not emailed
    expect(out.hydrated).toBe(1);
    expect(store.list({ limit: 10 })).toHaveLength(1);
  });
});

describe('D-205 #4b — 🔑 THE DUPLICATE-DENTIST HOLE', () => {
  it('does NOT re-create the emailless dentist on every cycle', async () => {
    const dentist = rec('people/c2', { phone: '+15550100', name: 'Dr. Smith' });

    const c1 = await sync([dentist]);
    expect(c1.ok && c1.created).toBe(1);

    // Cycle 2. He STILL has no address, so `matchLocalContact` still cannot match
    // him — it resolves `email_alias` and he has none. Without the mirror
    // re-identification this creates him again. And again. And again.
    const c2 = await sync([dentist]);
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    expect(c2.created).toBe(0);
    expect(c2.unchanged).toBe(1); // recognized, and the payload has not moved

    const c3 = await sync([dentist]);
    expect(c3.ok && c3.created).toBe(0);

    // ONE dentist. Not three.
    expect(store.list({ limit: 10 })).toHaveLength(1);
  });

  it('re-identifies through a MERGE — the mirror may point at a tombstone', async () => {
    // The dentist is imported…
    await sync([rec('people/c2', { phone: '+15550100', name: 'Dr. Smith' })]);
    const dentist = store.list({ limit: 10 })[0]!;

    // …and the user merges him into a contact they already had.
    store.observe({ email: 'doc@dental.example', name: 'Dr. Smith', source: 'email_from', event_at: 5 });
    store.setMergedInto([dentist], 'doc@dental.example', 6_000);

    // Next cycle: the mirror still points at the LOSER's contact_id. Writing there
    // would strand every contribution on a dead identity.
    const out = await sync([rec('people/c2', { phone: '+15550100', name: 'Dr. Smith', as_of: 9_000 })]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toBe(0); // resolved THROUGH the chain — no new dentist

    const survivor = store.get('doc@dental.example');
    expect(survivor?.phone).toBe('+15550100'); // the contribution landed on the SURVIVOR
  });
});

describe('D-205 #4b — the dentist finally emails you (PROMOTION)', () => {
  it('re-keys the synthetic placeholder to his real address', async () => {
    await sync([rec('people/c2', { phone: '+15550100', name: 'Dr. Smith' })]);
    const before = store.list({ limit: 10 })[0]!;
    const synthetic = before.email;
    expect(isMentionOnlyEmail(synthetic)).toBe(true);

    // Google now carries his address.
    const out = await sync([
      rec('people/c2', {
        email: 'dr.smith@dental.example',
        phone: '+15550100',
        name: 'Dr. Smith',
        as_of: 9_000,
      }),
    ]);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.promoted).toBe(1);
    expect(out.created).toBe(0); // ← promoted, NOT duplicated

    const after = store.get('dr.smith@dental.example');
    expect(after?.identity_status).toBe('verified');
    expect(after?.contact_id).toBe(before.contact_id); // the ADDRESS moved; the identity did not
    expect(store.list({ limit: 10 })).toHaveLength(1);

    // 🔑 And the address he was keyed on while emailless still RESOLVES to him
    // (D-205 #3.5b) — every row written during that window is still his.
    expect(store.resolveCanonicalEmail(synthetic).canonical_email).toBe(
      'dr.smith@dental.example',
    );
  });

  it('the ADDRESS outranks the mirror — a known person is not duplicated by promotion', async () => {
    // We minted the dentist from the contact book…
    await sync([rec('people/c2', { phone: '+15550100', name: 'Dr. Smith' })]);
    // …but Recued ALSO knows him by address, from mail.
    store.observe({ email: 'doc@dental.example', name: 'Dr. Smith', source: 'email_from', event_at: 5 });

    // Google now gives the record THAT address. Promotion would collide (it is
    // already attached), so the address must win and the record RE-POINTS onto the
    // person we already know. The synthetic row survives as a duplicate — which is
    // the D-138 detector's job, not the sync's (ruling 2: import is import AND merge).
    const out = await sync([
      rec('people/c2', { email: 'doc@dental.example', phone: '+15550100', name: 'Dr. Smith', as_of: 9_000 }),
    ]);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toBe(0);
    expect(out.promoted).toBe(0); // the address won; nothing was re-keyed
    expect(out.failed_rows).toBe(0); // and NOTHING threw

    expect(store.get('doc@dental.example')?.phone).toBe('+15550100');
  });
});

describe('D-205 #4b — the fail-closed guards', () => {
  it('⛔ REFUSES full_import at a rung with no ContactSource — it will not improvise', async () => {
    // A CRM rung cannot stamp a created row: `manual` would outrank the user's own
    // typing forever, `derived` would claim Recued saw it in warehouse traffic.
    const bad: ContactSourceDeclaration = { ...GOOGLE, rung: 'vendor_meta' };
    const out = await runContactSourceSync(
      { store, listContacts: leafOf([]), syncState },
      { source_id: SOURCE_ID, connection_name: 'personal', declaration: bad },
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe('config');
    expect(out.reason).toMatch(/no ContactSource to stamp/i);
  });

  it('fails a record with NO address and NO name — nothing could ever match it', async () => {
    const out = await sync([rec('people/c9', { name: null })]);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toBe(0);
    expect(out.failed_rows).toBe(1);
    expect(out.failures[0]).toMatch(/nothing could ever match/i);
    expect(store.list({ limit: 10 })).toHaveLength(0);
  });
});
