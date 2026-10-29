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

import { handleContactGet } from '../contact-handler.js';
import { parseContactFile } from '../contact-import-parse.js';
import {
  applyContactFileImport,
  planContactFileImport,
} from '../contact-import-file.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { declaredOccasions } from '../situations/declared-occasions.js';
import { occasionNextDate } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';

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
      'EMAIL;TYPE="HOME,PREF":bob@home.test', // ← PREF wins even though it is second
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

  it('D-325 vCard: Apple’s labelled anniversary is the anniversary, and its other labelled dates are named', () => {
    // Apple's vCard 3.0 has no ANNIVERSARY: each extra date is a grouped X-ABDATE
    // and its name a grouped X-ABLabel, in either order.
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Ana Silva',
      'EMAIL:ana@x.test',
      'item1.X-ABDATE;type=pref:2004-06-15',
      'item1.X-ABLabel:_$!<Anniversary>!$_',
      'BDAY:--04-15',
      'item4.X-ABDATE:1990-04-16',
      'item4.X-ABLabel:Birthday',
      'item2.X-ABLabel:Graduation',
      'item2.X-ABDATE:2015-06-01',
      'item3.X-ABDATE;X-APPLE-OMIT-YEAR=1604:1604-09-09',
      'item3.X-ABLabel:_$!<Other>!$_',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Ben Okafor',
      'EMAIL:ben@x.test',
      'ANNIVERSARY:2010-05-01', // ← a card's own ANNIVERSARY line wins
      'item1.X-ABDATE;X-APPLE-OMIT-YEAR=1604:1604-07-04',
      'item1.X-ABLabel:_$!<Anniversary>!$_',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Cy Park',
      'EMAIL:cy@x.test',
      'item1.X-ABDATE;X-APPLE-OMIT-YEAR=1604:1604-07-04',
      'item1.X-ABLabel:_$!<Anniversary>!$_',
      'END:VCARD',
    ].join('\r\n');
    const out = parseContactFile(vcf);
    expect(out.entries.map((entry) => entry.anniversary)).toEqual(['2004-06-15', '2010-05-01', '--07-04']);
    expect(out.entries[0]?.birthday).toBe('--04-15');
    expect(out.entries[0]?.dates).toEqual([{ label: 'Graduation', date: '2015-06-01' }, { label: 'Other', date: '--09-09' }]);
    expect(out.date_notes).toEqual([]);
  });

  it('D-325 CSV: a Google Contacts export’s Event columns bring the anniversary and name the rest', () => {
    // Newer exports name each date `Event N - Label`, older ones `Event N - Type`.
    const labelled = parseContactFile([
      'First Name,Last Name,E-mail 1 - Value,Birthday,Event 1 - Label,Event 1 - Value,Event 2 - Label,Event 2 - Value',
      'Ana,Silva,ana@x.test,--03-04,Anniversary,2004-06-15,Graduation,2015-06-01',
    ].join('\n'));
    expect(labelled.entries[0]).toMatchObject({ name: 'Ana Silva', birthday: '--03-04', anniversary: '2004-06-15' });
    expect(labelled.entries[0]?.dates).toEqual([{ label: 'Graduation', date: '2015-06-01' }]);
    expect(labelled.date_notes).toEqual([]);

    const typed = parseContactFile([
      'Name,E-mail 1 - Value,Anniversary,Event 1 - Type,Event 1 - Value,Event 2 - Type,Event 2 - Value',
      'Bo,bo@x.test,,* Anniversary,--07-04,,', // ← Google's `* ` marks the primary entry
      'Cy,cy@x.test,2001-01-01,Anniversary,2002-02-02,Anniversary,4/2/2004', // ← the Anniversary column wins
      'Di,di@x.test,,Anniversary,4/2/2004,,',
      'Ed,ed@x.test,,Anniversary,0/0/00,,', // ← an empty date, not a date to name
    ].join('\n'));
    expect(typed.entries.map((entry) => entry.anniversary)).toEqual(['--07-04', '2001-01-01', undefined, undefined]);
    expect(typed.date_notes).toEqual([
      'row 4 (Di): anniversary "4/2/2004" is not a date and was not imported. '
        + 'Write it as YYYY-MM-DD, or --MM-DD without a year.',
    ]);
  });

  it('D-325 a date that is not one is named, never guessed: a birthday kept as text, an anniversary left out', () => {
    const vcf = ['BEGIN:VCARD', 'FN:Dee', 'EMAIL:dee@x.test', 'BDAY:circa 1800', 'ANNIVERSARY:15.06.2004', 'END:VCARD'].join('\n');
    const card = parseContactFile(vcf);
    expect(card.entries[0]).toMatchObject({ birthday: 'circa 1800' });
    expect(card.entries[0]!.anniversary).toBeUndefined();
    expect(card.date_notes).toEqual([
      'line 1 (Dee): birthday "circa 1800" is not a date, so it is kept as text and will not remind you. '
        + 'Write it as YYYY-MM-DD, or --MM-DD without a year.',
      'line 1 (Dee): anniversary "15.06.2004" is not a date and was not imported. '
        + 'Write it as YYYY-MM-DD, or --MM-DD without a year.',
    ]);

    // `4/2/1980` is 2 April or 4 February depending on who wrote it. An all-zero
    // date is an empty one, and an ISO date needs no word.
    const csv = [
      'Name,Email,Birthday,Anniversary',
      'Bob,bob@x.test,4/2/1980,6/15/2004',
      'Cy,cy@x.test,0/0/00,0/0/00',
      'Di,di@x.test,1990-01-02,--06-15',
    ].join('\n');
    const rows = parseContactFile(csv);
    expect(rows.entries.map(({ birthday, anniversary }) => ({ birthday, anniversary }))).toEqual([
      { birthday: '4/2/1980', anniversary: undefined },
      { birthday: undefined, anniversary: undefined },
      { birthday: '1990-01-02', anniversary: '--06-15' },
    ]);
    expect(rows.date_notes).toEqual([
      'row 2 (Bob): birthday "4/2/1980" is not a date, so it is kept as text and will not remind you. '
        + 'Write it as YYYY-MM-DD, or --MM-DD without a year.',
      'row 2 (Bob): anniversary "6/15/2004" is not a date and was not imported. '
        + 'Write it as YYYY-MM-DD, or --MM-DD without a year.',
    ]);
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
    // Nothing to say about dates: the field is absent, as from an older server.
    expect(plan).not.toHaveProperty('date_notes');
  });

  it('D-325 the preview names the dates it could not use; the person still imports', () => {
    const plan = planContactFileImport(deps(), vcard(['FN:Dee', 'EMAIL:dee@x.test', 'ANNIVERSARY:15.06.2004']));
    expect(plan.adds).toBe(1);
    expect(plan.date_notes).toEqual(['line 1 (Dee): anniversary "15.06.2004" is not a date and was not imported. '
      + 'Write it as YYYY-MM-DD, or --MM-DD without a year.']);
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

  it('🔑 THE DENTIST in a vCard — no email, and he is not created twice', async () => {
    const dentist = vcard(['FN:Dr. Smith', 'TEL;TYPE=PREF:+15550100', 'TEL:+15550109']);

    const first = applyContactFileImport(deps(), dentist, true);
    expect(first.added).toBe(1);
    expect(store.list({ limit: 10 })).toHaveLength(1);

    // Re-upload the SAME file. He still has no email, so the address space can never
    // match him — `findByPhone` is the re-identification key. Without it he would be
    // minted again on every upload, forever.
    const second = applyContactFileImport(deps(), dentist, true);
    expect(second.added).toBe(0);
    expect(store.list({ limit: 10 })).toHaveLength(1);
    const id = store.list()[0]!.contact_id;
    expect(applyContactFileImport(deps(), vcard(['FN:Dr. Smith', 'TEL:+15550109']), true)).toMatchObject({ added: 0, changed: 1, failures: [] });
    expect(store.list()[0]).toMatchObject({ contact_id: id, phone: '+15550109' });
    const emailed = vcard(['FN:Dr. Smith', 'EMAIL:doctor@example.test', 'TEL:+15550100']);
    expect(planContactFileImport(deps(), emailed).changes[0]?.fields).toContainEqual({ field: 'email', from: '', to: 'doctor@example.test' });
    expect(applyContactFileImport(deps(), emailed, false).skipped).toBe(1);
    expect(store.get('doctor@example.test')).toBeNull();
    expect(applyContactFileImport(deps(), emailed, true).failures).toEqual([]);
    expect(store.get('doctor@example.test')).toMatchObject({ contact_id: id, identity_status: 'verified' });
    expect((await handleContactGet({ store }, { email: 'doctor@example.test' })).identifiers).toEqual({ emails: [], phones: ['+15550109'] });
    expect(store.list()).toHaveLength(1);
  });
});


