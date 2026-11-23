import { describe, expect, it } from 'vitest';
import { BLOCKED_SITES_KEY } from '../permissions/site-grants.js';
import { KEEP_SIGNED_IN_KEY, runKeepSignedInTick, type KeepSignedInDeps } from '../keep-signed-in.js';
import { SITE_LIST_EDIT_MESSAGE_TYPE } from '../site-list-mutations.js';
import { flush, gate, siteWorker } from './site-list-fixture.js';

const sites = ['a.example.com', 'b.example.com', 'c.example.com'];
const entry = (site: string) => ({ site, every_minutes: 10, mode: 'session' as const });
const names = (raw: unknown) => (raw as Array<string | { site: string }>).map(value => typeof value === 'string' ? value : value.site);
const seeded = () => siteWorker({ [BLOCKED_SITES_KEY]: sites, [KEEP_SIGNED_IN_KEY]: sites.map(entry) });

describe('site list mutations through the worker', () => {
  const cases = (['blocked', 'keep'] as const).flatMap(list => (['add', 'remove'] as const).map(op => ({ list, op })));
  it.each(cases)('preserves both $list $op edits from independent panels', async ({ list, op }) => {
    const worker = seeded(), a = worker.panel(), b = worker.panel();
    const began = gate(), release = gate();
    const key = list === 'blocked' ? BLOCKED_SITES_KEY : KEEP_SIGNED_IN_KEY;
    let mutationReads = 0;
    worker.hooks.read = async keys => {
      if (keys.length === 1 && keys[0] === key && ++mutationReads === 1) { began.release(); await release.promise; }
    };
    const targets = op === 'add' ? ['d.example.com', 'e.example.com'] : sites.slice(0, 2);
    const change = (panel: typeof a, site: string) => list === 'blocked'
      ? op === 'add' ? panel.controls.onAddBlocked(site) : panel.controls.onRemoveBlocked(site)
      : op === 'add' ? panel.controls.onAddKeep(entry(site)) : panel.controls.onRemoveKeep(site);
    const first = change(a, targets[0]!);
    await began.promise;
    const second = change(b, targets[1]!);
    try {
      await flush();
      expect(mutationReads).toBe(1);
      expect(worker.writes).toHaveLength(0);
    } finally { release.release(); await Promise.all([first, second]); }
    expect(names(worker.saved[key])).toEqual(op === 'add' ? [...sites, ...targets] : [sites[2]]);
    expect(worker.writes).toHaveLength(2);
  });

  it.each(['blocked', 'keep'] as const)('Undo restores only its %s entry and preserves other panels edits', async list => {
    const worker = seeded(), a = worker.panel(), b = worker.panel();
    const key = list === 'blocked' ? BLOCKED_SITES_KEY : KEEP_SIGNED_IN_KEY;
    if (list === 'blocked') await a.controls.onRemoveBlocked(sites[0]!);
    else await a.controls.onRemoveKeep(sites[0]!);
    const edits = list === 'blocked'
      ? [b.controls.onAddBlocked('d.example.com'), b.controls.onRemoveBlocked(sites[1]!), a.controls.onUndoRemoveBlocked()]
      : [b.controls.onAddKeep(entry('d.example.com')), b.controls.onRemoveKeep(sites[1]!), a.controls.onUndoRemoveKeep()];
    await Promise.all(edits);
    expect(names(worker.saved[key])).toEqual([sites[0], sites[2], 'd.example.com']);
    expect(list === 'blocked' ? a.last().removed : a.last().keep_removed).toBeUndefined();
  });

  it('a failed read does not erase settings or block the next panels edit', async () => {
    const worker = seeded(), a = worker.panel(), b = worker.panel();
    let failed = false;
    worker.hooks.read = async keys => {
      if (!failed && keys.length === 1 && keys[0] === BLOCKED_SITES_KEY) { failed = true; throw new Error('read unavailable'); }
    };
    await Promise.all([a.controls.onAddBlocked('d.example.com'), b.controls.onAddBlocked('e.example.com')]);
    expect(worker.saved[BLOCKED_SITES_KEY]).toEqual([...sites, 'e.example.com']);
    expect(worker.writes).toHaveLength(1);
    expect(a.last().message).toMatch(/could not read/i);
    expect(b.last().message).toBe('');
  });

  it.each(['blocked', 'keep'] as const)('a queued Undo keeps its selected %s entry when a pending removal offers another', async list => {
    const worker = seeded(), panel = worker.panel();
    const key = list === 'blocked' ? BLOCKED_SITES_KEY : KEEP_SIGNED_IN_KEY;
    if (list === 'blocked') await panel.controls.onRemoveBlocked(sites[0]!);
    else await panel.controls.onRemoveKeep(sites[0]!);
    const began = gate(), release = gate();
    let held = false;
    worker.hooks.write = async items => {
      if (!held && key in items) { held = true; began.release(); await release.promise; }
    };
    const removal = list === 'blocked' ? panel.controls.onRemoveBlocked(sites[1]!) : panel.controls.onRemoveKeep(sites[1]!);
    await began.promise;
    const undo = list === 'blocked' ? panel.controls.onUndoRemoveBlocked() : panel.controls.onUndoRemoveKeep();
    release.release();
    await Promise.all([removal, undo]);
    expect(names(worker.saved[key])).toEqual([sites[0], sites[2]]);
    expect(list === 'blocked' ? panel.last().removed : panel.last().keep_removed).toMatchObject({ site: sites[1] });
  });

  it('does not claim a lost acknowledgement means no change, or retry it automatically', async () => {
    const worker = seeded();
    const panel = worker.panel(async message => { await worker.send(message); throw new Error('port closed'); });
    await panel.controls.onRemoveBlocked(sites[0]!);
    expect(worker.saved[BLOCKED_SITES_KEY]).toEqual(sites.slice(1));
    expect(worker.writes).toHaveLength(1);
    expect(panel.last().message).toMatch(/could not confirm/i);
    expect(panel.last().removed).toBeUndefined();
  });

  it.each([
    { list: 'other-key', op: 'remove', site: 'a.example.com' },
    { list: 'blocked', op: 'set', site: 'a.example.com' },
    { list: 'blocked', op: 'restore', site: 'a.example.com', index: -1 },
    { list: 'keep', op: 'add', entry: { site: 'a.example.com', every_minutes: 0, mode: 'session' } },
  ])('rejects invalid edits before reading or writing storage: %j', async edit => {
    const worker = seeded();
    await expect(worker.send({ type: SITE_LIST_EDIT_MESSAGE_TYPE, edit })).resolves.toEqual({ ok: false, error: 'invalid' });
    expect(worker.reads).toHaveLength(0);
    expect(worker.writes).toHaveLength(0);
  });

  it('local settings work before server boot and after its failure, while server messages retain their failure', async () => {
    const worker = seeded(), panel = worker.panel();
    await panel.controls.onAddBlocked('before.example.com');
    worker.messages.failQueuedAfterBootRejection(new Error('server boot failed'));
    await panel.controls.onAddBlocked('after.example.com');
    expect(worker.saved[BLOCKED_SITES_KEY]).toEqual([...sites, 'before.example.com', 'after.example.com']);
    await expect(worker.send({ type: 'recued.bridge.inspect' })).resolves.toMatchObject({ ok: false, error: 'bridge_boot_failed' });
  });
});

