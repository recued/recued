/** D-329 §3.4 — the write rules an AI's approvals teach, kept in the server's database.
 *
 *  Three tables. `write_rule_answers`: one row per answered hold (its run), approved or
 *  refused, with its occasion. `write_rule_keys`: one row per rule key, its state —
 *  `watching`, `suggested` (an open suggestion), `accepted` (a rule was minted) or
 *  `dismissed` (the owner said no, or revoked the rule: for good). `write_rules`: the
 *  minted rules, each spent one use at a time.
 *
 *  The key and the rule carry no personal content: who (the owner's chats, or an AI app's
 *  contract id), the tool, and what it writes on (a work kind, a calendar id). The answers'
 *  arguments are never kept.
 *
 *  Synchronous over better-sqlite3: a spend is one statement in one transaction, so two
 *  calls racing for a rule's last use cannot both have it. */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import {
  evaluateWriteRuleEvidence,
  isWriteRuleLive,
  isWriteRuleTool,
  writeRuleKeyHash,
  WRITE_RULE_MAX_USES,
  WRITE_RULE_TTL_MS,
  type WriteRuleAnswer,
  type WriteRuleKey,
  type WriteRuleRow,
  type WriteRuleSuggestionRow,
} from '@recued/contracts';

/** A refusal the rpc reports as its code. */
export class WriteRuleError extends Error {
  constructor(readonly code: 'not_found' | 'bad_request', message: string) {
    super(message);
    this.name = 'WriteRuleError';
  }
}

export interface WriteRuleStore {
  /** Keep the owner's answer to a held write. `suggested` when this answer opened the key's
   *  suggestion, so the caller tells the owner once. An answer told twice (its run already
   *  kept) changes nothing. */
  recordAnswer(input: {
    readonly run_id: string;
    readonly key: WriteRuleKey;
    readonly outcome: WriteRuleAnswer['outcome'];
    readonly occasion: string;
    readonly at: number;
  }): { readonly suggested: boolean };
  /** The open suggestions whose evidence still holds, newest first. */
  listSuggestions(now: number): WriteRuleSuggestionRow[];
  /** Mint the rule an open suggestion names, within the ceilings (tighter if asked). */
  accept(
    key_hash: string,
    bounds: { readonly ttl_ms?: number; readonly max_uses?: number },
    now: number,
  ): { rule: WriteRuleRow; suggestion: WriteRuleSuggestionRow };
  /** Never suggest this key again. */
  dismiss(key_hash: string, now: number): void;
  /** The live rules, newest first. */
  listRules(now: number): WriteRuleRow[];
  /** End a rule, and never suggest its key again. */
  revoke(rule_id: string, now: number): WriteRuleRow;
  /** Spend one use of the live rule for this key; `undefined` when none applies. */
  use(key: WriteRuleKey, now: number): WriteRuleRow | undefined;
}

interface KeyRow {
  key_hash: string;
  key_json: string;
  state: 'watching' | 'suggested' | 'accepted' | 'dismissed';
  suggested_at: number | null;
  updated_at: number;
}

interface RuleRowDb {
  rule_id: string;
  key_hash: string;
  key_json: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  uses_remaining: number;
  revoked_at: number | null;
}

