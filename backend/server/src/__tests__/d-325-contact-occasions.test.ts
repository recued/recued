import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contactExcludedFromProactive, isContactAnnualDate } from '@recued/contracts';
import { createContactStore } from '../storage/contact-store.js';
import { handleContactUpsert } from '../contact-handler.js';
import { parseContactFile } from '../contact-import-parse.js';
import { applyContactFileImport, planContactFileImport } from '../contact-import-file.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { declaredOccasions } from '../situations/declared-occasions.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); }); afterEach(() => db.close());
const owner = { origin_actor: 'user_self' as const, origin_surface: 'client_rpc' as const };
describe('D-325 contact anniversaries and owner privacy', () => {
  it('imports a vCard anniversary at its real rank, preserves owner edits and supports explicit clearing', async () => {
    const store = createContactStore(db); const text = 'BEGIN:VCARD\nVERSION:4.0\nFN:Alex\nEMAIL:alex@example.test\nANNIVERSARY:20101020\nEND:VCARD'; const file = parseContactFile(text);
    expect(file.entries[0]?.anniversary).toBe('2010-10-20');
    const deps = { store, now: () => 1000 };
    const plan = planContactFileImport(deps, text); expect(plan.adds).toBe(1); applyContactFileImport(deps, text, false);
    const alex = store.get('alex@example.test')!; expect(alex.anniversary).toBe('2010-10-20');
    store.upsertContactAttribute({ contact_id: alex.contact_id!, kind: 'anniversary', value: '--11-01', source: 'contact_book', source_id: 'google', as_of: 2000 });
    store.materializeContactProjection(alex.contact_id!, 2000); expect(store.get(alex.email)?.anniversary).toBe('2010-10-20');
    store.upsertManual({ email: alex.email, anniversary: null }, 3000); expect(store.get(alex.email)?.anniversary).toBeUndefined();
    expect(isContactAnnualDate('--02-29')).toBe(true); expect(isContactAnnualDate('2100-02-29')).toBe(false);
  });
  // §15.8 — the store took only a non-empty birthday, so nothing could clear one.
  it('clears a birthday the owner removes, ends its occasion, and keeps a later sync from bringing it back', async () => {
    const store = createContactStore(db); const occasions = () => declaredOccasions({ contacts: store, calendars: () => [], timeZone: () => 'UTC' });
    const ana = (await handleContactUpsert({ store, ...owner }, { email: 'ana@example.test', name: 'Ana', birthday: '--04-15' })).contact;
    store.upsertContactAttribute({ contact_id: ana.contact_id!, kind: 'birthday', value: '1990-04-16', source: 'contact_book', source_id: 'google', as_of: 2000 });
    store.materializeContactProjection(ana.contact_id!, 2000);
    expect(store.get(ana.email)?.birthday).toBe('--04-15'); expect(occasions().map(row => row.source?.field)).toEqual(['birthday']);
    await handleContactUpsert({ store, ...owner }, { email: ana.email, birthday: '' });
    expect(store.get(ana.email)?.birthday).toBe('--04-15');
    await handleContactUpsert({ store, ...owner }, { email: ana.email, birthday: null });
    expect(store.get(ana.email)?.birthday).toBeUndefined(); expect(occasions()).toEqual([]);
    store.upsertContactAttribute({ contact_id: ana.contact_id!, kind: 'birthday', value: '1990-04-17', source: 'contact_book', source_id: 'google', as_of: 9000 });
    store.materializeContactProjection(ana.contact_id!, 9000);
    expect(store.get(ana.email)?.birthday).toBeUndefined(); expect(occasions()).toEqual([]);
    // A birthday kept as text from a card ("circa 1800") clears the same way.
    applyContactFileImport({ store, now: () => 1000 }, 'BEGIN:VCARD\nVERSION:4.0\nFN:Old\nEMAIL:old@example.test\nBDAY;VALUE=text:circa 1800\nEND:VCARD', false);
    expect(store.get('old@example.test')?.birthday).toBe('circa 1800');
    await handleContactUpsert({ store, ...owner }, { email: 'old@example.test', birthday: null });
    expect(store.get('old@example.test')?.birthday).toBeUndefined();
  });
  it('reads yearless and dated vCard and CSV dates, and leaves out an anniversary that is not a date instead of failing the contact', () => {
    const card = (lines: string[]) => parseContactFile(['BEGIN:VCARD', 'VERSION:4.0', ...lines, 'END:VCARD'].join('\n')).entries[0]!;
    expect(card(['FN:A', 'BDAY:--0415', 'ANNIVERSARY:--1020'])).toMatchObject({ birthday: '--04-15', anniversary: '--10-20' });
    expect(card(['FN:B', 'BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-15', 'ANNIVERSARY:1604-10-20'])).toMatchObject({ birthday: '--04-15', anniversary: '--10-20' });
    expect(card(['FN:C', 'BDAY:19531015T231000Z', 'ANNIVERSARY:2010-10-20'])).toMatchObject({ birthday: '1953-10-15', anniversary: '2010-10-20' });
    const undated = card(['FN:D', 'BDAY;VALUE=text:circa 1800', 'ANNIVERSARY;VALUE=text:sometime in June']);
    expect(undated.birthday).toBe('circa 1800'); expect(undated).not.toHaveProperty('anniversary');

    const store = createContactStore(db); const deps = { store, now: () => 1000 };
    const vcard = 'BEGIN:VCARD\nVERSION:4.0\nFN:Eve\nEMAIL:eve@example.test\nBDAY:--0415\nANNIVERSARY:June\nEND:VCARD';
    expect(applyContactFileImport(deps, vcard, false)).toMatchObject({ added: 1, failures: [] });
    expect(store.get('eve@example.test')).toMatchObject({ birthday: '--04-15' });
    expect(store.get('eve@example.test')?.anniversary).toBeUndefined();
    const csv = 'Name,E-mail Address,Birthday,Anniversary\nDana,dana@example.test,--04-15,0/0/00\n';
    expect(applyContactFileImport(deps, csv, false)).toMatchObject({ added: 1, failures: [] });
    expect(store.get('dana@example.test')).toMatchObject({ birthday: '--04-15' });
    expect(store.get('dana@example.test')?.anniversary).toBeUndefined();
  });
  it('requires the owner surface for marks and relationships and preserves them through source refresh and a merge', async () => {
    const store = createContactStore(db);
    const alex = (await handleContactUpsert({ store, ...owner }, { email: 'alex@example.test', relationship: 'family', privacy_marks: ['deceased'] })).contact;
    expect(contactExcludedFromProactive(alex)).toBe(true);
    await expect(handleContactUpsert({ store, origin_actor: 'system', origin_surface: 'engine' }, { email: alex.email, privacy_marks: [] })).rejects.toThrow(/owner controls/);
    expect(() => store.upsertManual({ email: alex.email, relationship: 'client' })).toThrow(/owner controls/);
    store.upsertManual({ email: alex.email, name: 'New name' }); expect(store.get(alex.email)?.privacy_marks).toEqual(['deceased']);
    const survivor = store.upsertManual({ email: 'other@example.test', name: 'Alex' });
    store.setMergedInto([store.get(alex.email)!], survivor.email, 5000);
    const merged = store.get(survivor.email)!; expect(merged.privacy_marks).toEqual(['deceased']); expect(merged.relationship).toBe('family');
    store.upsertManual({ email: survivor.email, privacy_marks: [] }, 6000, owner); expect(contactExcludedFromProactive(store.get(survivor.email)!)).toBe(false);
  });
  it('derives contact spheres only from declared relationships and respects a pinned item over later placement', () => {
    const store = createContactStore(db); const alex = store.upsertManual({ email: 'alex@example.test', relationship: 'family' }, 1000, owner);
    const spheres = createSphereStore(db, undefined, id => store.getByContactIdResolved(id)?.relationship);
    const ref = { collection: 'contact', id: alex.contact_id! }; expect(spheres.resolve(ref)).toMatchObject({ sphere: 'personal', pinned: false });
    spheres.setItem(ref, 'professional'); spheres.setSource(`contact:${alex.contact_id!}`, 'personal');
    expect(spheres.resolve(ref)).toMatchObject({ sphere: 'professional', pinned: true });
    spheres.setItem(ref, null); expect(spheres.resolve(ref)).toMatchObject({ sphere: 'personal', pinned: false });
  });
});
