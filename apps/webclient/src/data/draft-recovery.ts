import type { DraftOrigin } from './draft-origin.js';

export interface DraftRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface DraftRecoveryEntry<Values = unknown, Original = unknown> {
  id: string; revision: number; updatedAt: number; sourceId: string; values: Values;
  original: Original | null;
  status: 'editing' | 'pending' | 'unknown';
  attempt?: string;
  savedId?: string;
  origin?: DraftOrigin;
}
export interface DraftRecoveryTicket { id: string; attempt: string; revision: number; blocked?: boolean }
export interface DraftRecoveryLimits { entries: number; entryBytes: number; bytes: number; age: number }
export interface DraftRecoveryStore<Values, Original> {
  list(): DraftRecoveryEntry<Values, Original>[];
  get(id: string): DraftRecoveryEntry<Values, Original> | null;
  save(input: DraftRecoveryEntry<Values, Original>): boolean;
  remove(id: string): boolean;
  settle(ticket: DraftRecoveryTicket, confirmed: boolean, savedId?: string): boolean;
  /** Older/custom stores may omit inspection. A failed storage read must stay
   * distinct from a successfully read, empty recovery collection. */
  inspect?(): { entries: DraftRecoveryEntry<Values, Original>[]; unavailable: boolean };
}
const bytes = (value: string): number => new TextEncoder().encode(value).length;

/** Recovery is local draft data, never authority to write to a source. Each
 * editor supplies a strict codec and its own pairing-scoped storage key. */
export const createDraftRecoveryStore = <Values, Original>(opts: {
  key: string; storage?: DraftRecoveryStorage | null; now?: () => number; limits: DraftRecoveryLimits;
  parse: (input: unknown, now: number) => DraftRecoveryEntry<Values, Original> | null;
}): DraftRecoveryStore<Values, Original> => {
  const now = opts.now ?? Date.now;
  let storage = opts.storage;
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch { storage = null; } }
  const read = (): DraftRecoveryEntry<Values, Original>[] | null => {
    try {
      const raw = storage?.getItem(opts.key); if (!raw) return [];
      if (bytes(raw) > opts.limits.bytes) return null;
      const rows: unknown = JSON.parse(raw); if (!Array.isArray(rows) || rows.length > opts.limits.entries) return null;
      return rows.map(row => bytes(JSON.stringify(row)) <= opts.limits.entryBytes ? opts.parse(row, now()) : null)
        .filter((row): row is DraftRecoveryEntry<Values, Original> => row !== null).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch { return null; }
  };
  const list = () => read() ?? [];
  const write = (rows: DraftRecoveryEntry<Values, Original>[]): boolean => {
    if (!storage) return false;
    try {
      const raw = JSON.stringify(rows);
      if (rows.length > opts.limits.entries || bytes(raw) > opts.limits.bytes) return false;
      if (rows.length) storage.setItem(opts.key, raw); else storage.removeItem(opts.key);
      return true;
    } catch { return false; }
  };
  const save = (input: DraftRecoveryEntry<Values, Original>): boolean => {
    const row = opts.parse(input, now()), existing = read();
    return Boolean(row && existing && bytes(JSON.stringify(row)) <= opts.limits.entryBytes && write([row, ...existing.filter(old => old.id !== row.id)]));
  };
  const remove = (id: string) => { const existing = read(); return existing !== null && write(existing.filter(row => row.id !== id)); };
  return { list, get: (id: string) => list().find(row => row.id === id) ?? null, save, remove,
    inspect: () => { const entries = read(); return { entries: entries ?? [], unavailable: !storage || entries === null }; },
    settle(ticket: DraftRecoveryTicket, confirmed: boolean, savedId?: string): boolean {
      const current = list().find(row => row.id === ticket.id);
      if (!current || current.attempt !== ticket.attempt) return false;
      return confirmed && current.revision === ticket.revision ? remove(current.id)
        : save({ ...current, revision: current.revision + 1, updatedAt: now(), status: 'unknown', ...(savedId ? { savedId } : {}) });
    },
  };
};

/** Typing is debounced; pagehide/dispose flush synchronously. The attempt and
 * revision fence prevents a late reply from deleting a newer draft. */