describe('VCF identifiers and selected Occasions', () => {
  const card = (...props: string[]) => ['BEGIN:VCARD', 'VERSION:4.0', ...props, 'END:VCARD'].join('\n');
  const dateDeps = () => ({ ...deps(), history: createProactiveHistoryStore(db, createProactiveProposalStore(db)),
    transaction: <T>(work: () => T): T => db.transaction(work)() });

  it('keeps every identifier, numeric PREF order and primary phones across review and re-import', async () => {
    const text = card('FN:Alex', 'EMAIL;PREF=10:work@example.test', 'EMAIL;PREF=1:home@example.test',
      'EMAIL:HOME@example.test', 'TEL;PREF=2:tel:+15550102', 'TEL;PREF=1:tel:+15550101');
    const parsed = parseContactFile(text).entries[0]!;
    expect(parsed.emails).toEqual(['home@example.test', 'work@example.test']);
    expect(parsed.phones).toEqual(['+15550101', '+15550102']);
    expect(applyContactFileImport(deps(), text, false)).toMatchObject({ added: 1, failures: [] });
    const alex = store.get('home@example.test')!;
    expect(alex.phone).toBe('+15550101');
    expect(store.listContactAliases(alex.contact_id!).filter(row => row.kind === 'phone_alias')).toHaveLength(2);
    const next = card('FN:Alex', 'EMAIL;PREF=1:new@example.test', 'EMAIL:work@example.test', 'TEL;PREF=1:+15550102', 'TEL:+15550103');
    expect(planContactFileImport(deps(), next)).toMatchObject({ adds: 0, changes: [{ email: alex.email }] });
    applyContactFileImport(deps(), next, false);
    expect(store.get(alex.email)?.phone).toBe('+15550101');
    expect(store.listContactAliases(alex.contact_id!).some(row => row.alias_pattern === 'new@example.test')).toBe(false);
    applyContactFileImport(deps(), next, true);
    store.materializeContactProjection(alex.contact_id!, 6000);
    expect(store.get(alex.email)).toMatchObject({ contact_id: alex.contact_id, phone: '+15550102' });
    expect(store.resolveCanonicalEmail('new@example.test').canonical_email).toBe(alex.email);
    expect(planContactFileImport(deps(), next)).toMatchObject({ adds: 0, unchanged: 1, changes: [] });
    expect(applyContactFileImport(deps(), next, true)).toMatchObject({ added: 0, changed: 0, skipped: 1 });
    const absorbed = store.upsertManual({ email: 'old@example.test', name: 'Alex', phone: '+15550104' }, 8000);
    store.upsertContactAlias({ contact_id: absorbed.contact_id!, kind: 'phone_alias', alias_pattern: '+15550105', source: 'manual' }, 8100);
    store.materializeContactProjection(absorbed.contact_id!, 8200);
    expect(store.get(absorbed.email)?.phone).toBe('+15550104');
    store.setMergedInto([absorbed], alex.email, 8500);
    const mergedCard = card('FN:Alex', 'EMAIL:old@example.test', 'EMAIL:home@example.test', 'TEL;PREF=1:+15550101', 'TEL:+15550104');
    expect(applyContactFileImport({ ...deps(), now: () => 9000 }, mergedCard, true).failures).toEqual([]);
    expect(store.get(alex.email)?.phone).toBe('+15550101');
    expect(store.findByPhone('+15550104').contact?.contact_id).toBe(alex.contact_id);
    expect((await handleContactGet({ store }, { email: alex.email })).identifiers?.phones.filter(phone => phone === '+15550104')).toHaveLength(1);
    expect(planContactFileImport(deps(), mergedCard).changes).toEqual([]);
    store.setMergedInto([store.get(absorbed.email)!], null, 10000);
    expect(store.get(absorbed.email)?.phone).toBe('+15550104');
    // A later manual edit chooses an already-known phone, rather than whichever alias is newest.

    store.upsertManual({ email: alex.email, phone: '+15550101' }, 9000);
    expect(store.get(alex.email)?.phone).toBe('+15550101');
  });

  it('refuses a card whose addresses identify different people before writing either person', () => {
    store.upsertManual({ email: 'a@example.test', name: 'A' }, 1000);
    store.upsertManual({ email: 'b@example.test', name: 'B' }, 1000);
    const text = card('FN:Wrong', 'EMAIL:a@example.test', 'EMAIL:b@example.test', 'EMAIL:new@example.test');
    expect(planContactFileImport(deps(), text).errors[0]).toMatch(/more than one contact/);
    expect(applyContactFileImport(deps(), text, true)).toMatchObject({ added: 0, changed: 0, skipped: 1 });
    expect(store.get('a@example.test')?.name).toBe('A');
    expect(store.get('b@example.test')?.name).toBe('B');
    expect(store.get('new@example.test')).toBeNull();
  });

  it('imports only selected labelled dates, reuses contact Occasions and preserves owner reminder edits', () => {
    const d = dateDeps();
    const text = card('FN:Alex', 'EMAIL:alex@example.test', 'BDAY:--04-15', 'ANNIVERSARY:20101020',
      'item1.X-ABDATE:2030-06-01', 'item1.X-ABLabel:Graduation', 'item2.X-ABDATE:--09-09', 'item2.X-ABLabel:First met');
    const dates = planContactFileImport(d, text).occasions!;
    applyContactFileImport(d, text, false);
    expect(d.history.occasions()).toEqual([]);
    const alex = store.get('alex@example.test')!;
    expect(declaredOccasions({ contacts: store, calendars: () => [], timeZone: () => 'UTC' }).map(o => o.source?.field).sort()).toEqual(['anniversary', 'birthday']);
    const result = applyContactFileImport(d, text, false, [{ key: dates[0]!.key, recurrence: 'once', reminder_days: 1 }]);
    expect(result).toMatchObject({ added: 0, changed: 0, occasions_saved: 1, failures: [] });
    const occasion = d.history.occasions()[0]!;
    expect(occasion).toMatchObject({ people: [alex.contact_id], month_day: '06-01', source_next_on: '2030-06-01' });
    expect(occasion.rules[0]?.schedule).toEqual({ before: [{ amount: 1, unit: 'days' }], on_day: true });
    expect(occasionNextDate(occasion, '2030-06-02')).toBeNull();
    d.history.saveOccasion({ ...occasion, title: 'My graduation', muted: true, rules: [{ ...occasion.rules[0]!, enabled: false }] }, 6000);
    const revised = text.replace('2030-06-01', '2031-06-02');
    const preview = planContactFileImport(d, revised);
    expect(preview.occasions?.[0]?.existing).toMatchObject({ title: 'My graduation', date: '2030-06-01', recurrence: 'once' });
    const selection = { key: preview.occasions![0]!.key, recurrence: 'yearly' as const, reminder_days: 30 as const, expected_version: preview.occasions![0]!.existing!.version };
    d.history.saveOccasion({ ...d.history.occasion(occasion.id)!, title: 'Owner correction' }, 7000);
    expect(() => applyContactFileImport(d, revised, true, [selection])).toThrow(/changed since this review/);
    expect(d.history.occasion(occasion.id)?.title).toBe('Owner correction');
    const refreshed = planContactFileImport(d, revised);
    selection.expected_version = refreshed.occasions![0]!.existing!.version;
    applyContactFileImport(d, revised, false, [selection]);
    const updated = d.history.occasion(occasion.id)!;
    expect(d.history.occasions()).toHaveLength(1);
    expect(updated).toMatchObject({ title: 'Owner correction', muted: true, month_day: '06-02', rules: [{ enabled: false }] });
    expect(updated.source_next_on).toBeUndefined();
    expect(updated.rules[0]?.schedule).toEqual(occasion.rules[0]?.schedule);
    expect(occasionNextDate(updated, '2031-06-03')).toBe('2032-06-02');
    const survivor = store.upsertManual({ email: 'survivor@example.test', name: 'Alex' }, 9000);
    store.setMergedInto([store.get(alex.email)!], survivor.email, 10000);
    const merged = planContactFileImport(d, revised).occasions![0]!;
    expect(merged.existing?.title).toBe('Owner correction');
    expect(applyContactFileImport(d, revised, false, [{ ...selection, expected_version: merged.existing!.version }]).failures).toEqual([]);
    expect(d.history.occasions()).toHaveLength(1);
    expect(d.history.occasion(occasion.id)?.people).toEqual([survivor.contact_id]);

    const otherText = card('FN:Chris', 'EMAIL:chris@example.test', 'item1.X-ABDATE:--06-02', 'item1.X-ABLabel:Graduation');
    const other = planContactFileImport(d, otherText).occasions![0]!;
    applyContactFileImport(d, otherText, false, [{ key: other.key, recurrence: 'yearly' }]);
    store.setMergedInto([store.get('chris@example.test')!], survivor.email, 11000);
    const conflicted = planContactFileImport(d, revised).occasions![0]!;
    expect(conflicted.unavailable).toMatch(/more than one occasion/);
    expect(() => applyContactFileImport(d, revised, false, [{ ...selection, expected_version: conflicted.existing!.version }])).toThrow(/more than one occasion/);
    expect(d.history.occasions()).toHaveLength(2);
  });

  it('publishes contact writes only after their Occasions commit, including phone-only creation and promotion', () => {
    const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
    const notifications: Array<{ inTransaction: boolean; hasDate: boolean }> = [];
    const bus = createWarehouseEventBus();
    const events: Array<{ inTransaction: boolean; persisted: boolean }> = [];
    bus.subscribe('**', event => { events.push({ inTransaction: db.inTransaction, persisted: !!store.get(event.record_id) }); });
    store = createContactStore(db, { bus, onContactUpserted: record => {
      notifications.push({ inTransaction: db.inTransaction, hasDate: history.forPerson('occasion', record.contact_id!).length > 0 });
    } });
    const d = { ...deps(), history, transaction: <T>(work: () => T): T => db.transaction(work)() };
    const identities = [
      ['FN:Emailed', 'EMAIL:emailed@example.test'],
      ['FN:Phone only', 'TEL:+15550111'],
      ['FN:Promoted', 'EMAIL:promoted@example.test', 'TEL:+15550112'],
    ];
    for (const props of identities) {
      if (props[0] === 'FN:Promoted') applyContactFileImport(d, card('FN:Promoted', 'TEL:+15550112'), false);
      notifications.length = 0; events.length = 0;
      const text = card(...props, 'item1.X-ABDATE:--04-15', 'item1.X-ABLabel:First met');
      const choice = { key: planContactFileImport(d, text).occasions![0]!.key, recurrence: 'yearly' as const };
      const before = store.list(); const aliases = db.prepare('SELECT * FROM contact_alias ORDER BY id').all();
      const failed = applyContactFileImport({ ...d, history: { ...history, saveOccasion: () => { throw new Error('disk write failed'); } } }, text, true, [choice]);
      expect(failed).toMatchObject({ added: 0, changed: 0, occasions_saved: 0, failures: ['line 1: disk write failed'] });
      expect(store.list()).toEqual(before); expect(db.prepare('SELECT * FROM contact_alias ORDER BY id').all()).toEqual(aliases);
      expect(events).toEqual([]); expect(notifications).toEqual([]);
      expect(applyContactFileImport(d, text, true, [choice]).failures).toEqual([]);
      expect(events.length).toBeGreaterThan(0); expect(events.every(event => !event.inTransaction && event.persisted)).toBe(true);
      expect(notifications.length).toBeGreaterThan(0); expect(notifications.every(event => !event.inTransaction && event.hasDate)).toBe(true);
    }
  });

  it('rejects forged or unusable date choices before writing contacts', () => {
    const d = dateDeps();
    const text = card('FN:Alex', 'EMAIL:alex@example.test', 'item1.X-ABDATE:--04-15', 'item1.X-ABLabel:First met');
    const key = planContactFileImport(d, text).occasions![0]!.key;
    expect(() => applyContactFileImport(d, text, false, [{ key, recurrence: 'once' }])).toThrow(/Invalid occasion selection/);
    expect(() => applyContactFileImport(d, text, false, [{ key: 'forged', recurrence: 'yearly' }])).toThrow(/Invalid occasion selection/);
    expect(store.get('alex@example.test')).toBeNull();
    const duplicate = text.replace('END:VCARD', 'item2.X-ABDATE:--05-15\nitem2.X-ABLabel:First met\nEND:VCARD');
    expect(planContactFileImport(d, duplicate).occasions?.every(date => date.unavailable?.includes('distinct names'))).toBe(true);
  });
});
