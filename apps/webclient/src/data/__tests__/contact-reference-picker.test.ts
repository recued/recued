import { expect, it, vi } from 'vitest';
import type { ContactRecord } from '@recued/contracts';
import type { DataContactGetCaller, DataContactListCaller } from '../bootstrap-data-route.js';
import { contactRefOption, loadContactReference, searchContactReferences } from '../contact-reference-picker.js';

const person: ContactRecord = { _id: 'riley@example.test', _collection: 'contact', email: 'riley@example.test', contact_id: 'person-id', name: 'Riley <review>',
  source: 'manual', first_seen: 1, last_interaction: 1, interaction_count: 0, created_at: 1, updated_at: 1 };

it('resolves stable IDs and emails to display text without returning a replacement reference', async () => {
  const get = vi.fn<DataContactGetCaller>(async () => ({ contact: person }));
  for (const id of [person.contact_id!, person.email, 'RILEY@EXAMPLE.TEST']) {
    expect(await loadContactReference(get, id)).toEqual({ state: 'ready', label: person.name, message: person.email, searchQuery: person.name });
    expect(get).toHaveBeenLastCalledWith({ email: id });
  }
});

it('follows a legacy merged email, accepts a server-resolved stable ID and guards redirect loops', async () => {
  const survivor = { ...person, contact_id: 'survivor', email: 'current@example.test', name: 'Current name' };
  const get = vi.fn<DataContactGetCaller>(async ({ email }) => ({ contact: email === person.email ? { ...person, merged_into: survivor.email } : survivor }));
  expect(await loadContactReference(get, person.email)).toMatchObject({ label: survivor.name, message: survivor.email + ' · Merged contact.' });
  expect(get.mock.calls.map(([args]) => args.email)).toEqual([person.email, survivor.email]);
  expect(await loadContactReference(get, person.contact_id!)).toMatchObject({ label: survivor.name });
  get.mockResolvedValue({ contact: { ...person, merged_into: person.email } });
  await expect(loadContactReference(get, person.email)).rejects.toThrow('redirect could not be confirmed');
});

it('keeps missing and failed lookups distinct, rejects an unrelated email response and retires a redirect before its next read', async () => {
  const get = vi.fn<DataContactGetCaller>(async () => ({ contact: null }));
  expect(await loadContactReference(get, person.email)).toMatchObject({ state: 'missing', label: 'Unavailable contact' });
  get.mockResolvedValueOnce({} as never); await expect(loadContactReference(get, person.email)).rejects.toThrow('could not be confirmed');
  get.mockRejectedValueOnce(new Error('Lookup interrupted')); await expect(loadContactReference(get, person.email)).rejects.toThrow('Lookup interrupted');
  await expect(loadContactReference(undefined, person.email)).rejects.toThrow('unavailable on this server');
  get.mockResolvedValue({ contact: { ...person, email: 'unrelated@example.test' } }); await expect(loadContactReference(get, person.email)).rejects.toThrow('could not be confirmed');
  let current = true;
  get.mockImplementation(async () => { current = false; return { contact: { ...person, merged_into: 'survivor@example.test' } }; });
  const calls = get.mock.calls.length; await expect(loadContactReference(get, person.email, () => current)).rejects.toThrow('retired');
  expect(get).toHaveBeenCalledTimes(calls + 1);
});

it('shows people without exposing mention-only mailbox placeholders', async () => {
  const email = 'mention-only-01ARZ3NDEKTSV4RRFFQ69G5FAV@_recued.invalid';
  const unnamed = { ...person, email, name: undefined };
  expect(contactRefOption(unnamed)).toEqual({ id: email, label: 'Unnamed contact' });
  expect(await loadContactReference(async () => ({ contact: unnamed }), email)).toEqual({ state: 'ready', label: 'Unnamed contact', message: 'No email address', searchQuery: undefined });
});

it('searches the owner inventory, disambiguates equal names and reports a capped result page', async () => {
  const search = vi.fn<DataContactListCaller>(async () => ({ contacts: [person, { ...person, email: 'another@example.test' }], total: 25 }));
  expect(await searchContactReferences(search, ' Riley ')).toEqual({ options: [contactRefOption(person), contactRefOption({ ...person, email: 'another@example.test' })], truncated: true });
  expect(search).toHaveBeenCalledExactlyOnceWith({ query: 'Riley', limit: 20, offset: 0 });
  expect(await searchContactReferences(search, '')).toEqual({ options: [] }); expect(search).toHaveBeenCalledTimes(1);
});

it('does not turn unavailable or malformed search results into an empty successful inventory', async () => {
  expect(await searchContactReferences(undefined, 'Riley')).toMatchObject({ options: [], retryableError: expect.any(String) });
  const search = vi.fn<DataContactListCaller>(); search.mockRejectedValueOnce(new Error('Search interrupted'));
  expect(await searchContactReferences(search, 'Riley')).toMatchObject({ retryableError: expect.stringContaining('Search interrupted') });
  for (const page of [{ contacts: [person], total: 0 }, { contacts: [person, person], total: 2 }, { contacts: [{ ...person, merged_into: 'other@example.test' }], total: 1 }]) {
    search.mockResolvedValueOnce(page); expect(await searchContactReferences(search, 'Riley')).toMatchObject({ options: [], retryableError: expect.any(String) });
  }
});
