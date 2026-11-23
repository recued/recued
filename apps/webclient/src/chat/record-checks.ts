import type { PreparedRecordLink } from '../data/record-link-insert.js';

export interface RecordCheckOwner { key: string; scope: object }
export type RecordCheckState = 'checking' | 'ready' | 'missing' | 'error';
export interface RecordCheckRow { key: string; record: PreparedRecordLink; state?: RecordCheckState }
export interface RecordCheckOutcome { current: boolean; owner: RecordCheckOwner | null; issues: RecordCheckRow[] }
export interface RecordCheckProgress { id: number; completed: number; total: number }
export const recordCheckKey = (record: PreparedRecordLink) =>
  JSON.stringify([record.reference.target.hash, record.reference.identity, record.shortcut ?? null]);
const sameOwner = (a: RecordCheckOwner | null, b: RecordCheckOwner | null) => a?.key === b?.key && a?.scope === b?.scope;

/** Read-only checks belong to a selected lifetime and draft activation. Keeping
 * results never changes the selection or authorizes a later Send. */
export const createRecordChecks = (deps: {
  owner: () => RecordCheckOwner | null; records: () => readonly PreparedRecordLink[];
  verify: (record: PreparedRecordLink) => Promise<boolean>; blocked: () => boolean; changed: () => void;
}) => {
  type Results = Map<string, RecordCheckState>;
  interface Run { id: number; owner: RecordCheckOwner; keys: Set<string>; completed: Set<string> }
  interface Request { owner: RecordCheckOwner; key: string; results: Results; previous?: RecordCheckState; promise: Promise<boolean>; settle: (current: boolean) => void; run: Run }
  const drafts = new WeakMap<object, Results>(), requests = new Map<string, Request>();
  let activation: RecordCheckOwner | null = null, disposed = false, run: Run | null = null, sequence = 0;
  const retire = (request: Request) => {
    if (requests.get(request.key) !== request) return;
    requests.delete(request.key);
    if (run === request.run) { run.keys.delete(request.key); run.completed.delete(request.key); if (!requests.size) run = null; }
    if (request.previous) request.results.set(request.key, request.previous);
    else request.results.delete(request.key);
    request.settle(false);
  };
  const cancel = () => { run = null; for (const request of requests.values()) retire(request); activation = null; };
  const context = () => {
    const owner = disposed ? null : deps.owner();
    if (!sameOwner(owner, activation)) { cancel(); activation = owner; }
    if (!owner) return null;
    let results = drafts.get(owner.scope); if (!results) { results = new Map(); drafts.set(owner.scope, results); }
    const records = deps.records(), keys = new Set(records.map(recordCheckKey));
    for (const key of results.keys()) if (!keys.has(key)) {
      const request = requests.get(key); if (request) retire(request);
      run?.keys.delete(key); run?.completed.delete(key);
      results.delete(key);
    }
    return { owner, results, records };
  };
  const progress = (): RecordCheckProgress | null => {
    context(); return run && requests.size ? { id: run.id, total: run.keys.size, completed: run.completed.size } : null;
  };
  const prepareRun = (owner: RecordCheckOwner, keys: readonly string[]): Run => {
    if (!run || !requests.size || !sameOwner(run.owner, owner)) run = { id: ++sequence, owner, keys: new Set(), completed: new Set() };
    for (const key of keys) run.keys.add(key);
    return run;
  };
  const rows = (): RecordCheckRow[] => {
    const current = context(); return current ? current.records.map(record => {
      const key = recordCheckKey(record); return { key, record, state: current.results.get(key) };
    }) : [];
  };
  const start = (row: RecordCheckRow, owner: RecordCheckOwner): Promise<boolean> => {
    const current = context();
    if (!current || !sameOwner(current.owner, owner) || !current.records.some(record => recordCheckKey(record) === row.key)) return Promise.resolve(false);
    const existing = requests.get(row.key); if (existing) return existing.promise;
    const attempt = run && sameOwner(run.owner, owner) ? run : prepareRun(owner, [row.key]);
    attempt.keys.add(row.key); attempt.completed.delete(row.key);
    let settle!: Request['settle'];
    const promise = new Promise<boolean>(resolve => { settle = resolve; });
    const request: Request = { owner, key: row.key, results: current.results, previous: current.results.get(row.key), promise, settle, run: attempt };
    requests.set(row.key, request); current.results.set(row.key, 'checking'); deps.changed();
    void (async () => {
      // Register the complete batch before a reader can finish synchronously.
      // A cancellation before this microtask also avoids starting the read.
      await Promise.resolve(); context();
      if (disposed || requests.get(row.key) !== request || !sameOwner(activation, owner)) return;
      let state: RecordCheckState;
      try { state = await deps.verify(row.record) ? 'ready' : 'missing'; } catch { state = 'error'; }
      context();
      if (disposed || requests.get(row.key) !== request || !sameOwner(activation, owner)) return;
      requests.delete(row.key); request.results.set(row.key, state);
      if (run === attempt) { attempt.completed.add(row.key); if (!requests.size) run = null; }
      request.settle(true); deps.changed();
    })();
    return request.promise;
  };
  return {
    rows,
    progress,
    hasPending() { context(); return requests.size > 0; },
    async checkAll(records: readonly PreparedRecordLink[]): Promise<RecordCheckOutcome> {
      const current = context(), keys = JSON.stringify(records.map(recordCheckKey));
      if (!current || keys !== JSON.stringify(current.records.map(recordCheckKey))) return { current: false, owner: null, issues: [] };
      prepareRun(current.owner, records.map(recordCheckKey));
      const completed = await Promise.all(records.map(record => start({ record, key: recordCheckKey(record) }, current.owner)));
      const latest = context();
      if (!latest || !sameOwner(latest.owner, current.owner) || completed.some(value => !value)
        || keys !== JSON.stringify(latest.records.map(recordCheckKey))) return { current: false, owner: current.owner, issues: [] };
      return { current: true, owner: current.owner, issues: rows().filter(row => row.state === 'error' || row.state === 'missing') };
    },
    async recheck(key: string): Promise<boolean> {
      const current = context(), row = rows().find(row => row.key === key);
      return current && row && !deps.blocked() ? start(row, current.owner) : false;
    },
    cancel,
    cancelPending(id: number): boolean {
      const current = progress(); if (!current || current.id !== id) return false;
      cancel(); if (!disposed) deps.changed(); return true;
    },
    dispose() { cancel(); disposed = true; },
  };
};
