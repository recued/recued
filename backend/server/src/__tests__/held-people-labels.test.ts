/** D-336 (spec §41) — an approval names the people a held call carries, wherever it carries
 *  them: a contact's address as `Mia Whitfield <…>`, a Recued contact id as `Mia Whitfield`.
 *  Told "Email Mia …" beside a contact Mia Whitfield, the AI emailed her without asking in 6 of
 *  6 runs, and the approval showed only her address (§40); the same holds for an invite, a
 *  task or a commitment aimed at her. */

import { describe, expect, it, vi } from 'vitest';
import { ANY_ARGUMENT, renderBatchItemsBlock, type ContactRecord } from '@recued/contracts';

import { heldPeopleValueLabels, type PeopleLookups } from '../held-people-labels.js';

const MIA_ID = '0123456789abcdef0123456789abcdef';
const ROWS: Record<string, Partial<ContactRecord>> = {
  'mia.whitfield@example.test': { email: 'mia.whitfield@example.test', name: 'Mia Whitfield', contact_id: MIA_ID, phone: '+15551234567' },
  // Two contacts share this number, so it names neither.
  'dana@example.com': { email: 'dana@example.com', name: 'Dana', phone: '+15550000000' },
  'sam@example.com': { email: 'sam@example.com', name: 'Sam', phone: '+15550000000' },
  'nameless@example.com': { email: 'nameless@example.com', name: '  ', contact_id: 'ffffffffffffffffffffffffffffffff' },
  'self@example.com': { email: 'self@example.com', name: 'SELF@example.com' },
  // A name that is an address says no more than one.
  'alias@example.com': { email: 'alias@example.com', name: 'boss@example.com' },
  // A contact known only by a name keeps a placeholder address, which no mail reaches.
  'mention-only-ct-1@_recued.invalid': { email: 'mention-only-ct-1@_recued.invalid', name: 'Pat' },
};
const contacts = (over: Partial<PeopleLookups> = {}): PeopleLookups => ({
  resolveCanonicalEmail: (email: string) => ({ canonical_email: email.toLowerCase(), chain_depth: 0 }),
  get: (email: string) => (ROWS[email] ?? null) as ContactRecord | null,
  getByContactIdResolved: (id: string) => (Object.values(ROWS).find((row) => row.contact_id === id) ?? null) as ContactRecord | null,
  findByPhone: (phone: string) => {
    const found = Object.values(ROWS).filter((row) => row.phone === phone) as ContactRecord[];
    return found.length === 1 ? { contact: found[0]!, confidence: 1, alternatives: [] } : { contact: null, confidence: 0, alternatives: found };
  },
  ...over,
}) as PeopleLookups;
const MIA = 'Mia Whitfield <mia.whitfield@example.test>';