export const ensureWriteRuleSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS write_rule_answers (
      run_id    TEXT PRIMARY KEY,
      key_hash  TEXT NOT NULL,
      outcome   TEXT NOT NULL CHECK (outcome IN ('approved', 'refused')),
      occasion  TEXT NOT NULL,
      at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_write_rule_answers_key ON write_rule_answers (key_hash, at);
    CREATE TABLE IF NOT EXISTS write_rule_keys (
      key_hash      TEXT PRIMARY KEY,
      key_json      TEXT NOT NULL,
      state         TEXT NOT NULL CHECK (state IN ('watching', 'suggested', 'accepted', 'dismissed')),
      suggested_at  INTEGER,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS write_rules (
      rule_id         TEXT PRIMARY KEY,
      key_hash        TEXT NOT NULL,
      key_json        TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      max_uses        INTEGER NOT NULL,
      uses_remaining  INTEGER NOT NULL,
      revoked_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_write_rules_key ON write_rules (key_hash, created_at);
  `);
};

/** A stored key, read defensively: a row this version cannot read names no key. */
const parseKey = (json: string): WriteRuleKey | undefined => {
  try {
    const value = JSON.parse(json) as WriteRuleKey;
    const principal = value?.principal as { kind?: unknown; contract_id?: unknown } | undefined;
    const principalOk = principal?.kind === 'owner_chat'
      || (principal?.kind === 'ai_app' && typeof principal.contract_id === 'string' && principal.contract_id.length > 0);
    return principalOk && isWriteRuleTool(value.tool) && typeof value.scope === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
};

const toRule = (row: RuleRowDb): WriteRuleRow | undefined => {
  const key = parseKey(row.key_json);
  return key === undefined ? undefined : {
    rule_id: row.rule_id,
    key_hash: row.key_hash,
    key,
    created_at: row.created_at,
    expires_at: row.expires_at,
    max_uses: row.max_uses,
    uses_remaining: row.uses_remaining,
    ...(row.revoked_at !== null ? { revoked_at: row.revoked_at } : {}),
  };
};

const boundOf = (value: number | undefined, ceiling: number, name: string, min: number): number => {
  if (value === undefined) return ceiling;
  if (!Number.isInteger(value) || value < min || value > ceiling) {
    throw new WriteRuleError('bad_request', `${name} must be a whole number from ${min} to ${ceiling}`);
  }
  return value;
};

export const createWriteRuleStore = (
  db: Database.Database,
  options: { readonly newId?: () => string } = {},
): WriteRuleStore => {
  ensureWriteRuleSchema(db);
  const newId = options.newId ?? randomUUID;
  const insertAnswer = db.prepare(`INSERT OR IGNORE INTO write_rule_answers
    (run_id, key_hash, outcome, occasion, at) VALUES (@run_id, @key_hash, @outcome, @occasion, @at)`);
  const answersFor = db.prepare('SELECT outcome, occasion, at FROM write_rule_answers WHERE key_hash = ?');
  const insertKey = db.prepare(`INSERT INTO write_rule_keys (key_hash, key_json, state, suggested_at, updated_at)
    VALUES (@key_hash, @key_json, 'watching', NULL, @at) ON CONFLICT(key_hash) DO NOTHING`);
  const keyRow = db.prepare('SELECT * FROM write_rule_keys WHERE key_hash = ?');
  const setState = db.prepare(`UPDATE write_rule_keys SET state = @state, updated_at = @at,
    suggested_at = CASE WHEN @state = 'suggested' THEN @at ELSE suggested_at END WHERE key_hash = @key_hash`);
  const suggestedKeys = db.prepare(`SELECT * FROM write_rule_keys WHERE state = 'suggested'
    ORDER BY suggested_at DESC, key_hash`);
  const liveRuleFor = db.prepare(`SELECT * FROM write_rules WHERE key_hash = @key_hash AND revoked_at IS NULL
    AND expires_at > @now AND uses_remaining > 0 ORDER BY created_at DESC, rule_id LIMIT 1`);
  const insertRule = db.prepare(`INSERT INTO write_rules
    (rule_id, key_hash, key_json, created_at, expires_at, max_uses, uses_remaining, revoked_at)
    VALUES (@rule_id, @key_hash, @key_json, @created_at, @expires_at, @max_uses, @max_uses, NULL)`);
  const liveRules = db.prepare(`SELECT * FROM write_rules WHERE revoked_at IS NULL AND expires_at > ?
    AND uses_remaining > 0 ORDER BY created_at DESC, rule_id`);
  const ruleRow = db.prepare('SELECT * FROM write_rules WHERE rule_id = ?');
  const revokeRule = db.prepare('UPDATE write_rules SET revoked_at = @at WHERE rule_id = @rule_id AND revoked_at IS NULL');
  const spend = db.prepare(`UPDATE write_rules SET uses_remaining = uses_remaining - 1
    WHERE rule_id = @rule_id AND uses_remaining > 0 AND revoked_at IS NULL AND expires_at > @now`);

  const evidenceFor = (key_hash: string, now: number) =>
    evaluateWriteRuleEvidence(answersFor.all(key_hash) as WriteRuleAnswer[], now);

  const suggestionOf = (row: KeyRow, now: number): WriteRuleSuggestionRow | undefined => {
    const key = parseKey(row.key_json);
    if (key === undefined || row.suggested_at === null) return undefined;
    return { key_hash: row.key_hash, key, evidence: evidenceFor(row.key_hash, now), suggested_at: row.suggested_at };
  };

  const recordAnswer: WriteRuleStore['recordAnswer'] = db.transaction((input) => {
    const key_hash = writeRuleKeyHash(input.key);
    // Once per run: an answer told twice keeps its first row, and the evaluation below reads
    // the same rows again.
    insertAnswer.run({ run_id: input.run_id, key_hash, outcome: input.outcome, occasion: input.occasion, at: input.at });
    insertKey.run({ key_hash, key_json: JSON.stringify(input.key), at: input.at });
    const row = keyRow.get(key_hash) as KeyRow;
    if (row.state === 'dismissed') return { suggested: false };
    // A live rule raises no asks, so an answer here was asked before it: it teaches nothing.
    if (row.state === 'accepted' && liveRuleFor.get({ key_hash, now: input.at }) !== undefined) {
      return { suggested: false };
    }
    const evidence = evidenceFor(key_hash, input.at);
    if (row.state === 'suggested') {
      // A refusal withdraws the open suggestion: the owner just said no to this.
      if (!evidence.suggest) setState.run({ key_hash, state: 'watching', at: input.at });
      return { suggested: false };
    }
    if (!evidence.suggest) {
      if (row.state === 'accepted') setState.run({ key_hash, state: 'watching', at: input.at });
      return { suggested: false };
    }
    setState.run({ key_hash, state: 'suggested', at: input.at });
    return { suggested: true };
  });

  const listSuggestions: WriteRuleStore['listSuggestions'] = (now) =>
    (suggestedKeys.all() as KeyRow[])
      .map((row) => suggestionOf(row, now))
      .filter((row): row is WriteRuleSuggestionRow => row !== undefined && row.evidence.suggest);

  const accept: WriteRuleStore['accept'] = db.transaction((key_hash: string, bounds, now: number) => {
    const row = keyRow.get(key_hash) as KeyRow | undefined;
    if (row === undefined) throw new WriteRuleError('not_found', `no write rule suggestion '${key_hash}'`);
    if (row.state === 'dismissed') {
      throw new WriteRuleError('bad_request', `the write rule suggestion '${key_hash}' was dismissed for good`);
    }
    const live = liveRuleFor.get({ key_hash, now }) as RuleRowDb | undefined;
    if (row.state === 'accepted' && live !== undefined) {
      // A retry of an accept that landed: the rule it minted, not a twin.
      return { rule: toRule(live)!, suggestion: suggestionOf(row, now)! };
    }
    const suggestion = row.state === 'suggested' ? suggestionOf(row, now) : undefined;
    if (suggestion === undefined || !suggestion.evidence.suggest) {
      throw new WriteRuleError('bad_request', `no open write rule suggestion '${key_hash}'`);
    }
    const ttl = boundOf(bounds.ttl_ms, WRITE_RULE_TTL_MS, 'ttl_ms', 1);
    const max_uses = boundOf(bounds.max_uses, WRITE_RULE_MAX_USES, 'max_uses', 1);
    const rule_id = newId();
    insertRule.run({ rule_id, key_hash, key_json: row.key_json, created_at: now, expires_at: now + ttl, max_uses });
    setState.run({ key_hash, state: 'accepted', at: now });
    return { rule: toRule(ruleRow.get(rule_id) as RuleRowDb)!, suggestion };
  }) as WriteRuleStore['accept'];

  const dismiss: WriteRuleStore['dismiss'] = (key_hash, now) => {
    const row = keyRow.get(key_hash) as KeyRow | undefined;
    if (row === undefined) throw new WriteRuleError('not_found', `no write rule suggestion '${key_hash}'`);
    if (row.state === 'dismissed') return;
    if (row.state === 'accepted' && liveRuleFor.get({ key_hash, now }) !== undefined) {
      throw new WriteRuleError('bad_request', `the suggestion '${key_hash}' is a rule now: revoke the rule instead`);
    }
    setState.run({ key_hash, state: 'dismissed', at: now });
  };

  const listRules: WriteRuleStore['listRules'] = (now) =>
    (liveRules.all(now) as RuleRowDb[])
      .map(toRule)
      .filter((rule): rule is WriteRuleRow => rule !== undefined && isWriteRuleLive(rule, now));

  const revoke: WriteRuleStore['revoke'] = db.transaction((rule_id: string, now: number) => {
    const before = ruleRow.get(rule_id) as RuleRowDb | undefined;
    if (before === undefined) throw new WriteRuleError('not_found', `no write rule '${rule_id}'`);
    revokeRule.run({ rule_id, at: now });
    setState.run({ key_hash: before.key_hash, state: 'dismissed', at: now });
    return toRule(ruleRow.get(rule_id) as RuleRowDb)!;
  }) as WriteRuleStore['revoke'];

  const use: WriteRuleStore['use'] = db.transaction((key: WriteRuleKey, now: number) => {
    const key_hash = writeRuleKeyHash(key);
    const live = liveRuleFor.get({ key_hash, now }) as RuleRowDb | undefined;
    if (live === undefined) return undefined;
    if (spend.run({ rule_id: live.rule_id, now }).changes === 0) return undefined;
    return toRule(ruleRow.get(live.rule_id) as RuleRowDb);
  }) as WriteRuleStore['use'];

  return { recordAnswer, listSuggestions, accept, dismiss, listRules, revoke, use };
};
