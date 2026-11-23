/** D-348 slice 2 — what the chain evidence teaches: each request key's suggestion, and the rules
 *  the owner accepts. Kept in the server's database beside the evidence
 *  (`chain-evidence-store.ts`), which it reads.
 *
 *  Two tables. `chain_keys`: one row per request key, its state (`watching`, `suggested`,
 *  `accepted`, `dismissed`: the owner said no, or ended its rule, for good) and the open
 *  suggestion's calls and deletes. `chain_rules`: the minted rules, each spent one use at a time,
 *  with what the owner accepted (the words and each call) sealed for the page that lists them. A
 *  rule also ends when the owner undoes a change one of its calls made, but not for good
 *  (`endForUndo`).
 *
 *  🔑 NEVER SILENT (Q6). A call the owner approved outside a live rule grows the evidence, and a
 *  longer chain is suggested again; a rule only ever holds what the owner accepted. A delete is
 *  offered on its own (Q7): accepting a chain takes its deletes only when the owner says so.
 *
 *  Synchronous over better-sqlite3 for its decisions (a spend is one statement in one
 *  transaction, so two calls racing for a rule's last use cannot both have it); asynchronous only
 *  where it seals or opens what the owner reads. */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import {
  CHAIN_RULE_MAX_USES,
  CHAIN_RULE_TTL_MS,
  CHAIN_LOOKBACK_MS,
  evaluateChainEvidence,
  isChainCallAnswer,
  isChainCallOutcome,
  type ChainCallSignature,
  type ChainCallView,
  type ChainEvidence,
  type ChainEvidenceRequest,
  type ChainRuleRow,
  type ChainSuggestionRow,
} from '@recued/contracts';

import type { ChainSealing } from './chain-evidence-store.js';

/** A refusal the rpc reports as its code. */
export class ChainRuleError extends Error {
  constructor(readonly code: 'not_found' | 'bad_request', message: string) {
    super(message);
    this.name = 'ChainRuleError';
  }
}

/** D-348 — a rule made (`mint`), ended (`revoke`, a longer chain's replacing it too) or used
 *  (`use`), as the store tells its listeners. */
export interface ChainRuleChange {
  readonly op: 'mint' | 'revoke' | 'use';
  readonly rule_id: string;
}

export interface ChainRuleStore {
  /** Learn from the request a run was held for, after one of its calls was answered or settled.
   *  `suggested` when this opened the key's suggestion or grew it, so the caller tells the owner. */
  learnForRun(run_id: string, now: number): { readonly suggested: boolean; readonly key_hash?: string };
  /** The open suggestions whose evidence still holds, newest first. */
  listSuggestions(now: number): Promise<ChainSuggestionRow[]>;
  /** Mint the rule an open suggestion names, within the ceilings (tighter if asked). Its deletes
   *  only when `deletes` is true (Q7). A live rule for the key is replaced; given no bounds, the
   *  new one keeps its days and uses left, so a rule the owner tightened never loosens. */
  accept(
    key_hash: string,
    options: { readonly deletes?: boolean; readonly ttl_ms?: number; readonly max_uses?: number },
    now: number,
  ): Promise<{ rule: ChainRuleRow; suggestion: ChainSuggestionRow }>;
  /** Never suggest this key again (`all`), or never its deletes (`deletes`). */
  dismiss(key_hash: string, part: 'all' | 'deletes', now: number): void;
  /** The live rules, newest first. */
  listRules(now: number): Promise<ChainRuleRow[]>;
  /** End a rule, and never suggest its key again. */
  revoke(rule_id: string, now: number): Promise<ChainRuleRow>;
  /** Q4 — the owner undid a change one of these calls made: the key's live rule ends when it holds
   *  one of them, but not for good, as the owner's End is. The key is suggested again once its
   *  occasions after the undo hold. Undefined when no live rule holds them. */
  endForUndo(
    key_hash: string,
    signature_hashes: readonly string[],
    now: number,
  ): { readonly rule_id: string; readonly uses_remaining: number } | undefined;
  /** Q4 — the owner undid a change this rule made without asking (its commit names it): its key is
   *  reset as of now, its request having held nothing, and the rule ends if it is live, not for
   *  good. Kept once per change. Undefined when there is no such rule, or it had ended. */
  endRuleForUndo(
    rule_id: string,
    receipt_id: string,
    now: number,
  ): { readonly rule_id: string; readonly key_hash: string; readonly uses_remaining: number } | undefined;
  /** A chat's own write this rule let through without asking, by its call's id: an undo of its
   *  change reads it back (`ruleOfCall`), as a gateway write's commit names its rule. */
  noteRuleCall(call_id: string, rule_id: string, now: number): void;
  ruleOfCall(call_id: string): string | undefined;
  /** The words the key was asked in, the latest time (for the notice). */
  wordsOf(key_hash: string): Promise<string | undefined>;
  /** Spend one use of the key's live rule when the call is on it; `undefined` when none applies. */
  use(
    key_hash: string,
    signature_hash: string,
    now: number,
  ): { readonly rule_id: string; readonly uses_remaining: number; readonly delete: boolean } | undefined;
  /** Told after each change to a rule, so Live control's list of them stays current (the server
   *  fans it as `contract.chain_rule_changed`). A listener that throws changes nothing. */
  onChange(listener: (change: ChainRuleChange) => void): () => void;
}