const tickDeps = (worker: ReturnType<typeof siteWorker>): KeepSignedInDeps => ({
  // A separate adapter still shares the worker queue; ownership is not keyed to object identity.
  storage: { get: keys => worker.storage.get(keys), set: items => worker.storage.set(items) },
  memory: { get: async () => ({}), set: async () => {} },
  tabs: { query: async () => [], reload: async () => {}, get: async () => { throw new Error('no tab'); }, update: async () => {} },
  focusedWindow: async () => null, runInTab: async () => null,
  activity: () => ({ running: 0, last_ended_at: 0 }), now: () => 2_000,
});

describe('Keep signed in expiry shares site list ownership', () => {
  it('cannot restore an entry removed while its final storage work is pending', async () => {
    const expired = { ...entry(sites[0]!), window: { until: 1_000 } };
    const worker = siteWorker({ [KEEP_SIGNED_IN_KEY]: [expired] }), panel = worker.panel();
    const began = gate(), release = gate();
    let held = false;
    worker.hooks.read = async keys => {
      if (!held && keys.length === 1 && keys[0] === KEEP_SIGNED_IN_KEY) { held = true; began.release(); await release.promise; }
    };
    const tick = runKeepSignedInTick(tickDeps(worker));
    await began.promise;
    const removal = panel.controls.onRemoveKeep(expired.site);
    try { await flush(); expect(worker.writes).toHaveLength(0); }
    finally { release.release(); await Promise.all([tick, removal]); }
    expect(worker.saved[KEEP_SIGNED_IN_KEY]).toEqual([]);
    await panel.controls.onUndoRemoveKeep();
    expect(worker.saved[KEEP_SIGNED_IN_KEY]).toEqual([{ ...expired, off: true }]);
  });

  it('keeps a replacement window the owner saves before expiry commits', async () => {
    const expired = { ...entry(sites[0]!), window: { until: 1_000 } };
    const replacement = { ...expired, every_minutes: 15, window: { until: 10_000 } };
    const other = entry(sites[1]!);
    const worker = siteWorker({ [KEEP_SIGNED_IN_KEY]: [expired, other] }), panel = worker.panel();
    const began = gate(), release = gate(), deps = tickDeps(worker);
    deps.tabs.query = async () => { began.release(); await release.promise; return []; };
    const tick = runKeepSignedInTick(deps);
    try {
      await began.promise;
      await panel.controls.onAddKeep(replacement);
    } finally { release.release(); await tick; }
    expect(worker.saved[KEEP_SIGNED_IN_KEY]).toEqual([other, replacement]);
  });
});
