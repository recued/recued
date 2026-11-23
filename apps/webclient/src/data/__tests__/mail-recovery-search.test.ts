import { expect, it } from 'vitest';
import { EMPTY_MAIL_COMPOSE_VALUES } from '@recued/contracts';
import { createMailRecoveryStore, type MailRecoveryEntry } from '../../mail/compose-recovery.js';
import { mailRecoverySearchStore } from '../mail-recovery-search.js';
import { resolveRecoveryDraft, searchRecoveryDrafts } from '../recovery-draft-search.js';
import { renderUniversalSearch } from '../universal-search.js';
import { searchTypeCounts } from '../universal-search-filter.js';

const now = Date.parse('2026-11-21T12:00Z');
const setup = () => {
  const rows = new Map<string, string>(); let blocked = false;
  const storage = { getItem: (key: string) => { if (blocked) throw Error('unreadable'); return rows.get(key) ?? null; },
    setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const store = createMailRecoveryStore({ scope: 'pair', storage, now: () => now });
  const entry: MailRecoveryEntry = { id: 'mcr_' + crypto.randomUUID(), updatedAt: now,
    mailbox: { id: 'internal-mailbox', slug: 'work', email: 'owner@example.test' }, status: 'editing',
    dialog: { mode: 'reply', values: { ...EMPTY_MAIL_COMPOSE_VALUES, sender_source: 'internal-mailbox',
      subject: 'Café planning', body: 'The Kestrel proposal.', to: ['recipient@example.test'], cc: ['copy@example.test'], bcc: ['private@example.test'],
      attachments: ['file:opaqueattachment'], in_reply_to: '<opaque-message-id>' } },
    brief: 'Ask about the deadline.', copyRecipientsOpen: true, saved: null,
    replyContext: { original_source_id: 'internal-mailbox', original_message: { id: '<opaque-message-id>', subject: 'Unsearched original',
      from: 'original@example.test', body: 'Original-only secret text' } } };
  expect(store.save(entry)).toBe(true);
  return { store, entry, storage, stores: { mail: mailRecoverySearchStore(store)! }, block: (value: boolean) => { blocked = value; } };
};

it('finds current email fields, recipients and AI instructions while excluding identifiers and original-message text', () => {
  const f = setup();
  for (const query of ['cafe\u0301', 'Kestrel', 'deadline', 'recipient@', 'copy@', 'private@', 'owner@']) {
    expect(searchRecoveryDrafts(f.stores, query).matches.map(row => row.id)).toEqual([f.entry.id]);
  }
  for (const query of ['internal-mailbox', 'opaque-message-id', 'opaqueattachment', 'Original-only secret']) {
    expect(searchRecoveryDrafts(f.stores, query).matches).toEqual([]);
  }
  const match = searchRecoveryDrafts(f.stores, 'kestrel').matches[0]!;
  expect(match).toMatchObject({ kind: 'mail', mailStatus: 'editing', title: 'Café planning', editingExisting: false });
  expect(resolveRecoveryDraft(f.stores, match)?.values).toMatchObject({ mail: f.entry });
  expect(f.store.list()).toEqual([f.entry]);
});

it('rejects changed email content even at the same timestamp and preserves pairing ownership', () => {
  const f = setup(), match = searchRecoveryDrafts(f.stores, 'kestrel').matches[0]!;
  const updated = { ...f.entry, dialog: { ...f.entry.dialog, values: { ...f.entry.dialog.values, attachments: ['file:newattachment'] } } };
  expect(f.store.save(updated)).toBe(true); expect(resolveRecoveryDraft(f.stores, match)).toBeNull();
  const foreign = createMailRecoveryStore({ scope: 'other-pair', storage: f.storage, now: () => now });
  const other = { mail: mailRecoverySearchStore(foreign)! };
  expect(searchRecoveryDrafts(other, '').matches).toEqual([]); expect(resolveRecoveryDraft(other, match)).toBeNull();
  const fresh = searchRecoveryDrafts(f.stores, 'kestrel').matches[0]!;
  f.store.remove(fresh.id); expect(resolveRecoveryDraft(f.stores, fresh)).toBeNull();
});

it('shows unavailable recovery separately from empty results and can refresh after storage is readable', () => {
  const f = setup(); f.block(true);
  expect(searchRecoveryDrafts(f.stores, '')).toMatchObject({ available: true, matches: [], issues: ['Email recovery copies could not be read. Try Refresh drafts.'] });
  f.block(false); expect(searchRecoveryDrafts(f.stores, '').matches).toHaveLength(1);
});

it('includes email recoveries under Drafts and names an approval hold separately from an unconfirmed send', () => {
  const f = setup();
  f.store.save({ ...f.entry, status: 'held', attempt: 'send-attempt' });
  const recoveryDraftSearch = searchRecoveryDrafts(f.stores, 'kestrel');
  const props = { query: 'kestrel', actionAttr: 'data-action', resultType: 'draft' as const, recoveryDraftSearch };
  expect(searchTypeCounts(props).draft.loaded).toBe(1);
  const html = renderUniversalSearch(props);
  expect(html).toContain('Waiting for your approval'); expect(html).not.toContain('Save not confirmed');
  expect(html).toContain('Review submitted email draft Café planning');
  f.store.save({ ...f.entry, status: 'unknown', attempt: 'send-attempt' });
  expect(renderUniversalSearch({ ...props, recoveryDraftSearch: searchRecoveryDrafts(f.stores, 'kestrel') })).toContain('Send outcome not confirmed');
});
