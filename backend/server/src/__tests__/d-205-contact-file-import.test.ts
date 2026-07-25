/** D-205 #5c — the manual vCard / CSV import.
 *
 *  ## The design, in one sentence
 *  An upload is a BATCH `contact.upsert` — the owner speaking, in bulk. It is NOT a
 *  Source (no connection, no sync, no delete diff, no health row), so everything it
 *  writes lands at the `manual` rung with the singleton `CONTACT_SOURCE_ID_MANUAL`.
 *  Contributions upsert on `(contact_id, kind, source_id)`, which is exactly what
 *  makes **export → edit in a spreadsheet → re-upload** work as MODIFY.
 *
 *  ## Why the CHANGES are reviewed and the ADDS are not
 *  `manual` is the TOP of the ladder — nothing can ever correct it. Right when you
 *  TYPE a value; a foot-gun when you upload a 2019 export you never opened, because
 *  three thousand stale values would freeze the graph and your live CRM could never
 *  fix them. So an ADD (nothing to overwrite) just lands, agreement is a no-op, and a
 *  DISAGREEMENT with what you can SEE is the only thing that asks for your attention. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseContactFile } from '../contact-import-parse.js';
import {
  applyContactFileImport,
  planContactFileImport,
} from '../contact-import-file.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-205-file-'));
  db = new Database(join(dir, 'test.db'));
  store = createContactStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps = () => ({ store, now: () => 5_000 });

// ────────────────────────────────────────────────────────────────

describe('D-205 #5c — the parser reads what real exports actually emit', () => {
  it('vCard: folded lines, PREF selection, structured ADR/ORG/N, and 8-digit BDAY', () => {
    // Every quirk here is one a real Google/Apple export produces.
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Bob Smith',
      'N:Smith;Bob;;;',
      'EMAIL;TYPE=WORK:bob@work.test',
      'EMAIL;TYPE=HOME;TYPE=PREF:bob@home.test', // ← PREF wins even though it is second
      'TEL;TYPE=CELL:+1 555 0100',
      'ORG:Acme Inc;Engineering', // ← the org is the FIRST component
      'TITLE:Staff Engineer',
      'BDAY:19800402', // ← 8-digit, not ISO
      'ADR;TYPE=HOME:;;1 Main St;Springfield;IL;62704;United State',
      ' s', // ← FOLDED. A parser that skips unfolding reads a truncated country.
      'END:VCARD',
    ].join('\r\n');

    const out = parseContactFile(vcf);
    expect(out.format).toBe('vcard');
    expect(out.errors).toEqual([]);
    expect(out.entries).toHaveLength(1);

    const e = out.entries[0]!;
    expect(e.email).toBe('bob@home.test'); // PREF, not first
    expect(e.name).toBe('Bob Smith'); // FN beats the composed N
    expect(e.phone).toBe('+1 555 0100');
    expect(e.company).toBe('Acme Inc'); // not "Acme Inc;Engineering"
    expect(e.title).toBe('Staff Engineer');
    expect(e.birthday).toBe('1980-04-02');
    // The unfold worked: the country is whole, so the address canonicalizes at all.
    expect(e.address).toMatchObject({ city: 'springfield', zip: '62704' });
  });

  it('⛔ vCard: a base64 PHOTO is DROPPED — bytes are NEVER stored (C-2 North star)', () => {
    const vcf = [
      'BEGIN:VCARD',
      'FN:Bob',
      'EMAIL:bob@x.test',
      'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQ',
      'END:VCARD',
    ].join('\n');
    // Inlining a megabyte of JPEG into a contact row would break "bytes are never
    // fetched or stored" on the one field named for it. A URL is a reference; base64
    // is the bytes.
    expect(parseContactFile(vcf).entries[0]!.photo).toBeUndefined();

    const withUrl = vcf.replace(
      'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQ',
      'PHOTO;VALUE=URI:https://example.test/bob.jpg',
    );
    expect(parseContactFile(withUrl).entries[0]!.photo).toBe('https://example.test/bob.jpg');
  });

  it('🔑 vCard: an unterminated block is a TRUNCATED FILE, and it says so', () => {
    // A silent drop here loses contacts the user believes they imported, and they
    // would have no way to know.
    const out = parseContactFile('BEGIN:VCARD\nFN:Bob\nEMAIL:bob@x.test\n');
    expect(out.entries).toHaveLength(0);
    expect(out.errors[0]).toMatch(/not terminated|truncated/i);
  });

  it('CSV: RFC 4180 quoting — a naive split(",") shifts every column', () => {
    const csv = [
      'Name,Email,Company,Title',
      '"Smith, Bob",bob@x.test,"Acme, Inc.",Engineer', // commas INSIDE quotes
    ].join('\n');
    const e = parseContactFile(csv).entries[0]!;
    expect(e.name).toBe('Smith, Bob');
    expect(e.email).toBe('bob@x.test');
    expect(e.company).toBe('Acme, Inc.'); // ← a shifted map would put "Inc." here
    expect(e.title).toBe('Engineer');
  });

  it('CSV: composes the name from Google Contacts First/Last columns', () => {
    const csv = ['First Name,Last Name,E-mail 1 - Value', 'Bob,Smith,bob@x.test'].join('\n');
    const e = parseContactFile(csv).entries[0]!;
    expect(e.name).toBe('Bob Smith');
    expect(e.email).toBe('bob@x.test');
  });

  it('⛔ CSV: NO identity column ⇒ the whole file is REFUSED, and names the header', () => {
    // Importing it would create rows nothing could ever match, and the user would see
    // "300 contacts added" over a graph that had not usefully changed.
    const out = parseContactFile('Notes,Groups\nsomething,friends');
    expect(out.entries).toHaveLength(0);
    expect(out.errors[0]).toMatch(/no email, name or phone column/i);
    expect(out.errors[0]).toContain('notes'); // actionable, not a shrug
  });
});

// ────────────────────────────────────────────────────────────────

describe('D-205 #5c — the plan reviews the CONFLICTS, and only those', () => {
  const vcard = (props: string[]): string =>
    ['BEGIN:VCARD', ...props, 'END:VCARD'].join('\n');

  it('🔑 an ADD has nothing to overwrite, so it needs no review', () => {
    const plan = planContactFileImport(
      deps(),
      vcard(['FN:Carol Jones', 'EMAIL:carol@x.test', 'TEL:+15550111']),
    );
    expect(plan.adds).toBe(1);
    expect(plan.changes).toEqual([]);
    expect(plan.unchanged).toBe(0);
  });

  it('AGREEMENT is a no-op — counted, so the user can see it was mostly agreement', () => {
    store.upsertManual({ email: 'bob@x.test', name: 'Bob Smith', company: 'Acme' });
    const plan = planContactFileImport(
      deps(),
      vcard(['FN:Bob Smith', 'EMAIL:bob@x.test', 'ORG:Acme']),
    );
    expect(plan.unchanged).toBe(1);
    expect(plan.changes).toEqual([]);
    expect(plan.adds).toBe(0);
  });

  it('🔑 the diff is against what the user SEES — a CRM-supplied value counts', () => {
    // Bob's phone currently comes from HubSpot (`vendor_meta`). The file disagrees.
    // Applying it would CHANGE what is on screen, so the review must say so —
    // diffing against his (absent) manual row would call this "unchanged" and then
    // change it anyway.
    const bob = store.observe({
      email: 'bob@x.test',
      name: 'Bob',
      source: 'email_from',
      event_at: 1,
    });
    store.upsertContactAttribute({
      contact_id: bob.contact_id!,
      kind: 'org',
      value: 'Acme Inc.',
      source: 'vendor_meta',
      source_id: 'hubspot.work.contact',
      as_of: 1_000,
    });
    store.materializeContactProjection(bob.contact_id!, 2_000);
    expect(store.get('bob@x.test')?.company).toBe('Acme Inc.');

    const plan = planContactFileImport(
      deps(),
      vcard(['FN:Bob', 'EMAIL:bob@x.test', 'ORG:Acme Corporation']),
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.fields).toEqual([
      { field: 'company', from: 'Acme Inc.', to: 'Acme Corporation' },
    ]);
  });

  it('🔑 an ABSENT field is NOT an empty one — it must never blank a value', () => {
    // A CSV with no Title column is not asserting the user has no job. Blanking it
    // would be data loss dressed as an import.
    store.upsertManual({ email: 'bob@x.test', name: 'Bob', company: 'Acme', title: 'CTO' });
    const plan = planContactFileImport(
      deps(),
      'Name,Email\nBob,bob@x.test', // no Title, no Company column at all
    );
    expect(plan.changes).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('the identity resolves through the ADDRESS SPACE, not a naive email lookup', () => {
    // Recued knows Bob as bob@home; the file has him as bob@work — an address he ALSO
    // answers to. A naive `get(fileEmail)` would call him new and mint his duplicate.
    const bob = store.observe({
      email: 'bob@home.test',
      name: 'Bob',
      source: 'email_from',
      event_at: 1,
    });
    store.upsertContactAlias({
      contact_id: bob.contact_id!,
      kind: 'email_alias',
      alias_pattern: 'bob@work.test',
      source: 'vendor_meta',
      source_id: 'hubspot.work.contact',
    });

    const plan = planContactFileImport(
      deps(),
      vcard(['FN:Robert Smith', 'EMAIL:bob@work.test']),
    );
    expect(plan.adds).toBe(0); // NOT a new person
    expect(plan.changes[0]!.email).toBe('bob@home.test'); // resolved to the survivor
  });

  it('⛔ an AMBIGUOUS phone resolves to NOBODY — it never guesses', () => {
    // Two contacts share the number. Rewriting whichever row sorted first is the one
    // failure this whole family is built to prevent.
    store.upsertManual({ email: 'a@x.test', name: 'A', phone: '+15550100' });
    store.upsertManual({ email: 'b@x.test', name: 'B', phone: '+15550100' });

    const plan = planContactFileImport(deps(), vcard(['FN:Somebody', 'TEL:+15550100']));
    expect(plan.adds).toBe(0);
    expect(plan.changes).toEqual([]);
    expect(plan.errors[0]).toMatch(/more than one contact/i);
  });
});

// ────────────────────────────────────────────────────────────────

describe('D-205 #5c — apply', () => {
  const vcard = (props: string[]): string =>
    ['BEGIN:VCARD', ...props, 'END:VCARD'].join('\n');

  it('everything lands at the MANUAL rung — the user said so', () => {
    applyContactFileImport(
      deps(),
      vcard(['FN:Carol Jones', 'EMAIL:carol@x.test', 'ORG:Acme', 'TITLE:CTO']),
      true,
    );
    const carol = store.get('carol@x.test')!;
    expect(carol.company).toBe('Acme');
    expect(carol.title).toBe('CTO'); // ← `title` had NO writer before this slice
    expect(carol.projection_provenance?.org?.source).toBe('manual');
    expect(carol.projection_provenance?.title?.source).toBe('manual');
  });

  it('🔑 `apply_changes: false` lands the ADDS ONLY — a stale export cannot freeze the graph', () => {
    store.upsertManual({ email: 'bob@x.test', name: 'Bob', company: 'Acme Corporation' });
    const file = [
      vcard(['FN:Bob', 'EMAIL:bob@x.test', 'ORG:STALE Inc']), // a conflict
      vcard(['FN:Carol Jones', 'EMAIL:carol@x.test']), // a new person
    ].join('\n');

    const out = applyContactFileImport(deps(), file, false);
    expect(out.added).toBe(1);
    expect(out.changed).toBe(0);
    expect(out.skipped).toBe(1);

    expect(store.get('carol@x.test')).not.toBeNull(); // the new person landed…
    expect(store.get('bob@x.test')?.company).toBe('Acme Corporation'); // …Bob untouched
  });

  it('🔑 RE-UPLOAD is MODIFY — the manual contribution is REPLACED, never accumulated', () => {
    // The whole reason this works: `CONTACT_SOURCE_ID_MANUAL` is a SINGLETON ("there
    // is exactly one of the user"), and contributions upsert on
    // `(contact_id, kind, source_id)`. Export → edit in a spreadsheet → re-upload.
    applyContactFileImport(deps(), vcard(['FN:Bob', 'EMAIL:bob@x.test', 'ORG:Acme']), true);
    applyContactFileImport(deps(), vcard(['FN:Bob', 'EMAIL:bob@x.test', 'ORG:Globex']), true);

    const bob = store.get('bob@x.test')!;
    expect(bob.company).toBe('Globex');
    // ONE row, not two. A second manual `org` row would be an impossible state anyway
    // — the key forbids it — and that is exactly why "modify" needed nothing new.
    expect(store.listContactAttributes(bob.contact_id!, 'org')).toHaveLength(1);
  });

  it('🔑 THE DENTIST in a vCard — no email, and he is not created twice', () => {
    const dentist = vcard(['FN:Dr. Smith', 'TEL:+15550100']);

    const first = applyContactFileImport(deps(), dentist, true);
    expect(first.added).toBe(1);
    expect(store.list({ limit: 10 })).toHaveLength(1);

    // Re-upload the SAME file. He still has no email, so the address space can never
    // match him — `findByPhone` is the re-identification key. Without it he would be
    // minted again on every upload, forever.
    const second = applyContactFileImport(deps(), dentist, true);
    expect(second.added).toBe(0);
    expect(store.list({ limit: 10 })).toHaveLength(1);
  });
});
