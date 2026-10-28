/** D-333 — Kitchen keeps work in progress as you type, one write at a time, and never over
 *  work that changed elsewhere. */
import { describe, expect, it, vi } from 'vitest';
import type { KitchenImportDraft } from '@recued/contracts';
import { createWorkItemAutosave, type WorkItemAutosaveStatus } from '../work-item-autosave.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const item = (draft_id: string, revision: number, source = '{}'): KitchenImportDraft => ({
  draft_id, kind: 'recipe', title: 'New recipe', source, source_hash: 'h', revision, created_at: 1, updated_at: 1,
  validation: { valid: true, issues: [], total_issues: 0 },
});
const rpcError = (code: string): Error => Object.assign(new Error(code), { code });

const rig = () => {
  const timers: Array<() => void> = [];
  const calls: string[] = [];
  const replies: Array<ReturnType<typeof deferred<KitchenImportDraft>>> = [];
  const next = () => { const reply = deferred<KitchenImportDraft>(); replies.push(reply); return reply.promise; };
  const statuses: WorkItemAutosaveStatus[] = [];
  const onCreated = vi.fn();
  const discard = vi.fn(async () => ({ discarded: true }));
  const autosave = createWorkItemAutosave({
    kind: 'recipe',
    create: async (_kind, source) => { calls.push(`create ${source}`); return next(); },
    update: async (id, revision, source) => { calls.push(`update ${id}@${revision} ${source}`); return next(); },
    discard,
    onCreated,
    onStatus: (status) => statuses.push(status),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (handle) => { timers[(handle as number) - 1] = () => {}; },
  });
  const tick = (): void => { const run = timers.splice(0); for (const fn of run) fn(); };
  return { autosave, calls, replies, statuses, onCreated, discard, tick };
};

describe('Kitchen work in progress — autosave (D-333)', () => {
  it('stops without writing what is pending, once the write in flight lands', async () => {
    const r = rig();
    r.autosave.changed('{"a":1}');
    r.tick(); // the create is in flight
    r.autosave.changed('{"a":2}'); // waiting behind it
    expect(r.autosave.unwritten()).toBe(true);
    const stopped = r.autosave.stop();
    r.replies[0]!.resolve(item('w1', 1));
    expect(await stopped).toEqual({ draft_id: 'w1', revision: 1 });
    r.tick();
    await settle();
    expect(r.calls).toEqual(['create {"a":1}']); // the pending edit was dropped
    expect(r.autosave.unwritten()).toBe(true); // and is still known as never written
    r.autosave.changed('{"a":3}'); // nothing more is kept
    r.tick();
    expect(r.calls).toHaveLength(1);
    expect(r.discard).not.toHaveBeenCalled(); // stopping is not discarding
  });

  it('creates the item at the first pause, then updates it at the revision it last saw', async () => {
    const r = rig();
    r.autosave.changed('{"a":1}');
    r.autosave.changed('{"a":2}');
    expect(r.calls).toEqual([]); // nothing until the pause
    r.tick();
    expect(r.calls).toEqual(['create {"a":2}']); // only the latest
    r.replies[0]!.resolve(item('w1', 1));
    await settle();
    expect(r.onCreated).toHaveBeenCalledTimes(1);
    expect(r.autosave.current()).toEqual({ draft_id: 'w1', revision: 1 });
    r.autosave.changed('{"a":3}');
    r.tick();
    expect(r.calls.at(-1)).toBe('update w1@1 {"a":3}');
    r.replies[1]!.resolve(item('w1', 2));
    await settle();
    expect(r.autosave.current()).toEqual({ draft_id: 'w1', revision: 2 });
    expect(r.statuses.at(-1)).toEqual({ state: 'saved' });
    expect(r.autosave.busy()).toBe(false);
  });

  it('writes one at a time: edits made during a write go right after it', async () => {
    const r = rig();
    r.autosave.changed('{"a":1}'); r.tick();
    r.autosave.changed('{"a":2}'); r.tick(); // a write is in flight: this waits
    expect(r.calls).toEqual(['create {"a":1}']);
    expect(r.autosave.busy()).toBe(true);
    r.replies[0]!.resolve(item('w1', 1));
    await settle();
    r.tick();
    expect(r.calls).toEqual(['create {"a":1}', 'update w1@1 {"a":2}']);
  });

  it('stops at a conflict and never writes over work that changed elsewhere', async () => {
    const r = rig();
    r.autosave.changed('{"a":1}'); r.tick();
    r.replies[0]!.resolve(item('w1', 1)); await settle();
    r.autosave.changed('{"a":2}'); r.tick();
    r.replies[1]!.reject(rpcError('conflict')); await settle();
    expect(r.statuses.at(-1)).toMatchObject({ state: 'stopped' });
    r.autosave.changed('{"a":3}'); r.tick();
    expect(r.calls).toHaveLength(2);
  });

  it('keeps going after another failure, at the next change', async () => {
    const r = rig();
    r.autosave.changed('{"a":1}'); r.tick();
    r.replies[0]!.reject(new Error('socket closed')); await settle();
    expect(r.statuses.at(-1)).toMatchObject({ state: 'error' });
    expect(r.autosave.current()).toBeUndefined();
    r.autosave.changed('{"a":2}'); r.tick();
    expect(r.calls.at(-1)).toBe('create {"a":2}');
  });

  it('discards the item once its work is saved as the real thing, after the write in flight', async () => {
    const r = rig();
    r.autosave.changed('{"a":1}'); r.tick();
    r.autosave.changed('{"a":2}'); // pending, never written: the saved recipe holds it
    const finishing = r.autosave.finish();
    expect(r.discard).not.toHaveBeenCalled(); // waits for the write in flight
    r.replies[0]!.resolve(item('w1', 1)); await settle();
    await finishing;
    expect(r.discard).toHaveBeenCalledWith('w1', 1);
    expect(r.calls).toEqual(['create {"a":1}']);
  });

  it('writes the last edits at once when the page closes', async () => {
    const r = rig();
    r.autosave.changed('{"a":1}'); r.tick();
    r.replies[0]!.resolve(item('w1', 1)); await settle();
    r.autosave.changed('{"a":2}');
    r.autosave.dispose(); // before the pause
    expect(r.calls.at(-1)).toBe('update w1@1 {"a":2}');
    r.autosave.changed('{"a":3}'); r.tick();
    expect(r.calls).toHaveLength(2);
  });
});
