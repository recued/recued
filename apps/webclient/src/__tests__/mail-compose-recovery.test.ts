import { describe, expect, it } from 'vitest';
import { EMPTY_MAIL_COMPOSE_VALUES, composeStateToSendPayload } from '@recued/contracts';
import {
  createMailRecoveryStore, MAIL_RECOVERY_LIMITS, parseMailRecovery,
  type MailRecoveryEntry, type MailRecoveryStorage,
} from '../mail/compose-recovery.js';

const NOW = 1_800_000_000_000;
const entry = (n = 1): MailRecoveryEntry => ({
  id: `mcr_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  updatedAt: NOW,
  mailbox: { id: 'work', slug: 'work', email: 'owner@example.test' },
  dialog: { mode: 'create', values: { ...EMPTY_MAIL_COMPOSE_VALUES,
    sender_source: 'work', subject: 'Scope question', body: 'My unfinished message.',
    to: ['  unfinished@', '', 'Team <'], cc: ['copy@'], bcc: [], attachments: ['file:' + '1'.repeat(32)],
  } },
  brief: 'Ask for the revised scope.', replyContext: null, copyRecipientsOpen: true, saved: null, status: 'editing',
});
const fixture = () => {
  const data = new Map<string, string>();
  let blocked = false;
  const storage: MailRecoveryStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { if (blocked) throw new Error('Quota exceeded'); data.set(key, value); },
    removeItem: key => { if (blocked) throw new Error('Storage denied'); data.delete(key); },
  };
  return { data, storage, block: () => { blocked = true; },
    store: createMailRecoveryStore({ scope: 'paired-server-a', storage, now: () => NOW }) };
};

describe('same-tab mail form recovery', () => {
  it('reports unreadable storage and refuses changes without erasing another recovery copy', () => {
    const { storage } = fixture(); let blocked = false;
    const store = createMailRecoveryStore({ scope: 'pair', now: () => NOW, storage: { ...storage,
      getItem: key => { if (blocked) throw Error('Read denied'); return storage.getItem(key); },
    } });
    store.save(entry()); const before = store.list();
    blocked = true;
    expect(store.inspect()).toEqual({ entries: [], unavailable: true });
    expect(store.save(entry(2))).toBe(false); expect(store.remove(entry().id)).toBe(false);
    blocked = false; expect(store.inspect()).toEqual({ entries: before, unavailable: false });
  });
  it('retains the selected contact only while the draft still addresses that contact', () => {
    const { store, storage } = fixture();
    const draft = entry(); draft.dialog.values.to = ['alex@example.test'];
    draft.contactContext = { id: 'contact-alex', name: 'Alex Rivera', email: 'alex@example.test' };
    expect(store.save(draft)).toBe(true);
    const restored = createMailRecoveryStore({ scope: 'paired-server-a', storage, now: () => NOW }).get(draft.id);
    expect(restored?.contactContext).toEqual(draft.contactContext);
    const changed = { ...draft, dialog: { ...draft.dialog, values: { ...draft.dialog.values, to: ['blair@example.test'] } } };
    const other = parseMailRecovery(changed, NOW)!;
    expect(other.contactContext).toBeUndefined();
    expect(other.dialog.values.body).toBe(draft.dialog.values.body);
    expect(parseMailRecovery({ ...draft, contactContext: { ...draft.contactContext, id: 'bad\nref' } }, NOW)?.contactContext).toBeUndefined();
  });

  it('round-trips incomplete fields exactly without making them valid send payloads', () => {
    const { store, storage } = fixture();
    const draft = entry(); draft.dialog.values.body = 'Hello 👋\nA second line.\n';
    expect(store.save(draft)).toBe(true);
    const restored = createMailRecoveryStore({ scope: 'paired-server-a', storage, now: () => NOW }).get(draft.id);
    expect(restored).toEqual(draft);
    expect(composeStateToSendPayload(restored!.dialog.values, {
      resolveContactEmail: () => null,
      findSenderSource: () => ({ id: 'work', label: 'Work', account_email: 'owner@example.test',
        mail_instance_slug: 'work', send_capable: true, draft_capable: true }),
    }).ok).toBe(false);
  });

  it('keeps recovery separate for another server identity or paired profile', () => {
    const { store, storage } = fixture(); expect(store.save(entry())).toBe(true);
    for (const scope of ['paired-server-b', 'paired-server-a:other-profile']) {
      const other = createMailRecoveryStore({ scope, storage, now: () => NOW });
      expect(other.list()).toEqual([]);
      expect(other.save({ ...entry(), brief: 'Other profile' })).toBe(true);
    }
    expect(store.get(entry().id)?.brief).toBe('Ask for the revised scope.');
  });

  it('rejects mismatched reply and mailbox anchors and projects only known context', () => {
    const draft = entry(); draft.dialog.mode = 'reply'; draft.dialog.values.in_reply_to = '<parent@example.test>';
    draft.replyContext = { original_source_id: 'work', mailbox_address: 'OWNER@example.test',
      original_message: { id: '<parent@example.test>', from: 'lead@example.test', subject: 'Question',
        body: 'Original request', references: ['<root@example.test>'], thread_id: 'opaque-provider-thread' } };
    expect(parseMailRecovery(draft, NOW)?.replyContext?.original_message).not.toHaveProperty('thread_id');
    const differentMessage = structuredClone(draft); differentMessage.dialog.values.in_reply_to = '<other@example.test>';
    expect(parseMailRecovery(differentMessage, NOW)).toBeNull();
    const differentSource = structuredClone(draft); differentSource.replyContext!.original_source_id = 'other';
    expect(parseMailRecovery(differentSource, NOW)).toBeNull();
    const differentAccount = structuredClone(draft); differentAccount.replyContext!.mailbox_address = 'new-owner@example.test';
    expect(parseMailRecovery(differentAccount, NOW)).toBeNull();
  });

  it('expires old entries and ignores malformed, oversized, or unbound submitted records', () => {
    const { store, data } = fixture(); store.save(entry());
    const key = [...data.keys()][0]!;
    data.set(key, '{broken'); expect(store.list()).toEqual([]);
    const expired = { ...entry(2), updatedAt: NOW - MAIL_RECOVERY_LIMITS.age - 1 };
    const oversized = entry(3); oversized.dialog.values.body = '界'.repeat(90_000);
    data.set(key, JSON.stringify([entry(), expired, oversized, { ...entry(4), status: 'pending' }]));
    expect(store.list().map(row => row.id)).toEqual([entry().id]);
    expect(parseMailRecovery({ ...entry(), updatedAt: NOW + 60_001 }, NOW)).toBeNull();
    expect(parseMailRecovery({ ...entry(), dialog: { ...entry().dialog, values: { ...entry().dialog.values, body: 42 } } }, NOW)).toBeNull();
  });

  it('refuses full or oversized checkpoints without evicting another unfinished message', () => {
    const { store } = fixture();
    for (let n = 1; n <= MAIL_RECOVERY_LIMITS.entries; n++) expect(store.save(entry(n))).toBe(true);
    const before = store.list(); expect(store.save(entry(9))).toBe(false); expect(store.list()).toEqual(before);
    const oversized = entry(); oversized.dialog.values.body = '界'.repeat(90_000);
    expect(store.save(oversized)).toBe(false); expect(store.list()).toEqual(before);
  });

  it('reports blocked storage and never converts a pending attempt back to editable work', () => {
    const { store, block } = fixture();
    const pending = { ...entry(), status: 'pending' as const, attempt: 'attempt-1' };
    expect(store.save(pending)).toBe(true); block();
    expect(store.settle(pending.id, pending.attempt, 'held')).toBe(false);
    expect(store.remove(pending.id)).toBe(false);
    expect(store.get(pending.id)?.status).toBe('pending');
    expect(createMailRecoveryStore({ scope: 'unavailable', storage: null }).save(entry())).toBe(false);
  });

  it('settles only the exact attempt, including late responses after a form was discarded', () => {
    const { store } = fixture();
    const pending = { ...entry(), status: 'pending' as const, attempt: 'attempt-1' };
    store.save(pending); store.save({ ...entry(2), status: 'pending', attempt: 'attempt-2' });
    expect(store.settle(pending.id, 'stale-attempt', 'sent')).toBe(false);
    expect(store.settle(pending.id, pending.attempt, 'unknown')).toBe(true);
    expect(store.get(pending.id)?.status).toBe('unknown');
    expect(store.settle(pending.id, pending.attempt, 'held')).toBe(true);
    expect(store.get(pending.id)?.status).toBe('held');
    expect(store.get(entry(2).id)?.status).toBe('pending');
    expect(store.settle(pending.id, pending.attempt, 'sent')).toBe(true);
    expect(store.get(pending.id)).toBeNull();
    expect(store.settle(pending.id, pending.attempt, 'held')).toBe(false);
  });
});
