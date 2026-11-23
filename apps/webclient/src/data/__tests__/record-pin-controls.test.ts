import { expect, it, vi } from 'vitest';
import { createRecordPinControls } from '../record-pin-controls.js';
import { createPinnedRecords, pinnedRecordIdentity } from '../pinned-records.js';
import type { RecentWorkRecord } from '../recent-work-records.js';

const record: RecentWorkRecord = { kind: 'task', id: 'one', title: 'Saved task', source_id: 'recued.task', source_record_id: null, source_label: 'Recued', created_at: 1 };
const setup = () => {
  let scope: string | null = 'search:one', blocked = false;
  const pins = createPinnedRecords({ scope: 'pair', storage: null }), changed = vi.fn();
  const controls = createRecordPinControls({ pins, scope: () => scope, blocked: () => blocked, changed });
  const host = { insertAdjacentHTML: vi.fn(), classList: { contains: () => false } } as unknown as HTMLElement;
  const read = vi.fn(async (): Promise<RecentWorkRecord> => record), key = JSON.stringify(['task', 'one']);
  const mount = () => { controls.begin(); controls.mount(host, { ...record, read }, 'data-action'); };
  mount(); return { controls, pins, read, changed, key, mount, host, scope: (value: string | null) => { scope = value; }, block: (value: boolean) => { blocked = value; } };
};

it('pins only a confirmed reference and unpins locally without reading or mutating the canonical record', async () => {
  const f = setup(); await f.controls.toggle(f.key); expect(f.pins.has('task', 'one')).toBe(true); expect(f.read).toHaveBeenCalledOnce();
  f.mount(); await f.controls.toggle(f.key); expect(f.pins.list()).toEqual([]); expect(f.read).toHaveBeenCalledOnce();
});

it('does not let a duplicate or late read pin a record after a query, reader, pairing or disposal changes', async () => {
  for (const steering of ['query', 'reader', 'pairing', 'dispose'] as const) {
    const f = setup(); let resolve!: (record: RecentWorkRecord) => void;
    f.read.mockReturnValue(new Promise(done => { resolve = done; })); const pending = f.controls.toggle(f.key);
    await f.controls.toggle(f.key); expect(f.read).toHaveBeenCalledOnce();
    if (steering === 'dispose') f.controls.reset(); else f.scope(steering === 'pairing' ? null : steering);
    resolve(record); await pending; expect(f.pins.list()).toEqual([]);
  }
});

it('rejects unknown controls, mismatched identities and failed reads, and rechecks mutation ownership after a read', async () => {
  const f = setup(); await f.controls.toggle('forged'); expect(f.read).not.toHaveBeenCalled();
  f.block(true); await f.controls.toggle(f.key); expect(f.read).not.toHaveBeenCalled(); f.block(false);
  f.read.mockResolvedValueOnce({ ...record, id: 'wrong' }); await f.controls.toggle(f.key); expect(f.pins.list()).toEqual([]);
  f.read.mockRejectedValueOnce(Error('Read interrupted')); await f.controls.toggle(f.key); expect(f.pins.list()).toEqual([]);
  let resolve!: (record: RecentWorkRecord) => void; f.read.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const pending = f.controls.toggle(f.key); f.block(true); resolve(record); await pending; expect(f.pins.list()).toEqual([]);
  f.block(false); await f.controls.toggle(f.key); expect(f.pins.has('task', 'one')).toBe(true);
});

it('lets an explicitly reviewed replacement replace an old shortcut instead of treating a reused id as already pinned', async () => {
  const f = setup(); f.pins.pin(record);
  const replacement = { ...record, created_at: 2, title: 'Reviewed replacement' };
  f.controls.begin(); const read = vi.fn(async () => replacement);
  f.controls.mount(f.host, { ...replacement, identity: pinnedRecordIdentity(replacement), read }, 'data-action');
  await f.controls.toggle(f.key); expect(read).toHaveBeenCalledOnce(); expect(f.pins.list()).toEqual([replacement]);
});
