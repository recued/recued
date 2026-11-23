import { expect, it, vi } from 'vitest';
import type { WorkEntity } from '@recued/contracts';
import { createRecordResultPreview, readRecordResultPreview, type RecordResultPreviewData } from '../record-result-preview.js';
import type { LinkOption } from '../record-link-insert.js';
import { readExactRecordLink, verifyExactRecordLink } from '../exact-record-link.js';
import { serializeSourceRecordAddress } from '../../shell/route.js';
const href = 'https://app.test/client/?pair=private';
const note: Extract<WorkEntity, { _kind: 'note' }> = { _kind: 'note', id: 'note-one', title: 'Current note', body: 'Literal <script>text</script> ' + '二🙂'.repeat(150), source_id: 'recued.note',
  created_at: 1, updated_at: 1, last_seen_at: 1, last_user_action_at: 1, sync_state: 'live', conflict_policy: 'recued_wins', related_contact_ids: [], related_project_ids: [], related_mail_thread_ids: [], related_calendar_event_ids: [] };
const option: LinkOption = { key: 'note', target: { tab: 'note', id: note.id, hash: '#data/note/note-one' }, title: 'Cached title', detail: 'Recued' };
const ready = (title = 'Current note'): Extract<RecordResultPreviewData, { state: 'ready' }> => ({ state: 'ready', title, details: ['Source: Recued'], excerpt: 'Bounded current text', reference: { key: 'identity', target: option.target, title, details: ['Note'], href: 'https://app.test/client/#data/note/note-one', identity: 'lifetime-one' } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const setup = () => {
  const current = { owner: 'query-one' as string | null, blocked: false }, read = vi.fn(async (_option: LinkOption): Promise<RecordResultPreviewData> => ready()), verify = vi.fn(async () => true), activate = vi.fn(), changed = vi.fn();
  const model = createRecordResultPreview({ owner: () => current.owner, blocked: () => current.blocked, read, verify, activate, changed }); model.bind([option]); return { model, current, read, verify, activate, changed };
};
it('reads only a registered explicit Preview and checks its displayed lifetime before activation', async () => {
  const f = setup(), held = deferred<RecordResultPreviewData>(); expect(f.read).not.toHaveBeenCalled(); await f.model.open('forged'); expect(f.read).not.toHaveBeenCalled();
  f.read.mockReturnValueOnce(held.promise); const pending = f.model.open(option.key); await f.model.open(option.key); expect(f.read).toHaveBeenCalledExactlyOnceWith(option); held.resolve(ready()); await pending;
  f.verify.mockResolvedValueOnce(false); await f.model.activate(); expect(f.activate).not.toHaveBeenCalled(); expect(f.model.state()?.error).toContain('removed or replaced');
  await f.model.activate(); expect(f.verify).toHaveBeenCalledWith(ready().reference); expect(f.activate).toHaveBeenCalledExactlyOnceWith(option.key, ready().reference); expect(f.model.state()).toBeNull();
});
it('retires late reads and Open replies after close, scope replacement, removal or disposal', async () => {
  for (const boundary of ['close', 'scope', 'remove', 'dispose'] as const) for (const phase of ['read', 'activate'] as const) {
    const f = setup(), read = deferred<RecordResultPreviewData>(), check = deferred<boolean>(); if (phase === 'read') f.read.mockReturnValueOnce(read.promise);
    const loading = f.model.open(option.key); if (phase === 'activate') await loading;
    f.verify.mockReturnValueOnce(check.promise); const activation = phase === 'activate' ? f.model.activate() : Promise.resolve();
    if (boundary === 'close') f.model.close(); if (boundary === 'scope') f.current.owner = 'another-pairing-or-query'; if (boundary === 'remove') f.model.bind([]); if (boundary === 'dispose') f.model.dispose();
    const paints = f.changed.mock.calls.length; read.resolve(ready('Late record')); check.resolve(true); await Promise.all([loading, activation]);
    expect(f.activate).not.toHaveBeenCalled(); expect(f.model.state()).toBeNull(); expect(f.changed).toHaveBeenCalledTimes(paints);
  }
});
it('invalidates a preview when a result key is reused with a different arrival and supports a clean retry after read failure', async () => {
  const f = setup(); f.read.mockRejectedValueOnce(Error('private credential diagnostic')); await f.model.open(option.key); expect(f.model.state()).toMatchObject({ state: 'error', message: 'This record could not be previewed. Try again.' });
  await f.model.open(option.key); expect(f.model.state()?.state).toBe('ready'); f.model.bind([{ ...option, received_at: 4 }]); expect(f.model.state()).toBeNull();
  f.current.blocked = true; await f.model.open(option.key); expect(f.read).toHaveBeenCalledTimes(2);
});
it('projects a bounded current excerpt without retaining it in ordinary exact-link lookup state', async () => {
  const work = vi.fn(async () => ({ entity: note })); const readers = { work };
  const ordinary = await readExactRecordLink(option.target, readers, href); expect(JSON.stringify(ordinary)).not.toContain('<script>'); work.mockClear();
  const preview = await readRecordResultPreview(option, readers, href); expect(work).toHaveBeenCalledExactlyOnceWith('note', note.id); expect(preview).toMatchObject({ state: 'ready', title: 'Current note', details: ['Source: Recued'] });
  if (preview.state !== 'ready') throw Error('Missing preview'); expect(Array.from(preview.excerpt!)).toHaveLength(181); expect(preview.excerpt).toContain('<script>'); expect(preview.excerpt).not.toMatch(/[\ud800-\udbff]$/u);
  await expect(verifyExactRecordLink(preview.reference, { work: async () => ({ entity: { ...note, created_at: 5 } }) }, href)).resolves.toBe(false);
});
it('reads the exact account and refuses a source result with a changed arrival', async () => {
  const target = { tab: 'calendar' as const, collectionSlug: 'home', recordId: 'same/id?二', hash: serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: 'home', recordId: 'same/id?二' }) };
  const row = { record_id: target.recordId, source_id: 'provider', received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: { summary: 'Current event', location: 'Room 2' }, body_inline: 'Saved event description.' };
  const source = vi.fn(async () => ({ record: row })); const selected = { ...option, target, received_at: 1 };
  await expect(readRecordResultPreview(selected, { source }, href)).resolves.toMatchObject({ state: 'ready', title: 'Current event', details: expect.arrayContaining(['Account: home']), excerpt: 'Saved event description.' });
  expect(source).toHaveBeenCalledExactlyOnceWith({ platform: 'calendar', slug: 'home', record_id: target.recordId });
  await expect(readRecordResultPreview({ ...selected, received_at: 2 }, { source }, href)).resolves.toMatchObject({ state: 'missing' });
});

it('refuses a stale visible trigger before the new query or pairing has rebound its result registry', async () => {
  const f = setup(); f.current.owner = 'query-two'; await f.model.open(option.key); expect(f.read).not.toHaveBeenCalled();
  f.model.bind([option]); await f.model.open(option.key); expect(f.read).toHaveBeenCalledExactlyOnceWith(option);
});
