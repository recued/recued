import { expect, it, vi } from 'vitest';
import type { Commitment, WorkEntityGetRpcResponse } from '@recued/contracts';
import { createCommitmentChat } from '../commitment-chat.js';
import { commitmentCopyText, createWorkReaderCopy, type WorkCopyOwner } from '../work-reader-copy.js';
import { parseRecordLinkQuery, readExactRecordLink } from '../exact-record-link.js';
import { readSelectedRecordsWire, selectedRecordsWire, verifySelectedRecord } from '../../chat/selected-records.js';
import { copyComposerRecoveryDraft } from '../../chat/draft-recovery.js';
import { serializeShellRoute } from '../../shell/route.js';

const entity: Commitment & { _kind: 'commitment' } = { _kind: 'commitment', id: 'promise/二?', source_id: 'recued.commitment',
  statement: 'Send <script>the proposal</script>', direction: 'outbound', promised_at: 100, lifecycle_state: 'pending', due_status: 'no_deadline',
  expiry_policy: 'indefinite', derivation: 'user_declared', state_changed_at: 100, lifecycle_changed_at: 100, due_status_changed_at: 100,
  created_at: 100, updated_at: 100, last_seen_at: 100, sync_state: 'live', conflict_policy: 'recued_wins', blocks_task_ids: [], blocks_project_ids: [] };
const href = 'https://app.test/tools/client/?pair=secret#data/search';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const setup = () => {
  const get = vi.fn(async (_args: { kind: string; id: string }): Promise<WorkEntityGetRpcResponse> => ({ entity }));
  const open = vi.fn(), beforeLeave = vi.fn(() => true), changed = vi.fn();
  const model = createCommitmentChat({ get, open, beforeLeave, changed, href: () => href });
  return { get, open, beforeLeave, changed, model };
};

it('copies the saved promise with contact, source, lifecycle and uncertainty without modifying it', () => {
  const before = structuredClone(entity);
  expect(commitmentCopyText(entity, { counterparty_label: 'Riley', source_label: 'Recued' })).toBe(
    'Send <script>the proposal</script>\nDirection: I owe\nSaved status: Open\nWith: Riley\nDeadline: No deadline\nSource: Recued');
  expect(commitmentCopyText({ ...entity, sync_state: 'stale_unreachable' })).toContain('This promise may be out of date.');
  expect(commitmentCopyText({ ...entity, pending_write: { operation: 'update', state: 'pending', staged_at: 200, dirty_fields: ['statement'] } })).toContain('waiting for source confirmation');
  expect(commitmentCopyText({ ...entity, counterparty_contact_id: 'missing' })).toContain('With: Contact unavailable');
  expect(entity).toEqual(before);
});

it('offers a captured commitment summary for manual copying and fences a result after its reader changed', async () => {
  let owner: WorkCopyOwner | null = { entity, version: 1, href, counterparty_label: 'Riley', source_label: 'Recued' };
  const write = vi.fn(async () => false), selectFallback = vi.fn();
  const copy = createWorkReaderCopy({ current: () => owner, blocked: () => false, write, beforeStart() {}, render() {}, focusAction() {}, actionFocused: () => true, selectFallback });
  await copy.copy('details'); expect(copy.state()?.fallback?.value).toBe(commitmentCopyText(entity, owner!)); expect(selectFallback).toHaveBeenCalledOnce();
  const held = deferred<boolean>(); write.mockReturnValueOnce(held.promise); const pending = copy.copy('link'); owner = null;
  held.resolve(false); await pending; expect(copy.state()).toBeUndefined();
});

it('opens an exact selected commitment reference that survives chat recovery without its contents or pairing secrets', async () => {
  const f = setup(); await f.model.ask(entity, () => true);
  expect(f.get).toHaveBeenCalledExactlyOnceWith({ kind: 'commitment', id: entity.id });
  expect(f.open).toHaveBeenCalledOnce(); const record = f.open.mock.calls[0]![0];
  expect(record.reference.target).toEqual({ tab: 'commitment', id: entity.id, hash: serializeShellRoute('data', 'commitment', entity.id) });
  const wire = selectedRecordsWire([record]); expect(wire).not.toContain('secret'); expect(wire).not.toContain('evidence_blob');
  expect(readSelectedRecordsWire(wire)?.[0]?.reference.identity).toBe(record.reference.identity);
  const recovery = copyComposerRecoveryDraft({ text: 'What should I do next?', protected: true, modelSourceId: null, selectedRecords: [record] });
  expect(recovery.selectedRecords?.[0]?.reference).toEqual(record.reference);
  expect(record.reference.href).toBe('https://app.test/tools/client/' + record.reference.target.hash);
});

it('rechecks the commitment incarnation when a pasted link is attached and again before sending', async () => {
  const target = { tab: 'commitment' as const, id: entity.id, hash: serializeShellRoute('data', 'commitment', entity.id) };
  expect(parseRecordLinkQuery('https://app.test/tools/client/' + target.hash, href)).toEqual({ kind: 'link', target });
  let current = entity; const readers = { work: async () => ({ entity: current }) };
  const result = await readExactRecordLink(target, readers, href); expect(result.state).toBe('ready'); if (result.state !== 'ready') return;
  expect(result.match.details).toContain('Saved status: Open');
  const record = readSelectedRecordsWire(selectedRecordsWire([{ reference: result.match }]))![0]!;
  expect(await verifySelectedRecord(record, readers, href)).toBe(true);
  current = { ...entity, created_at: 500 }; expect(await verifySelectedRecord(record, readers, href)).toBe(false);
});

it('refuses missing, deleted and replaced commitments without opening chat', async () => {
  for (const current of [null, { ...entity, created_at: 500 }, { ...entity, source_record_id: 'replacement' }, { ...entity, deleted_at: 500 }]) {
    const f = setup(); f.get.mockResolvedValue({ entity: current }); await f.model.ask(entity, () => true);
    expect(f.open).not.toHaveBeenCalled(); expect(f.model.view(entity).error).toContain('removed or replaced');
  }
});

it('retires an old check without blocking or changing a new commitment handoff', async () => {
  const f = setup(), held = deferred<WorkEntityGetRpcResponse>(); let current = true;
  f.get.mockReturnValueOnce(held.promise); const first = f.model.ask(entity, () => current);
  await f.model.ask(entity, () => current); expect(f.get).toHaveBeenCalledTimes(1);
  current = false; const next = { ...entity, id: 'promise-two' }; f.get.mockResolvedValueOnce({ entity: next });
  await f.model.ask(next, () => true); held.resolve({ entity }); await first;
  expect(f.open).toHaveBeenCalledOnce(); expect(f.open.mock.calls[0]![0].reference.target.id).toBe(next.id);
  expect(f.model.view(next).error).toBeUndefined();
});

it('honors draft protection before the check and again if a draft opens during it', async () => {
  const f = setup(); f.beforeLeave.mockReturnValueOnce(false); await f.model.ask(entity, () => true); expect(f.get).not.toHaveBeenCalled();
  const held = deferred<WorkEntityGetRpcResponse>(); f.get.mockReturnValueOnce(held.promise); const pending = f.model.ask(entity, () => true);
  f.beforeLeave.mockReturnValue(false); held.resolve({ entity }); await pending;
  expect(f.open).not.toHaveBeenCalled(); expect(f.model.view(entity).busy).toBe(false);
});
