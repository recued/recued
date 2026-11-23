import { expect, it } from 'vitest';
import { TASK_TITLE_MAX, type ContactRecord } from '@recued/contracts';
import { contactFollowUpValues, requireFollowUpContact } from '../contact-follow-up.js';
import { parseShellRoute } from '../../shell/route.js';

const contact: ContactRecord = { _id: 'person/id', _collection: 'contact', contact_id: "person/id?二.)!'*", email: 'riley@example.test', name: 'Riley <img src=x>',
  source: 'manual', created_at: 1, first_seen: 1, last_interaction: 1, interaction_count: 0, updated_at: 1 };

it('creates a reviewed task with the canonical profile URL and no inferred assignment', () => {
  const before = structuredClone(contact), values = contactFollowUpValues('task', contact, 'https://user:password@app.test/recued/index.html?token=secret#data/search');
  expect(values).toEqual({ title: 'Follow up with Riley <img src=x>', done: false, due_at: null,
    body: "Contact: https://app.test/recued/index.html#data/contact/person%2Fid%3F%E4%BA%8C.)!'*" });
  expect(parseShellRoute(new URL(String(values.body).slice(9)).hash).segments).toEqual(['contact', contact.contact_id]);
  expect(contact).toEqual(before);
  const long = contactFollowUpValues('task', { ...contact, name: '📝'.repeat(TASK_TITLE_MAX) }, 'https://app.test/');
  expect(String(long.title).length).toBeLessThanOrEqual(TASK_TITLE_MAX); expect(String(long.title)).not.toMatch(/[\ud800-\udbff]$/u);
  expect(() => contactFollowUpValues('task', contact, 'file:///app.html')).toThrow('contact link is unavailable');
});

it('starts an empty note linked only by the canonical contact ID', () => {
  expect(contactFollowUpValues('note', contact, 'https://app.test/')).toEqual({ title: '', body: '', related_contact: [contact.contact_id] });
  expect(() => contactFollowUpValues('note', { ...contact, contact_id: undefined }, 'https://app.test/')).toThrow('same identity');
});

it('accepts a renamed contact with the same ID and rejects missing, merged and replaced identities', () => {
  const renamed = { ...contact, email: 'new@example.test', name: 'New name' };
  expect(requireFollowUpContact(contact, renamed)).toBe(renamed);
  for (const current of [null, { ...contact, contact_id: undefined }, { ...contact, merged_into: 'survivor@example.test' }, { ...contact, contact_id: 'replacement' }, { ...contact, created_at: 2 }])
    expect(() => requireFollowUpContact(contact, current)).toThrow('same identity');
});