export const createDraftCheckpoint = <Values extends Record<string, unknown>, Original>(opts: {
  store?: DraftRecoveryStore<Values, Original>; now?: () => number; changed?: () => void;
  values: (input: Readonly<Record<string, unknown>>) => Values; same: (a: Values, b: Values) => boolean;
  idPrefix: string; label: string; initialMessage: string;
}) => {
  const now = opts.now ?? Date.now;
  let entry: DraftRecoveryEntry<Values, Original> | null = null, baseline: Values | null = null;
  let dirty = false, needsWrite = false, persisted = false, failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => opts.changed?.();
  const flush = (): boolean => {
    clearTimeout(timer); timer = undefined;
    if (!entry || !needsWrite) return true;
    entry = { ...entry, revision: entry.revision + 1, updatedAt: now() };
    failed = !opts.store?.save(entry); persisted ||= !failed; needsWrite = failed; notify(); return !failed;
  };
  const suspend = () => { flush(); entry = null; baseline = null; dirty = needsWrite = persisted = failed = false; };
  return {
    flush, suspend,
    begin(sourceId: string, values: Record<string, unknown>, original: Original | null, restored?: DraftRecoveryEntry<Values, Original>) {
      suspend();
      if (!opts.store) return;
      baseline = opts.values(values);
      entry = restored ? { ...restored, values: opts.values(restored.values) }
        : { id: `${opts.idPrefix}${crypto.randomUUID()}`, revision: 1, updatedAt: now(), sourceId, values: baseline, original, status: 'editing' };
      persisted = Boolean(restored); dirty = Boolean(restored); notify();
    },
    capture(sourceId: string, values: Record<string, unknown>) {
      if (!entry || !baseline) return;
      const next = opts.values(values);
      if (!dirty && opts.same(baseline, next) && sourceId === entry.sourceId) return;
      if (opts.same(entry.values, next) && sourceId === entry.sourceId) return;
      entry = { ...entry, values: next, sourceId }; dirty = needsWrite = true;
      clearTimeout(timer); timer = setTimeout(flush, 300);
    },
    setOrigin(origin: DraftOrigin | undefined) {
      if (!entry || entry.original !== null || JSON.stringify(entry.origin) === JSON.stringify(origin)) return;
      const { origin: _oldOrigin, ...rest } = entry;
      entry = { ...rest, ...(origin ? { origin } : {}) }; dirty = needsWrite = true;
    },
    id: () => entry?.id,
    status: () => entry?.status,
    message: () => !opts.store ? '' : failed ? `Latest edits could not be kept in this tab. Keep this ${opts.label} open or copy its text before leaving.`
      : entry?.status !== undefined && entry.status !== 'editing' ? 'Save not confirmed. A recovery copy is kept in this tab.'
        : persisted ? 'Changes kept in this tab.' : opts.initialMessage,
    startAttempt(): DraftRecoveryTicket | undefined {
      if (!entry) return undefined;
      const hadRecovery = persisted;
      entry = { ...entry, status: 'pending', attempt: crypto.randomUUID() }; dirty = needsWrite = true;
      const stored = flush();
      const blocked = hadRecovery && !stored;
      // A blocked checkpoint prevented dispatch; the owner can retry once
      // storage returns without treating that attempt as an uncertain write.
      if (blocked) entry = { ...entry, status: 'editing' };
      return { id: entry.id, attempt: entry.attempt!, revision: entry.revision, blocked };
    },
    settle(ticket: DraftRecoveryTicket | undefined, confirmed: boolean, savedId?: string) {
      if (!ticket) return;
      const saved = opts.store?.settle(ticket, confirmed, savedId);
      if (entry?.id !== ticket.id || entry.attempt !== ticket.attempt) return;
      const current = opts.store?.get(ticket.id);
      if (confirmed && !current && saved) { clearTimeout(timer); entry = null; baseline = null; dirty = needsWrite = persisted = failed = false; }
      else { entry = current ?? { ...entry, status: 'unknown', ...(savedId ? { savedId } : {}) }; failed = !saved; needsWrite = !saved; }
      notify();
    },
    discard(): boolean {
      clearTimeout(timer); timer = undefined;
      if (entry && persisted && !opts.store?.remove(entry.id)) { failed = true; notify(); return false; }
      entry = null; baseline = null; dirty = needsWrite = persisted = failed = false; return true;
    },
  };
};
