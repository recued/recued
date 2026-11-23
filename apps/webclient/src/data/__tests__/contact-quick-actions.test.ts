import { describe, expect, it } from 'vitest';
import type { ContactRecord } from '@recued/contracts';
import { parseContactFile } from '../../../../../backend/server/src/contact-import-parse.js';
import { contactPhoneHref, contactQuickValues, createContactVCard, formatContactMailingAddress } from '../contact-quick-actions.js';

const mentionOnlyEmail = (id: string) => `mention-only-${id}@_recued.invalid`;
const contact = (patch: Partial<ContactRecord> = {}): ContactRecord => ({
  _id: 'zoe@example.test', _collection: 'contact', email: 'zoe@example.test', name: 'Zoë Example',
  source: 'manual', first_seen: 1, last_interaction: 1, interaction_count: 1, created_at: 1, updated_at: 1,
  ...patch,
});

describe('Contact quick actions', () => {
  it('uses the displayed values and omits synthetic email identities and merged records', () => {
    const saved = contact({ email: mentionOnlyEmail('contact-zoe'), phone: ' +442079460123 ',
      mailing_address: { address1: ' 10 Downing street ', city: 'London', state: '', zip: 'SW1A 2AA', country: 'GB' } });
    const identifiers = { emails: ['zoe@work.test'], phones: ['020 7946 0123'] };
    const before = structuredClone({ saved, identifiers });
    expect(contactQuickValues(saved, identifiers)).toEqual([
      { key: 'phone', kind: 'phone', value: '+442079460123' },
      { key: 'address', kind: 'address', value: '10 Downing street, London, SW1A 2AA, GB' },
      { key: 'extra-email-0', kind: 'email', value: 'zoe@work.test' },
      { key: 'extra-phone-0', kind: 'phone', value: '020 7946 0123' },
    ]);
    expect(contactQuickValues(contact(), undefined, 'shown@example.test')[0]?.value).toBe('shown@example.test');
    expect(contactQuickValues({ ...saved, merged_into: 'survivor@example.test' }, identifiers)).toEqual([]);
    expect(() => createContactVCard({ ...saved, merged_into: 'survivor@example.test' })).toThrow(/merged/);
    expect({ saved, identifiers }).toEqual(before);
  });

  it('makes dialable phone links without guessing a country or accepting URI or dial-code injection', () => {
    expect(contactPhoneHref('+44 (20) 7946-0123 ext. 42')).toBe('tel:+442079460123;ext=42');
    expect(contactPhoneHref('020 7946 0123')).toBe('tel:02079460123');
    expect(contactPhoneHref('+1.415.555.0123 x9')).toBe('tel:+14155550123;ext=9');
    for (const value of ['javascript:alert(1)', 'tel:+14155550123', '+14155550123;ext=9', '*21*123#', '+44\n12345', '123,456', '+1234567890123456'])
      expect(contactPhoneHref(value), value).toBeNull();
  });

  it('round trips multiple addresses and phones, structured postal data, Unicode, and yearless dates through the contact importer', () => {
    const saved = contact({ name: 'Zoë; Example, 🧭 \\Team', phone: '+442079460123', company: 'Example; Research, Ltd',
      title: 'Principal investigator', birthday: '--02-29', anniversary: '2020-06-15',
      mailing_address: { address1: '10 downing street', address2: 'unit; 4, west', city: 'london', state: 'london', zip: 'SW1A 2AA', country: 'GB' } });
    const identifiers = { emails: ['ZOE@example.test', 'zoe@work.test'], phones: ['+44 (20) 7946-0123', '020 7946 0123'] };
    const file = createContactVCard(saved, identifiers);
    const parsed = parseContactFile(file.content);
    expect(parsed.errors).toEqual([]); expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ name: saved.name, email: saved.email, emails: ['zoe@example.test', 'zoe@work.test'],
      phone: saved.phone, phones: [saved.phone, '020 7946 0123'], company: saved.company, title: saved.title,
      birthday: '--02-29', anniversary: '2020-06-15', address: saved.mailing_address });
    expect(formatContactMailingAddress(parsed.entries[0]!.address!)).toContain('unit; 4, west');
    expect(file.filename).toMatch(/^contact-.+\.vcf$/u);
  });

  it('escapes injected properties and folds UTF-8 without corrupting the saved name', () => {
    const name = '研究員🧭'.repeat(35) + ', \\Team';
    const file = createContactVCard(contact({ name, title: 'Lead\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:Injected' }));
    const physical = file.content.split('\r\n');
    expect(physical.some(line => line.startsWith(' '))).toBe(true);
    for (const line of physical) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(file.content.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(file.content.match(/^BEGIN:VCARD$/gm)).toHaveLength(1);
    const parsed = parseContactFile(Buffer.from(file.content, 'utf8').toString('utf8'));
    expect(parsed.errors).toEqual([]); expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.name).toBe(name);
    expect(parsed.entries[0]?.title).toBe('Lead\nEND:VCARD\nBEGIN:VCARD\nFN:Injected');
    expect(Buffer.byteLength(file.filename)).toBeLessThanOrEqual(255);
  });

  it('downloads a named contact without an email and keeps filename paths out of the download name', () => {
    const saved = contact({ name: '../CON:\\ Name\n\"🧭', email: mentionOnlyEmail('person') });
    const file = createContactVCard(saved);
    expect(file.content).not.toContain(saved.email);
    expect(file.content).not.toContain('EMAIL');
    expect(parseContactFile(file.content).entries[0]?.name).toBe(saved.name);
    expect(file.filename).not.toMatch(/[<>:"/\\|?*\r\n]/);
    expect(file.filename.endsWith('.vcf')).toBe(true);
  });
});