type KeyState = 'watching' | 'suggested' | 'accepted' | 'dismissed';

interface KeyRow {
  key_hash: string;
  state: KeyState;
  members_json: string;
  deletes_json: string;
  deletes_dismissed: number;
  suggested_at: number | null;
  updated_at: number;
}

interface RuleRowDb {
  rule_id: string;
  key_hash: string;
  members_json: string;
  deletes_json: string;
  display_encrypted: string | null;
  created_at: number;
  expires_at: number;
  max_uses: number;
  uses_remaining: number;
  revoked_at: number | null;
}

export const ensureChainRuleSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chain_keys (
      key_hash           TEXT PRIMARY KEY,
      state              TEXT NOT NULL CHECK (state IN ('watching', 'suggested', 'accepted', 'dismissed')),
      members_json       TEXT NOT NULL DEFAULT '[]',
      deletes_json       TEXT NOT NULL DEFAULT '[]',
      deletes_dismissed  INTEGER NOT NULL DEFAULT 0,
      suggested_at       INTEGER,
      updated_at         INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chain_rules (
      rule_id            TEXT PRIMARY KEY,
      key_hash           TEXT NOT NULL,
      members_json       TEXT NOT NULL,
      deletes_json       TEXT NOT NULL,
      display_encrypted  TEXT,
      created_at         INTEGER NOT NULL,
      expires_at         INTEGER NOT NULL,
      max_uses           INTEGER NOT NULL,
      uses_remaining     INTEGER NOT NULL,
      revoked_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chain_rules_key ON chain_rules (key_hash, created_at);
    -- An undo of a change a rule made without asking: its request is reset as of then, though it
    -- held nothing (§7.8). Kept with the rule, as the rule outlives its conversation.
    CREATE TABLE IF NOT EXISTS chain_rule_undos (
      receipt_id  TEXT PRIMARY KEY,
      rule_id     TEXT NOT NULL,
      key_hash    TEXT NOT NULL,
      at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chain_rule_undos_key ON chain_rule_undos (key_hash, at);
    -- A chat's own write a request's rule let through, by its call: which rule an undo of it ends.
    CREATE TABLE IF NOT EXISTS chain_rule_calls (
      call_id  TEXT PRIMARY KEY,
      rule_id  TEXT NOT NULL,
      at       INTEGER NOT NULL
    );
  `);
};

const hashes = (json: string): string[] => {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((hash): hash is string => typeof hash === 'string') : [];
  } catch {
    return [];
  }
};

const union = (...lists: ReadonlyArray<readonly string[]>): string[] => [...new Set(lists.flat())].sort();

const boundOf = (value: number | undefined, ceiling: number, name: string): number => {
  if (value === undefined) return ceiling;
  if (!Number.isInteger(value) || value < 1 || value > ceiling) {
    throw new ChainRuleError('bad_request', `${name} must be a whole number from 1 to ${ceiling}`);
  }
  return value;
};

/** What a rule shows, sealed with it: the words and each call, as the owner accepted them. */
interface RuleDisplay {
  readonly words?: string;
  readonly signatures: Readonly<Record<string, ChainCallSignature>>;
}

export const createChainRuleStore = (
  db: Database.Database,
  evidence: ChainSealing,
  options: { readonly newId?: () => string } = {},
): ChainRuleStore => {
  ensureChainRuleSchema(db);
  const newId = options.newId ?? randomUUID;

  const keyOfRun = db.prepare(`SELECT r.key_hash AS key_hash FROM chain_runs u
    JOIN chain_requests r ON r.request_id = u.request_id WHERE u.run_id = ?`);
  const requestsOf = db.prepare(`SELECT r.request_id, r.occasion, r.at,
      (SELECT COUNT(*) FROM chain_runs u WHERE u.request_id = r.request_id) AS held_runs,
      (SELECT COUNT(DISTINCT c.run_id) FROM chain_calls c WHERE c.request_id = r.request_id) AS answered_runs
    FROM chain_requests r WHERE r.key_hash = @key_hash AND r.at >= @since`);
  const callsOf = db.prepare(`SELECT c.request_id, c.signature_hash, c.is_delete, c.answer, c.outcome
    FROM chain_calls c JOIN chain_requests r ON r.request_id = c.request_id
    WHERE r.key_hash = @key_hash AND r.at >= @since`);
  // Q4 — the key's latest undo, whenever the request it undid was made: it resets as of the undo.
  // A change a held call made names its request; one its rule made, the rule; one another
  // permission let through without a hold, its request's key (§7.8).
  const latestUndo = db.prepare(`SELECT MAX(at) AS at FROM (
    SELECT u.at FROM chain_undos u JOIN chain_requests r ON r.request_id = u.request_id WHERE r.key_hash = @key_hash
    UNION ALL SELECT at FROM chain_rule_undos WHERE key_hash = @key_hash
    UNION ALL SELECT at FROM chain_unheld_undos WHERE key_hash = @key_hash)`);
  const insertRuleUndo = db.prepare(`INSERT OR IGNORE INTO chain_rule_undos (receipt_id, rule_id, key_hash, at)
    VALUES (@receipt_id, @rule_id, @key_hash, @at)`);
  const insertRuleCall = db.prepare('INSERT OR IGNORE INTO chain_rule_calls (call_id, rule_id, at) VALUES (?, ?, ?)');
  const ruleCallRow = db.prepare('SELECT rule_id FROM chain_rule_calls WHERE call_id = ?');
  const latestWords = db.prepare(`SELECT request_id, words_encrypted FROM chain_requests
    WHERE key_hash = ? ORDER BY at DESC, request_id DESC LIMIT 1`);
  const latestCallOf = db.prepare(`SELECT c.checkpoint_id, c.signature_encrypted FROM chain_calls c
    JOIN chain_requests r ON r.request_id = c.request_id
    WHERE r.key_hash = @key_hash AND c.signature_hash = @signature_hash AND c.signature_encrypted IS NOT NULL
    ORDER BY c.at DESC, c.checkpoint_id DESC LIMIT 1`);
  const insertKey = db.prepare(`INSERT INTO chain_keys (key_hash, state, updated_at)
    VALUES (?, 'watching', ?) ON CONFLICT(key_hash) DO NOTHING`);
  const keyRow = db.prepare('SELECT * FROM chain_keys WHERE key_hash = ?');
  const setKey = db.prepare(`UPDATE chain_keys SET state = @state, members_json = @members_json,
    deletes_json = @deletes_json, updated_at = @at,
    suggested_at = CASE WHEN @opened = 1 THEN @at ELSE suggested_at END WHERE key_hash = @key_hash`);
  const dismissDeletes = db.prepare('UPDATE chain_keys SET deletes_dismissed = 1, updated_at = ? WHERE key_hash = ?');
  const suggestedKeys = db.prepare(`SELECT * FROM chain_keys WHERE state = 'suggested'
    ORDER BY suggested_at DESC, key_hash`);
  const liveRuleFor = db.prepare(`SELECT * FROM chain_rules WHERE key_hash = @key_hash AND revoked_at IS NULL
    AND expires_at > @now AND uses_remaining > 0 ORDER BY created_at DESC, rule_id LIMIT 1`);
  const insertRule = db.prepare(`INSERT INTO chain_rules (rule_id, key_hash, members_json, deletes_json,
    display_encrypted, created_at, expires_at, max_uses, uses_remaining, revoked_at)
    VALUES (@rule_id, @key_hash, @members_json, @deletes_json, @display_encrypted, @created_at, @expires_at,
      @max_uses, @uses_remaining, NULL)`);
  const endRule = db.prepare('UPDATE chain_rules SET revoked_at = @at WHERE rule_id = @rule_id AND revoked_at IS NULL');
  const ruleRow = db.prepare('SELECT * FROM chain_rules WHERE rule_id = ?');
  const liveRules = db.prepare(`SELECT * FROM chain_rules WHERE revoked_at IS NULL AND expires_at > ?
    AND uses_remaining > 0 ORDER BY created_at DESC, rule_id`);
  const spend = db.prepare(`UPDATE chain_rules SET uses_remaining = uses_remaining - 1
    WHERE rule_id = @rule_id AND uses_remaining > 0 AND revoked_at IS NULL AND expires_at > @now`);

  /** The key's evidence, read from the evidence tables. */
  const evidenceOf = (key_hash: string, now: number): ChainEvidence => {
    const since = now - CHAIN_LOOKBACK_MS;
    const calls = new Map<string, ChainEvidenceRequest['calls'][number][]>();
    for (const row of callsOf.all({ key_hash, since }) as Array<Record<string, unknown>>) {
      if (!isChainCallAnswer(row.answer)) continue;
      const list = calls.get(row.request_id as string) ?? [];
      list.push({
        signature_hash: typeof row.signature_hash === 'string' ? row.signature_hash : null,
        delete: row.is_delete === 1,
        answer: row.answer,
        outcome: isChainCallOutcome(row.outcome) ? row.outcome : null,
      });
      calls.set(row.request_id as string, list);
    }
    const requests: ChainEvidenceRequest[] = (requestsOf.all({ key_hash, since }) as Array<Record<string, unknown>>)
      .map((row) => ({
        occasion: row.occasion as string,
        at: row.at as number,
        held_runs: row.held_runs as number,
        answered_runs: row.answered_runs as number,
        calls: calls.get(row.request_id as string) ?? [],
      }));
    const undone_at = (latestUndo.get({ key_hash }) as { at: number | null } | undefined)?.at ?? undefined;
    return evaluateChainEvidence(requests, now, undone_at);
  };

  /** What the key's evidence asks of the owner beyond its live rule: the calls the rule would hold
   *  (its own and those learned since) and the deletes it does not, unless they were turned down. */
  const openFor = (row: KeyRow, now: number): { members: string[]; deletes: string[]; grows: boolean } => {
    const learned = evidenceOf(row.key_hash, now);
    const live = liveRuleFor.get({ key_hash: row.key_hash, now }) as RuleRowDb | undefined;
    const ruleMembers = live !== undefined ? hashes(live.members_json) : [];
    const ruleDeletes = new Set(live !== undefined ? hashes(live.deletes_json) : []);
    const newMembers = learned.members.filter((hash) => !ruleMembers.includes(hash));
    const deletes = row.deletes_dismissed === 1 ? [] : learned.deletes.filter((hash) => !ruleDeletes.has(hash));
    return { members: union(ruleMembers, learned.members), deletes, grows: newMembers.length > 0 || deletes.length > 0 };
  };

  const learnForRun: ChainRuleStore['learnForRun'] = db.transaction((run_id: string, now: number) => {
    const key_hash = (keyOfRun.get(run_id) as { key_hash?: string } | undefined)?.key_hash;
    if (key_hash === undefined) return { suggested: false };
    insertKey.run(key_hash, now);
    const row = keyRow.get(key_hash) as KeyRow;
    if (row.state === 'dismissed') return { suggested: false, key_hash };
    const open = openFor(row, now);
    const live = liveRuleFor.get({ key_hash, now }) !== undefined;
    if (!open.grows) {
      // Nothing beyond the rule: a suggestion a reset withdrew, or one the rule now holds.
      if (row.state === 'suggested' || (row.state === 'accepted' && !live)) {
        setKey.run({ key_hash, state: live ? 'accepted' : 'watching', members_json: '[]', deletes_json: '[]', at: now, opened: 0 });
      }
      return { suggested: false, key_hash };
    }
    const before = new Set([...hashes(row.members_json), ...hashes(row.deletes_json)]);
    const opened = row.state !== 'suggested' || [...open.members, ...open.deletes].some((hash) => !before.has(hash));
    setKey.run({
      key_hash, state: 'suggested', members_json: JSON.stringify(open.members), deletes_json: JSON.stringify(open.deletes),
      at: now, opened: opened ? 1 : 0,
    });
    return { suggested: opened, key_hash };
  }) as ChainRuleStore['learnForRun'];

  const opened = async (kind: 'request' | 'call' | 'rule', id: string, blob: string | null | undefined): Promise<string | undefined> => {
    if (typeof blob !== 'string') return undefined;
    try { return await evidence.open(kind, id, blob); } catch { return undefined; }
  };

  /** The words the key was asked in, the latest time. */
  const wordsOf = async (key_hash: string): Promise<string | undefined> => {
    const row = latestWords.get(key_hash) as { request_id: string; words_encrypted: string } | undefined;
    return row === undefined ? undefined : opened('request', row.request_id, row.words_encrypted);
  };

  /** A call as the owner reads it, from the latest time it was asked. */
  const callOf = async (key_hash: string, signature_hash: string): Promise<ChainCallView> => {
    const row = latestCallOf.get({ key_hash, signature_hash }) as { checkpoint_id: string; signature_encrypted: string } | undefined;
    const text = row === undefined ? undefined : await opened('call', row.checkpoint_id, row.signature_encrypted);
    if (text === undefined) return { signature_hash };
    try { return { signature_hash, signature: JSON.parse(text) as ChainCallSignature }; } catch { return { signature_hash }; }
  };

  const suggestionOf = async (row: KeyRow, now: number): Promise<ChainSuggestionRow | undefined> => {
    if (row.suggested_at === null) return undefined;
    const live = liveRuleFor.get({ key_hash: row.key_hash, now }) as RuleRowDb | undefined;
    const words = await wordsOf(row.key_hash);
    return {
      key_hash: row.key_hash,
      ...(words !== undefined ? { words } : {}),
      members: await Promise.all(hashes(row.members_json).map((hash) => callOf(row.key_hash, hash))),
      deletes: await Promise.all(hashes(row.deletes_json).map((hash) => callOf(row.key_hash, hash))),
      evidence: evidenceOf(row.key_hash, now),
      suggested_at: row.suggested_at,
      ...(live !== undefined ? { rule_id: live.rule_id } : {}),
    };
  };

  const ruleOf = async (row: RuleRowDb): Promise<ChainRuleRow> => {
    const text = await opened('rule', row.rule_id, row.display_encrypted);
    let display: RuleDisplay = { signatures: {} };
    if (text !== undefined) {
      try { display = JSON.parse(text) as RuleDisplay; } catch { /* shown by its hashes */ }
    }
    const view = (hash: string): ChainCallView => {
      const signature = display.signatures?.[hash];
      return signature !== undefined ? { signature_hash: hash, signature } : { signature_hash: hash };
    };
    return {
      rule_id: row.rule_id,
      key_hash: row.key_hash,
      ...(display.words !== undefined ? { words: display.words } : {}),
      members: hashes(row.members_json).map(view),
      deletes: hashes(row.deletes_json).map(view),
      created_at: row.created_at,
      expires_at: row.expires_at,
      max_uses: row.max_uses,
      uses_remaining: row.uses_remaining,
      ...(row.revoked_at !== null ? { revoked_at: row.revoked_at } : {}),
    };
  };

  /** D-348 — who is told of a rule's changes (`onChange`); one that throws changes nothing. */
  const listeners = new Set<(change: ChainRuleChange) => void>();
  const changed = (change: ChainRuleChange): void => {
    for (const listener of listeners) {
      try { listener(change); } catch { /* the change is made: a listener's failure is its own */ }
    }
  };
  const spendOne = db.transaction((key_hash: string, signature_hash: string, now: number) => {
    const live = liveRuleFor.get({ key_hash, now }) as RuleRowDb | undefined;
    if (live === undefined) return undefined;
    const isDelete = hashes(live.deletes_json).includes(signature_hash);
    if (!isDelete && !hashes(live.members_json).includes(signature_hash)) return undefined;
    if (spend.run({ rule_id: live.rule_id, now }).changes === 0) return undefined;
    return { rule_id: live.rule_id, uses_remaining: live.uses_remaining - 1, delete: isDelete };
  }) as ChainRuleStore['use'];
  const endUndone = db.transaction((key_hash: string, signature_hashes: readonly string[], now: number) => {
    const live = liveRuleFor.get({ key_hash, now }) as RuleRowDb | undefined;
    if (live === undefined) return undefined;
    const held = [...hashes(live.members_json), ...hashes(live.deletes_json)];
    if (!signature_hashes.some((hash) => held.includes(hash))) return undefined;
    endRule.run({ rule_id: live.rule_id, at: now });
    // Not for good: the undo reset the key's evidence, and it is suggested again once that holds.
    insertKey.run(key_hash, now);
    setKey.run({ key_hash, state: 'watching', members_json: '[]', deletes_json: '[]', at: now, opened: 0 });
    return { rule_id: live.rule_id, uses_remaining: live.uses_remaining };
  }) as ChainRuleStore['endForUndo'];
  const endRuleUndone = db.transaction((rule_id: string, receipt_id: string, now: number) => {
    const rule = ruleRow.get(rule_id) as RuleRowDb | undefined;
    if (rule === undefined) return undefined;
    insertRuleUndo.run({ receipt_id, rule_id, key_hash: rule.key_hash, at: now });
    if (rule.revoked_at !== null || rule.expires_at <= now || rule.uses_remaining <= 0) return undefined;
    endRule.run({ rule_id, at: now });
    // Not for good: the undo reset the key's evidence, and it is suggested again once that holds. (A
    // live rule's key is never dismissed: ending a rule for good ends it, and a dismiss refuses one.)
    insertKey.run(rule.key_hash, now);
    setKey.run({ key_hash: rule.key_hash, state: 'watching', members_json: '[]', deletes_json: '[]', at: now, opened: 0 });
    return { rule_id, key_hash: rule.key_hash, uses_remaining: rule.uses_remaining };
  }) as ChainRuleStore['endRuleForUndo'];

  return {
    learnForRun,
    wordsOf,

    async listSuggestions(now) {
      const rows: ChainSuggestionRow[] = [];
      for (const row of suggestedKeys.all() as KeyRow[]) {
        // The evidence is read again: a suggestion a reset or an aged-out occasion withdrew is not listed.
        if (!openFor(row, now).grows) continue;
        const suggestion = await suggestionOf(row, now);
        if (suggestion !== undefined) rows.push(suggestion);
      }
      return rows;
    },

    async accept(key_hash, options, now) {
      const row = keyRow.get(key_hash) as KeyRow | undefined;
      if (row === undefined) throw new ChainRuleError('not_found', `no chain suggestion '${key_hash}'`);
      if (row.state === 'dismissed') throw new ChainRuleError('bad_request', `the chain suggestion '${key_hash}' was dismissed for good`);
      if (row.state !== 'suggested' || !openFor(row, now).grows) {
        const live = liveRuleFor.get({ key_hash, now }) as RuleRowDb | undefined;
        // A retry of an accept that landed: the rule it minted, not a twin.
        if (live !== undefined && row.state === 'accepted') {
          return { rule: await ruleOf(live), suggestion: (await suggestionOf(row, now))! };
        }
        throw new ChainRuleError('bad_request', `no open chain suggestion '${key_hash}'`);
      }
      const ttl = boundOf(options.ttl_ms, CHAIN_RULE_TTL_MS, 'ttl_ms');
      const max_uses = boundOf(options.max_uses, CHAIN_RULE_MAX_USES, 'max_uses');
      const suggestion = (await suggestionOf(row, now))!;
      const live = liveRuleFor.get({ key_hash, now }) as RuleRowDb | undefined;
      // Replacing a live rule with no bounds given: its days and uses left carry over.
      const carried = live !== undefined && options.ttl_ms === undefined && options.max_uses === undefined;
      const bounds = carried
        ? { expires_at: live.expires_at, max_uses: live.max_uses, uses_remaining: live.uses_remaining }
        : { expires_at: now + ttl, max_uses, uses_remaining: max_uses };
      const offeredDeletes = hashes(row.deletes_json);
      const deletes = union(live !== undefined ? hashes(live.deletes_json) : [], options.deletes === true ? offeredDeletes : []);
      const members = hashes(row.members_json);
      const rule_id = newId();
      const display: RuleDisplay = {
        ...(suggestion.words !== undefined ? { words: suggestion.words } : {}),
        signatures: Object.fromEntries([...suggestion.members, ...suggestion.deletes]
          .filter((view) => view.signature !== undefined && (members.includes(view.signature_hash) || deletes.includes(view.signature_hash)))
          .map((view) => [view.signature_hash, view.signature!])),
      };
      // The older rule's calls keep showing as the owner accepted them.
      if (live !== undefined) {
        const before = await ruleOf(live);
        for (const view of [...before.members, ...before.deletes]) {
          if (view.signature !== undefined && !(view.signature_hash in display.signatures)) {
            (display.signatures as Record<string, ChainCallSignature>)[view.signature_hash] = view.signature;
          }
        }
      }
      const display_encrypted = await evidence.seal('rule', rule_id, JSON.stringify(display));
      db.transaction(() => {
        if (live !== undefined) endRule.run({ rule_id: live.rule_id, at: now });
        insertRule.run({
          rule_id, key_hash, members_json: JSON.stringify(members), deletes_json: JSON.stringify(deletes),
          display_encrypted, created_at: now, ...bounds,
        });
        // Deletes not taken stay offered, on their own (Q7).
        const stillOffered = options.deletes === true ? [] : offeredDeletes;
        setKey.run({
          key_hash, state: stillOffered.length > 0 ? 'suggested' : 'accepted',
          members_json: JSON.stringify(stillOffered.length > 0 ? members : []),
          deletes_json: JSON.stringify(stillOffered), at: now, opened: 0,
        });
      })();
      if (live !== undefined) changed({ op: 'revoke', rule_id: live.rule_id });
      changed({ op: 'mint', rule_id });
      return { rule: await ruleOf(ruleRow.get(rule_id) as RuleRowDb), suggestion };
    },

    dismiss(key_hash, part, now) {
      const row = keyRow.get(key_hash) as KeyRow | undefined;
      if (row === undefined) throw new ChainRuleError('not_found', `no chain suggestion '${key_hash}'`);
      if (row.state === 'dismissed') return;
      const live = liveRuleFor.get({ key_hash, now }) !== undefined;
      if (part === 'deletes') {
        db.transaction(() => {
          dismissDeletes.run(now, key_hash);
          const open = openFor({ ...row, deletes_dismissed: 1 }, now);
          if (!open.grows) {
            setKey.run({ key_hash, state: live ? 'accepted' : 'watching', members_json: '[]', deletes_json: '[]', at: now, opened: 0 });
          } else {
            setKey.run({ key_hash, state: 'suggested', members_json: JSON.stringify(open.members), deletes_json: '[]', at: now, opened: 0 });
          }
        })();
        return;
      }
      if (live) throw new ChainRuleError('bad_request', `the suggestion '${key_hash}' has a rule: end the rule instead`);
      setKey.run({ key_hash, state: 'dismissed', members_json: '[]', deletes_json: '[]', at: now, opened: 0 });
    },

    async listRules(now) {
      return Promise.all((liveRules.all(now) as RuleRowDb[]).map(ruleOf));
    },

    async revoke(rule_id, now) {
      const before = ruleRow.get(rule_id) as RuleRowDb | undefined;
      if (before === undefined) throw new ChainRuleError('not_found', `no chain rule '${rule_id}'`);
      db.transaction(() => {
        endRule.run({ rule_id, at: now });
        insertKey.run(before.key_hash, now);
        setKey.run({ key_hash: before.key_hash, state: 'dismissed', members_json: '[]', deletes_json: '[]', at: now, opened: 0 });
      })();
      changed({ op: 'revoke', rule_id });
      return ruleOf(ruleRow.get(rule_id) as RuleRowDb);
    },

    endForUndo(key_hash, signature_hashes, now) {
      const ended = endUndone(key_hash, signature_hashes, now);
      if (ended !== undefined) changed({ op: 'revoke', rule_id: ended.rule_id });
      return ended;
    },

    endRuleForUndo(rule_id, receipt_id, now) {
      const ended = endRuleUndone(rule_id, receipt_id, now);
      if (ended !== undefined) changed({ op: 'revoke', rule_id });
      return ended;
    },

    noteRuleCall(call_id, rule_id, now) {
      insertRuleCall.run(call_id, rule_id, now);
    },

    ruleOfCall: (call_id) => (ruleCallRow.get(call_id) as { rule_id?: string } | undefined)?.rule_id,

    use(key_hash, signature_hash, now) {
      const used = spendOne(key_hash, signature_hash, now);
      if (used !== undefined) changed({ op: 'use', rule_id: used.rule_id });
      return used;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};