describe('heldPeopleValueLabels', () => {
  it('names a contact\'s address anywhere in the call, and a contact id by the name', () => {
    const call = {
      event: { title: 'Dinner', attendees: [{ email: 'mia.whitfield@example.test' }, { email: 'bob@example.com' }] },
      assigned_contact_id: 'Mia.Whitfield@Example.test',
      counterparty_contact_id: MIA_ID,
    };
    const labels = heldPeopleValueLabels([call], contacts());
    expect(labels).toEqual({ [ANY_ARGUMENT]: {
      'mia.whitfield@example.test': MIA,
      'Mia.Whitfield@Example.test': 'Mia Whitfield <Mia.Whitfield@Example.test>',
      [MIA_ID]: 'Mia Whitfield',
    } });
    // As the approval reads them.
    const block = renderBatchItemsBlock([{ summary: 'x', args_preview: call }], labels);
    expect(block).toContain(`attendees: 2: {email: ${MIA}}, {email: bob@example.com}`);
    // Each on a line of its own: a person is what the call is aimed at, not an id folded away.
    expect(block).toContain('\n  assigned_contact_id: Mia Whitfield <Mia.Whitfield@Example.test>');
    expect(block).toContain('\n  counterparty_contact_id: Mia Whitfield');
    expect(block).not.toContain('ids:');
  });

  it('names no one who is not a named contact', () => {
    const labels = heldPeopleValueLabels([{
      to: ['stranger@example.com', 'nameless@example.com', 'self@example.com', 'alias@example.com', 'mention-only-ct-1@_recued.invalid'],
      // An id of no contact, and text that only mentions an address.
      ref: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', note: 'Mia <mia.whitfield@example.test>', count: 3,
    }], contacts());
    expect(labels).toBeUndefined();
  });

  it('a lookup that throws costs that label only, never the hold', () => {
    const labels = heldPeopleValueLabels([{ to: ['broken@example.com', 'mia.whitfield@example.test'] }], contacts({
      resolveCanonicalEmail: (email: string) => {
        if (email === 'broken@example.com') throw new Error('db gone');
        return { canonical_email: email, chain_depth: 0 };
      },
    }));
    expect(labels).toEqual({ [ANY_ARGUMENT]: { 'mia.whitfield@example.test': MIA } });
  });

  it('reads as far as a person reads: 100 lookups, 8 levels down', () => {
    const get = vi.fn(() => null);
    const many = Array.from({ length: 150 }, (_, i) => `person${String(i)}@example.com`);
    heldPeopleValueLabels([{ to: many }], contacts({ get }));
    expect(get).toHaveBeenCalledTimes(100);
    const nested = (levels: number): unknown => {
      let value: unknown = 'mia.whitfield@example.test';
      for (let i = 0; i < levels; i += 1) value = { next: value };
      return value;
    };
    expect(heldPeopleValueLabels([nested(8)], contacts())).toBeDefined();
    expect(heldPeopleValueLabels([nested(9)], contacts())).toBeUndefined();
  });

  // D-336 (spec §42) — an email passed encoded (Gmail's `send_raw`): the people its headers name.
  it('names the people an encoded email\'s headers send to, never those in its body', () => {
    const raw = Buffer.from('To: Mia <mia.whitfield@example.test>\r\nCc: bob@example.com\r\nSubject: Late\r\n\r\n'
      + 'Forwarding to self@example.com', 'utf8').toString('base64url');
    expect(heldPeopleValueLabels([{ body: { raw } }], contacts())).toEqual({ [ANY_ARGUMENT]: { 'mia.whitfield@example.test': MIA } });
    expect(renderBatchItemsBlock([{ summary: 'x', args_preview: { body: { raw } } }], heldPeopleValueLabels([{ body: { raw } }], contacts())))
      .toBe(`  body.raw: An email to ${MIA}; cc: bob@example.com; subject: Late`);
  });

  // D-336 (spec §44) — a phone number one contact has, as an SMS or a call goes to it.
  it('names a phone number one contact has, written as passed; a shared one, or no one\'s, names no one', () => {
    const labels = heldPeopleValueLabels([{
      body: { To: '+1 (555) 123-4567', From: '+15550000000' }, guest: { phoneNumber: '+15559999999' },
    }], contacts());
    expect(labels).toEqual({ [ANY_ARGUMENT]: { '+1 (555) 123-4567': 'Mia Whitfield (+1 (555) 123-4567)' } });
    expect(renderBatchItemsBlock([{ summary: 'x', args_preview: { body: { To: '+1 (555) 123-4567', Body: 'Late' } } }], labels))
      .toContain('To: Mia Whitfield (+1 (555) 123-4567)');
  });

  it('a date, an amount or a number with no country is never looked up as a phone', () => {
    const findByPhone = vi.fn(() => ({ contact: null, confidence: 0, alternatives: [] }));
    heldPeopleValueLabels([{ due: '2026-11-02', amount: '1234567', ref: '555 1234', at: '10:30' }], contacts({ findByPhone }));
    expect(findByPhone).not.toHaveBeenCalled();
  });

  it('nothing to read with, or nothing found: no labels', () => {
    expect(heldPeopleValueLabels([{ to: 'mia.whitfield@example.test' }], undefined)).toBeUndefined();
    expect(heldPeopleValueLabels([undefined, null, 'x', { subject: 'Late' }], contacts())).toBeUndefined();
  });
});
