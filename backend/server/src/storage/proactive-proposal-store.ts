import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { PROACTIVE_PROPOSAL_KINDS, type ProactiveProposal, type ProactiveProposalInput, type ProactiveSuppression, type SituationRef } from '@recued/contracts';
import { createSettingsBatch } from './settings-batch.js';

const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validRef = (ref: SituationRef) => ref && boundedText(ref.collection, 200) && boundedText(ref.id, 2000);
type ProposalKeyReader = (key: string) => ProactiveProposal | null | undefined;
interface PrefetchedProposalKey { value: string | null; tombstoned?: boolean }
const nativeEventReaders = new WeakMap<object, unknown>();
export const hasNativeProposalEvents = (store: object): boolean => {
  const reader = nativeEventReaders.get(store);
  return reader !== undefined && Object.getOwnPropertyDescriptor(store, 'pendingEvents')?.value === reader;
};
export const validateProposal = (input: ProactiveProposalInput): void => {
  if (!input || !PROACTIVE_PROPOSAL_KINDS.includes(input.kind) || !boundedText(input.key, 2000)
    || !boundedText(input.title, 1000) || typeof input.explanation !== 'string' || input.explanation.length > 4000
    || !['high', 'medium', 'low'].includes(input.confidence) || !['intake', 'owner', 'learner', 'pack'].includes(input.origin)
    || !input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)
    || !Array.isArray(input.sources) || input.sources.length > 100 || input.sources.some(ref => !validRef(ref))
    || (input.subject && !validRef(input.subject)) || JSON.stringify(input).length > 65536) throw new Error('Invalid or oversized proposal');
  if (input.lane && !['likely_asset', 'gift', 'return', 'pickup', 'bundle'].includes(input.lane)) throw new Error('Unknown intake lane');
};
export const createProactiveProposalStore = (db: Database.Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS proactive_proposals (
    id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, kind TEXT NOT NULL,
    origin TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS proactive_proposal_list ON proactive_proposals(state,created_at DESC,id);
  CREATE TABLE IF NOT EXISTS proactive_proposal_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id TEXT NOT NULL, at INTEGER NOT NULL,
    outcome TEXT NOT NULL, actor TEXT NOT NULL, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS proactive_suppressions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS proactive_source_controls (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS proactive_intake_receipts (source_key TEXT PRIMARY KEY, source_id TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS proactive_intake_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS proactive_proposal_events (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,value TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS proactive_proposal_tombstones (dedupe_key TEXT PRIMARY KEY,at INTEGER NOT NULL)');
  const read = (id: string): ProactiveProposal | null => {
    const row = db.prepare('SELECT value FROM proactive_proposals WHERE id=?').get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  };
  const byKey = (key: string): ProactiveProposal | null => {
    const row = db.prepare('SELECT value FROM proactive_proposals WHERE dedupe_key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  };
  // Native ensure generated a new ID. A strict insert avoids a previous-row
  // read and rejects collisions without replacing an earlier proposal.
  const insert = (proposal: ProactiveProposal): ProactiveProposal => {
    validateProposal(proposal);
    return db.transaction(() => {
      const value = JSON.stringify(proposal);
      db.prepare(`INSERT INTO proactive_proposals(id,dedupe_key,state,kind,origin,created_at,updated_at,value) VALUES(?,?,?,?,?,?,?,?)`)
        .run(proposal.id, proposal.key, proposal.state, proposal.kind, proposal.origin, proposal.created_at, proposal.updated_at, value);
      db.prepare('INSERT INTO proactive_proposal_events(at,value) VALUES(?,?)').run(proposal.updated_at, value);
      return proposal;
    })();
  };
  const save = (proposal: ProactiveProposal): ProactiveProposal => {
    validateProposal(proposal);
    const previous = read(proposal.id);
    const semantic = (value: ProactiveProposal) => JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => !['shown_at', 'edited_at', 'updated_at'].includes(key))));
    return db.transaction(() => {
      db.prepare(`INSERT INTO proactive_proposals(id,dedupe_key,state,kind,origin,created_at,updated_at,value) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,value=excluded.value`)
      .run(proposal.id, proposal.key, proposal.state, proposal.kind, proposal.origin, proposal.created_at, proposal.updated_at, JSON.stringify(proposal));
      if (!previous || semantic(previous) !== semantic(proposal)) db.prepare('INSERT INTO proactive_proposal_events(at,value) VALUES(?,?)').run(proposal.updated_at, JSON.stringify(proposal));
      return proposal;
    })();
  };
  const list = (input: { state?: ProactiveProposal['state']; kind?: ProactiveProposal['kind']; offset?: number; limit?: number; subject?: SituationRef } = {}): ProactiveProposal[] => {
    const where: string[] = []; const values: Array<string | number> = [];
    for (const [column, value] of [['state', input.state], ['kind', input.kind]] as const) if (value) { where.push(`${column}=?`); values.push(value); }
    if (input.subject) { where.push("json_extract(value,'$.subject.collection')=? AND json_extract(value,'$.subject.id')=?"); values.push(input.subject.collection, input.subject.id); }
    const limit = Math.max(1, Math.min(10000, input.limit ?? 100)); const offset = Math.max(0, input.offset ?? 0);
    return (db.prepare(`SELECT value FROM proactive_proposals${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as { value: string }[]).map(row => JSON.parse(row.value));
  };
  const suppressions = (): ProactiveSuppression[] => (db.prepare('SELECT value FROM proactive_suppressions ORDER BY id').all() as { value: string }[]).map(row => JSON.parse(row.value));
  const setting = <T>(key: string, fallback: T): T => {
    const row = db.prepare('SELECT value FROM proactive_intake_settings WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : fallback;
  };
  const settings = createSettingsBatch('setting', setting, keys =>
    db.prepare(`SELECT key,value FROM proactive_intake_settings WHERE key IN (${keys.map(() => '?').join(',')})`)
      .all(...keys) as { key: string; value: string }[]);
  const keyBatches = new WeakMap<ProposalKeyReader, Map<string, PrefetchedProposalKey>>();
  const ensure = (input: ProactiveProposalInput, at: number, prefetched?: ProposalKeyReader): ProactiveProposal => {
    validateProposal(input);
    // Only this store's unconsumed native entry can supply tombstone metadata.
    const entry = prefetched && keyBatches.get(prefetched)?.get(input.key);
    const cached = prefetched?.(input.key); const old = cached === undefined ? byKey(input.key) : cached;
    if (!old && (entry?.tombstoned ?? !!db.prepare('SELECT 1 FROM proactive_proposal_tombstones WHERE dedupe_key=?').get(input.key))) return {
      ...structuredClone(input), id: `deleted-proposal-${createHash('sha256').update(input.key).digest('hex')}`, state: 'dismissed', dismissal: 'not_this_one', created_at: at, updated_at: at,
    };
    // Owner edits and answers survive rescans. A changed extraction is offered
    // afresh only if its producer gives it a new evidence/version key.
    return old ?? insert({ ...structuredClone(input), id: `proposal-${randomUUID()}`, state: 'proposed', created_at: at, updated_at: at });
  };
  /** For one synchronous batch with no intervening edits to other keys. Decode
   * only when ensure reaches a key, after validation, to retain error order.
   * Each key and its tombstone state are consumed once; repeated, unrequested
   * and custom readers retain point checks. Existing rows need no tombstone
   * query. Customized ensure retains its path. */
  function prefetchKeys(this: { ensure: typeof ensure }, keys: readonly string[]): ProposalKeyReader | undefined {
    if (this?.ensure !== ensure) return undefined;
    const unique = [...new Set(keys)]; const values = new Map<string, PrefetchedProposalKey>(unique.map(key => [key, { value: null }]));
    for (let offset = 0; offset < unique.length; offset += 200) {
      const page = unique.slice(offset, offset + 200);
      const rows = db.prepare(`SELECT dedupe_key,value FROM proactive_proposals WHERE dedupe_key IN (${page.map(() => '?').join(',')})`).all(...page) as { dedupe_key: string; value: string }[];
      for (const row of rows) values.set(row.dedupe_key, { value: row.value });
    }
    const missing = unique.filter(key => values.get(key)?.value === null);
    try {
      const states = new Map<string, boolean>();
      for (let offset = 0; offset < missing.length; offset += 200) {
        const page = missing.slice(offset, offset + 200);
        const rows = db.prepare(`WITH proposal_tombstone_requested(dedupe_key) AS (VALUES ${page.map(() => '(?)').join(',')})
          SELECT requested.dedupe_key,EXISTS(SELECT 1 FROM proactive_proposal_tombstones tombstone
            WHERE tombstone.dedupe_key=requested.dedupe_key) AS tombstoned FROM proposal_tombstone_requested requested`)
          .all(...page) as Array<{ dedupe_key: string; tombstoned: number }>;
        for (const row of rows) if (row.tombstoned === 0 || row.tombstoned === 1) states.set(row.dedupe_key, row.tombstoned === 1);
      }
      for (const key of missing) { const state = states.get(key); if (state !== undefined) values.get(key)!.tombstoned = state; }
    } catch { /* Keep the proposal prefetch; ensure retains ordered, current tombstone checks. */ }
    const lookup: ProposalKeyReader = key => {
      const entry = values.get(key); values.delete(key);
      return entry === undefined ? undefined : entry.value === null ? null : JSON.parse(entry.value);
    };
    keyBatches.set(lookup, values); return lookup;
  }
  const pendingEvents = (limit = 100): Array<{ revision: number; at: number; proposal: ProactiveProposal }> =>
    (db.prepare('SELECT revision,at,value FROM proactive_proposal_events WHERE delivered=0 ORDER BY revision LIMIT ?').all(Math.max(1, Math.min(1000, limit))) as { revision: number; at: number; value: string }[])
      .map(({ value, ...row }) => ({ ...row, proposal: JSON.parse(value) }));
  const store = {
    read, byKey, list, save, setting, settings, suppressions, ensure, prefetchKeys, pendingEvents,
    acknowledgeEvent(revision: number, wrote?: (rows: number, connection: Database.Database) => void): void {
      const result = db.prepare('UPDATE proactive_proposal_events SET delivered=1 WHERE revision=?').run(revision); wrote?.(result.changes, db);
    },
    /** Supply a suppression snapshot only within a synchronous refresh. Other callers read current rows. */
    allows(input: Pick<ProactiveProposalInput, 'kind' | 'payload'>, currentSuppressions?: readonly ProactiveSuppression[]): boolean {
      const scope = String(input.payload.proposal_class ?? input.kind);
      return !(currentSuppressions ?? suppressions()).some(row => row.kind === 'proposal_kind' && (row.value === scope || row.value === input.kind));
    },
    /** A key offered once is not offered again: `ensure` returns the earlier proposal
     * or its tombstone. Only an offer its source withdrew is forgotten (`prune`). */
    offered: (key: string): boolean => !!byKey(key) || !!db.prepare('SELECT 1 FROM proactive_proposal_tombstones WHERE dedupe_key=?').get(key),
    /** Retention: a delivered outbox entry is already its situation revision. An
     * outcome older than `before` goes unless opt-in measures have yet to count it:
     * past their cursor and dated after they were turned on. An offer its source
     * withdrew before `before` goes too: nobody answered it, so its source may make
     * it again. An answered offer stays. */
    prune(input: { before: number; uncounted?: { after: number; since: number } }): { events: number; outcomes: number; retracted: number } {
      if (!Number.isSafeInteger(input.before)) throw new Error('Invalid proposal retention');
      return db.transaction(() => ({
        events: db.prepare('DELETE FROM proactive_proposal_events WHERE delivered=1').run().changes,
        outcomes: (input.uncounted
          ? db.prepare('DELETE FROM proactive_proposal_outcomes WHERE at<? AND (id<=? OR at<?)').run(input.before, input.uncounted.after, input.uncounted.since)
          : db.prepare('DELETE FROM proactive_proposal_outcomes WHERE at<?').run(input.before)).changes,
        retracted: db.prepare("DELETE FROM proactive_proposals WHERE state='retracted' AND updated_at<?").run(input.before).changes,
      }))();
    },
    /** Retention: a tombstone goes once nothing can make its offer again. */
    pruneTombstones(gone: (key: string) => boolean): number {
      const keys = (db.prepare('SELECT dedupe_key FROM proactive_proposal_tombstones').all() as { dedupe_key: string }[]).map(row => row.dedupe_key).filter(gone);
      const drop = db.prepare('DELETE FROM proactive_proposal_tombstones WHERE dedupe_key=?');
      return db.transaction(() => keys.reduce((count, key) => count + drop.run(key).changes, 0))();
    },
    /** Retention: an intake receipt goes once the fact it records, as read, is gone. */
    pruneReceipts(current: (key: string) => boolean): number {
      const keys = (db.prepare('SELECT source_key FROM proactive_intake_receipts').all() as { source_key: string }[]).map(row => row.source_key).filter(key => !current(key));
      const drop = db.prepare('DELETE FROM proactive_intake_receipts WHERE source_key=?');
      return db.transaction(() => keys.reduce((count, key) => count + drop.run(key).changes, 0))();
    },
    count: (kind?: ProactiveProposal['kind']): number => (db.prepare(`SELECT count(*) AS n FROM proactive_proposals WHERE state='proposed'${kind ? ' AND kind=?' : ''}`).get(...(kind ? [kind] : [])) as { n: number }).n,
    edit(id: string, patch: { title?: string; payload?: Record<string, unknown> }, at: number): ProactiveProposal {
      const old = read(id); if (old?.state !== 'proposed') throw new Error('This proposal is no longer waiting');
      return save({ ...old, ...patch, edited_at: at, updated_at: at });
    },
    outcome(id: string, outcome: 'accepted' | 'retracted' | NonNullable<ProactiveProposal['dismissal']>, at: number, result?: SituationRef): ProactiveProposal {
      const old = read(id); if (!old) throw new Error('Proposal not found');
      if (old.state !== 'proposed') return old;
      const state = outcome === 'accepted' ? 'accepted' : outcome === 'retracted' ? 'retracted' : 'dismissed';
      return db.transaction(() => {
        const next = save({ ...old, state, updated_at: at, ...(result ? { result } : {}),
          ...(state === 'dismissed' ? { dismissal: outcome as ProactiveProposal['dismissal'] } : {}) });
        db.prepare('INSERT INTO proactive_proposal_outcomes(proposal_id,at,outcome,actor,value) VALUES(?,?,?,?,?)')
          .run(id, at, outcome, outcome === 'retracted' ? 'source' : 'owner', JSON.stringify({ kind: old.kind, origin: old.origin, subject: old.subject, result }));
        return next;
      })();
    },
    delete(id: string): void {
      const old = read(id); if (!old) return;
      db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO proactive_proposal_tombstones(dedupe_key,at) VALUES(?,?)').run(old.key, old.updated_at);
        db.prepare('INSERT INTO proactive_proposal_events(at,value) VALUES(?,?)').run(old.updated_at, JSON.stringify({ ...old, state: 'retracted' }));
        db.prepare('DELETE FROM proactive_proposals WHERE id=?').run(id);
      })();
    },
    /** §4.9 — forgetting leaves only a content-free retraction: subscribers learn the
     * offer is withdrawn, while its text and payload leave the outbox with the row.
     * The tombstone keeps a dismissed offer from being made again. */
    forget(id: string, at: number): boolean {
      const old = read(id); if (!old) return false;
      const bare = (state: ProactiveProposal['state']): string => JSON.stringify({ id: old.id, key: old.key, kind: old.kind, origin: old.origin,
        state, title: 'Forgotten', explanation: '', confidence: old.confidence, sources: [], payload: {}, created_at: old.created_at, updated_at: at });
      db.transaction(() => {
        for (const row of db.prepare("SELECT revision,value FROM proactive_proposal_events WHERE json_extract(value,'$.id')=?").all(id) as { revision: number; value: string }[]) {
          db.prepare('UPDATE proactive_proposal_events SET value=? WHERE revision=?').run(bare((JSON.parse(row.value) as ProactiveProposal).state), row.revision);
        }
        db.prepare('INSERT OR IGNORE INTO proactive_proposal_tombstones(dedupe_key,at) VALUES(?,?)').run(old.key, at);
        db.prepare('INSERT INTO proactive_proposal_events(at,value) VALUES(?,?)').run(at, bare('retracted'));
        db.prepare('DELETE FROM proactive_proposals WHERE id=?').run(id);
      })();
      return true;
    },
    markShown(id: string, at: number): void {
      const old = read(id); if (old?.shown_at === undefined) { if (old) save({ ...old, shown_at: at }); }
    },
    saveSuppression(input: Omit<ProactiveSuppression, 'id' | 'created_at'>, at: number): ProactiveSuppression {
      if (!['person', 'place', 'date_range', 'episode', 'proposal_kind', 'merchant'].includes(input.kind)
        || (input.kind !== 'date_range' && !boundedText(input.value, 2000))
        || (input.kind === 'date_range' && (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.from! > input.to!))) throw new Error('Invalid suppression');
      const old = suppressions().find(row => row.kind === input.kind && row.value === input.value && row.from === input.from && row.to === input.to);
      if (old) return old;
      const next = { ...input, id: `suppression-${randomUUID()}`, created_at: at };
      db.prepare('INSERT INTO proactive_suppressions(id,value) VALUES(?,?)').run(next.id, JSON.stringify(next)); return next;
    },
    deleteSuppression(id: string): void { db.transaction(() => {
      const row = suppressions().find(value => value.id === id);
      db.prepare('DELETE FROM proactive_suppressions WHERE id=?').run(id);
      // A hidden episode's evidence rows stood for that episode alone, so they go with it.
      if (row?.kind === 'episode' && !row.of && row.value) for (const part of suppressions()) {
        if (part.kind === 'episode' && part.of === row.value) db.prepare('DELETE FROM proactive_suppressions WHERE id=?').run(part.id);
      }
    })(); },
    sourceEnabled(id: string): boolean {
      return (db.prepare('SELECT enabled FROM proactive_source_controls WHERE id=?').get(id) as { enabled: number } | undefined)?.enabled !== 0;
    },
    setSource(id: string, enabled: boolean): void {
      if (!boundedText(id, 2000) || typeof enabled !== 'boolean') throw new Error('Invalid intake source');
      db.prepare('INSERT INTO proactive_source_controls(id,enabled) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled').run(id, enabled ? 1 : 0);
    },
    receipt(key: string): boolean { return !!db.prepare('SELECT 1 FROM proactive_intake_receipts WHERE source_key=?').get(key); },
    recordReceipt(key: string, source_id: string, at: number): void { db.prepare('INSERT OR IGNORE INTO proactive_intake_receipts(source_key,source_id,at) VALUES(?,?,?)').run(key, source_id, at); },
    setSetting<T>(key: string, value: T): void {
      db.prepare('INSERT INTO proactive_intake_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    },
    outcomes: (after = 0): Array<{ id: number; proposal_id: string; at: number; outcome: string; actor: string; value: string }> =>
      db.prepare('SELECT * FROM proactive_proposal_outcomes WHERE id>? ORDER BY id LIMIT 10000').all(after) as Array<{ id: number; proposal_id: string; at: number; outcome: string; actor: string; value: string }>,
  };
  nativeEventReaders.set(store, pendingEvents); return store;
};
export type ProactiveProposalStore = ReturnType<typeof createProactiveProposalStore>;
