/** D-335 slice F — passes for Browser Toolkit writes, and what their approvals teach, kept in
 *  the server's database. The answers and keys, as D-329's write rules keep theirs:
 *  `browser_pass_answers`: one row per answered hold (its run), approved or refused, with its
 *  occasion and the element it was for (as the page names it, for the suggestion to list).
 *  `browser_pass_keys`: one row per key, its state — `watching`, `suggested` (an open
 *  suggestion to always allow it), `accepted` (an always pass) or `dismissed` (the owner said
 *  no, or ended the always pass: no more suggestions). `browser_passes`: the passes, "for this
 *  session" (one conversation, until it expires) or "always" (no end, no use limit).
 *  `browser_request_passes`: the conversation's request pass, with a new generation on each start.
 *  `browser_pass_decisions`: the pass or request generation a saved approval selected. The
 *  binding survives revocation and expiry, so an old answer cannot create a replacement.
 *  What it keeps: who (the owner's chats, or an AI app's contract id), the recipe, the site's
 *  origin, and the element's role and name as the page showed it. Never the text typed.
 *  ⛔ Unlike a D-329 rule, an always pass is minted from the ask itself too, and after a
 *  dismissal: "Always allow" stays on the asks (§3.4). Only the SUGGESTION is ended for good. */

import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import {
  BROWSER_PASS_SESSION_TTL_MS,
  BROWSER_REQUEST_PASS_TTL_MS,
  browserPassKeyHash,
  browserPassOffersRequest,
  evaluateWriteRuleEvidence,
  isBrowserPassLive,
  readBrowserPassOffer,
  WRITE_RULE_LOOKBACK_MS,
  type BrowserPassKey,
  type BrowserPassAnswerKind,
  type BrowserPassKind,
  type BrowserPassOffer,
  type BrowserPassRow,
  type BrowserPassSuggestionRow,
  type BrowserRequestPass,
  type WriteRuleAnswer,
} from '@recued/contracts';

/** A refusal the rpc reports as its code. */
export class BrowserPassError extends Error {
  constructor(readonly code: 'not_found' | 'bad_request', message: string) {
    super(message);
    this.name = 'BrowserPassError';
  }
}

/** The elements a suggestion lists, at most. */
const SUGGESTION_ELEMENTS_MAX = 10;

export interface BrowserPassApprovalInput {
  readonly approval_ref: string;
  readonly offer: BrowserPassOffer;
  readonly kind: BrowserPassAnswerKind;
  readonly now: number;
}

export interface BrowserPassStore {
  /** The live pass covering this key in this conversation, with one more use counted, or
   *  undefined (⇒ the write asks). An always pass first, then this conversation's. */
  use(key: BrowserPassKey, channel_session_id: string | undefined, now: number): BrowserPassRow | undefined;
  /** Mint the pass an answer gave. A key's live always pass, or this conversation's live
   *  session pass, is returned rather than twinned. An always pass marks the key accepted,
   *  whatever its suggestion's state. */
  mint(input: {
    readonly key: BrowserPassKey;
    readonly host: string;
    readonly kind: BrowserPassKind;
    readonly channel_session_id?: string;
    readonly now: number;
  }): BrowserPassRow;
  /** Select a pass and bind a saved approval in one transaction. Replays leave the
   *  original selection alone, including when it ended, expired, or was removed. */
  grantForDecision(input: BrowserPassApprovalInput): void;
  /** Keep the owner's answer to a held browser write. `suggested` when this answer opened the
   *  key's suggestion, so the caller tells the owner once. An answer told twice (its run
   *  already kept) changes nothing. */
  recordAnswer(input: {
    readonly run_id: string;
    readonly key: BrowserPassKey;
    readonly host: string;
    readonly outcome: WriteRuleAnswer['outcome'];
    readonly occasion: string;
    /** The element as the page named it (`button “Send”`), or the address opened. */
    readonly element?: string;
    readonly at: number;
  }): { readonly suggested: boolean };
  /** The open suggestions whose evidence still holds, newest first. */
  listSuggestions(now: number): BrowserPassSuggestionRow[];
  /** Mint the always pass an open suggestion names. */
  accept(key_hash: string, now: number): { pass: BrowserPassRow; suggestion: BrowserPassSuggestionRow };
  /** Never suggest this key again. */
  dismiss(key_hash: string, now: number): void;
  /** The live passes, newest first: every always pass, and the session passes not yet ended. */
  listPasses(now: number): BrowserPassRow[];
  /** End a pass. Ending an always pass ends its key's suggestions too. */
  revoke(pass_id: string, now: number): BrowserPassRow;
  /** D-341 slice A — the live request approved ahead in this conversation, or undefined. */
  requestPass(channel_session_id: string, now: number): BrowserRequestPass | undefined;
  /** Turn it on: a live one is kept as it is; otherwise one starts now, for eight hours. */
  startRequestPass(channel_session_id: string, now: number): BrowserRequestPass;
  /** Turn it off. False when none was live. */
  endRequestPass(channel_session_id: string, now: number): boolean;
  /** The live one, with one more use counted, or undefined (⇒ the write asks). */
  useRequestPass(channel_session_id: string, now: number): BrowserRequestPass | undefined;
}

interface KeyRow {
  key_hash: string;
  key_json: string;
  host: string;
  state: 'watching' | 'suggested' | 'accepted' | 'dismissed';
  suggested_at: number | null;
  updated_at: number;
}

interface PassRowDb {
  pass_id: string;
  key_hash: string;
  key_json: string;
  host: string;
  kind: BrowserPassKind;
  channel_session_id: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  uses: number;
  last_used_at: number | null;
}

export const ensureBrowserPassSchema = (db: Database.Database): void => {
  db.transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS browser_pass_answers (
      run_id    TEXT PRIMARY KEY,
      key_hash  TEXT NOT NULL,
      outcome   TEXT NOT NULL CHECK (outcome IN ('approved', 'refused')),
      occasion  TEXT NOT NULL,
      element   TEXT,
      at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_browser_pass_answers_key ON browser_pass_answers (key_hash, at);
    CREATE TABLE IF NOT EXISTS browser_pass_keys (
      key_hash      TEXT PRIMARY KEY,
      key_json      TEXT NOT NULL,
      host          TEXT NOT NULL,
      state         TEXT NOT NULL CHECK (state IN ('watching', 'suggested', 'accepted', 'dismissed')),
      suggested_at  INTEGER,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browser_passes (
      pass_id             TEXT PRIMARY KEY,
      key_hash            TEXT NOT NULL,
      key_json            TEXT NOT NULL,
      host                TEXT NOT NULL,
      kind                TEXT NOT NULL CHECK (kind IN ('session', 'always')),
      channel_session_id  TEXT,
      created_at          INTEGER NOT NULL,
      expires_at          INTEGER,
      revoked_at          INTEGER,
      uses                INTEGER NOT NULL DEFAULT 0,
      last_used_at        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_browser_passes_key ON browser_passes (key_hash, created_at);
    CREATE TABLE IF NOT EXISTS browser_request_passes (
      channel_session_id  TEXT PRIMARY KEY,
      generation_id       TEXT NOT NULL,
      started_at          INTEGER NOT NULL,
      expires_at          INTEGER NOT NULL,
      ended_at            INTEGER,
      uses                INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS browser_pass_decisions (
      approval_ref  TEXT PRIMARY KEY,
      offer_sha256  TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('session', 'always', 'request')),
      selection_ref TEXT NOT NULL
    );
    `);
    const columns = db.prepare('PRAGMA table_info(browser_request_passes)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'generation_id')) {
      db.exec('ALTER TABLE browser_request_passes ADD COLUMN generation_id TEXT');
    }
    // Give existing passes an identity without restarting them or changing their use counts.
    db.exec('UPDATE browser_request_passes SET generation_id = lower(hex(randomblob(16))) WHERE generation_id IS NULL');
  }).immediate();
};

/** A stored key, read defensively: a row this version cannot read names no key. */
const parseKey = (json: string): BrowserPassKey | undefined => {
  try {
    const value = JSON.parse(json) as BrowserPassKey;
    const principal = value?.principal as { kind?: unknown; contract_id?: unknown } | undefined;
    const principalOk = principal?.kind === 'owner_chat'
      || (principal?.kind === 'ai_app' && typeof principal.contract_id === 'string' && principal.contract_id.length > 0);
    // D-402 slice H4c — a browser, when the key names one, is a lasting id.
    const browserOk = value.browser === undefined || (typeof value.browser === 'string' && value.browser.length > 0);
    return principalOk && browserOk && typeof value.recipe === 'string' && value.recipe.length > 0
      && typeof value.site === 'string' && value.site.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

const toPass = (row: PassRowDb): BrowserPassRow | undefined => {
  const key = parseKey(row.key_json);
  return key === undefined ? undefined : {
    pass_id: row.pass_id,
    key_hash: row.key_hash,
    key,
    host: row.host,
    kind: row.kind,
    ...(row.channel_session_id !== null ? { channel_session_id: row.channel_session_id } : {}),
    created_at: row.created_at,
    ...(row.expires_at !== null ? { expires_at: row.expires_at } : {}),
    ...(row.revoked_at !== null ? { revoked_at: row.revoked_at } : {}),
    uses: row.uses,
    ...(row.last_used_at !== null ? { last_used_at: row.last_used_at } : {}),
  };
};

export const createBrowserPassStore = (
  db: Database.Database,
  options: { readonly newId?: () => string } = {},
): BrowserPassStore => {
  ensureBrowserPassSchema(db);
  const newId = options.newId ?? randomUUID;
  const insertAnswer = db.prepare(`INSERT OR IGNORE INTO browser_pass_answers
    (run_id, key_hash, outcome, occasion, element, at) VALUES (@run_id, @key_hash, @outcome, @occasion, @element, @at)`);
  const answersFor = db.prepare('SELECT outcome, occasion, at FROM browser_pass_answers WHERE key_hash = ?');
  const approvedElementsFor = db.prepare(`SELECT element FROM browser_pass_answers
    WHERE key_hash = @key_hash AND outcome = 'approved' AND at >= @since AND at <= @now AND element IS NOT NULL
    ORDER BY at DESC`);
  const insertKey = db.prepare(`INSERT INTO browser_pass_keys (key_hash, key_json, host, state, suggested_at, updated_at)
    VALUES (@key_hash, @key_json, @host, 'watching', NULL, @at) ON CONFLICT(key_hash) DO NOTHING`);
  const keyRow = db.prepare('SELECT * FROM browser_pass_keys WHERE key_hash = ?');
  const setState = db.prepare(`UPDATE browser_pass_keys SET state = @state, updated_at = @at,
    suggested_at = CASE WHEN @state = 'suggested' THEN @at ELSE suggested_at END WHERE key_hash = @key_hash`);
  const suggestedKeys = db.prepare(`SELECT * FROM browser_pass_keys WHERE state = 'suggested'
    ORDER BY suggested_at DESC, key_hash`);
  const liveAlwaysFor = db.prepare(`SELECT * FROM browser_passes WHERE key_hash = ? AND kind = 'always'
    AND revoked_at IS NULL ORDER BY created_at DESC, pass_id LIMIT 1`);
  const liveSessionFor = db.prepare(`SELECT * FROM browser_passes WHERE key_hash = @key_hash AND kind = 'session'
    AND channel_session_id = @channel_session_id AND revoked_at IS NULL AND expires_at > @now
    ORDER BY created_at DESC, pass_id LIMIT 1`);
  const insertPass = db.prepare(`INSERT INTO browser_passes
    (pass_id, key_hash, key_json, host, kind, channel_session_id, created_at, expires_at, revoked_at, uses, last_used_at)
    VALUES (@pass_id, @key_hash, @key_json, @host, @kind, @channel_session_id, @created_at, @expires_at, NULL, 0, NULL)`);
  const passRow = db.prepare('SELECT * FROM browser_passes WHERE pass_id = ?');
  const livePasses = db.prepare(`SELECT * FROM browser_passes WHERE revoked_at IS NULL
    AND (kind = 'always' OR expires_at > ?) ORDER BY created_at DESC, pass_id`);
  const revokePass = db.prepare('UPDATE browser_passes SET revoked_at = @at WHERE pass_id = @pass_id AND revoked_at IS NULL');
  const countUse = db.prepare('UPDATE browser_passes SET uses = uses + 1, last_used_at = @at WHERE pass_id = @pass_id');

  const evidenceFor = (key_hash: string, now: number) =>
    evaluateWriteRuleEvidence(answersFor.all(key_hash) as WriteRuleAnswer[], now);

  const suggestionOf = (row: KeyRow, now: number): BrowserPassSuggestionRow | undefined => {
    const key = parseKey(row.key_json);
    if (key === undefined || row.suggested_at === null) return undefined;
    const evidence = evidenceFor(row.key_hash, now);
    if (!evidence.suggest) return undefined;
    const elements: string[] = [];
    for (const { element } of approvedElementsFor.all({
      key_hash: row.key_hash, since: now - WRITE_RULE_LOOKBACK_MS, now,
    }) as Array<{ element: string }>) {
      if (!elements.includes(element)) elements.push(element);
      if (elements.length >= SUGGESTION_ELEMENTS_MAX) break;
    }
    return {
      key_hash: row.key_hash, key, host: row.host, approvals: evidence.approvals,
      occasions: evidence.occasions, elements, suggested_at: row.suggested_at,
    };
  };

  const use: BrowserPassStore['use'] = db.transaction((key: BrowserPassKey, channel_session_id: string | undefined, now: number) => {
    const key_hash = browserPassKeyHash(key);
    const live = (liveAlwaysFor.get(key_hash)
      ?? (channel_session_id === undefined ? undefined
        : liveSessionFor.get({ key_hash, channel_session_id, now }))) as PassRowDb | undefined;
    if (live === undefined) return undefined;
    const pass = toPass(live);
    if (pass === undefined || !isBrowserPassLive(pass, now, channel_session_id)) return undefined;
    countUse.run({ pass_id: live.pass_id, at: now });
    return toPass(passRow.get(live.pass_id) as PassRowDb);
  }) as BrowserPassStore['use'];

  const mint: BrowserPassStore['mint'] = db.transaction((input: Parameters<BrowserPassStore['mint']>[0]) => {
    const key_hash = browserPassKeyHash(input.key);
    const key_json = JSON.stringify(input.key);
    insertKey.run({ key_hash, key_json, host: input.host, at: input.now });
    if (input.kind === 'always') {
      const live = liveAlwaysFor.get(key_hash) as PassRowDb | undefined;
      setState.run({ key_hash, state: 'accepted', at: input.now });
      if (live !== undefined) return toPass(live)!;
    } else {
      if (input.channel_session_id === undefined) {
        throw new BrowserPassError('bad_request', 'a session pass needs its conversation');
      }
      const live = liveSessionFor.get({ key_hash, channel_session_id: input.channel_session_id, now: input.now }) as PassRowDb | undefined;
      if (live !== undefined) return toPass(live)!;
    }
    const pass_id = newId();
    insertPass.run({
      pass_id, key_hash, key_json, host: input.host, kind: input.kind,
      channel_session_id: input.kind === 'session' ? input.channel_session_id! : null,
      created_at: input.now,
      expires_at: input.kind === 'session' ? input.now + BROWSER_PASS_SESSION_TTL_MS : null,
    });
    return toPass(passRow.get(pass_id) as PassRowDb)!;
  }) as BrowserPassStore['mint'];

  const recordAnswer: BrowserPassStore['recordAnswer'] = db.transaction((input: Parameters<BrowserPassStore['recordAnswer']>[0]) => {
    const key_hash = browserPassKeyHash(input.key);
    // Once per run: an answer told twice keeps its first row.
    insertAnswer.run({
      run_id: input.run_id, key_hash, outcome: input.outcome, occasion: input.occasion,
      element: input.element !== undefined && input.element.length > 0 ? input.element.slice(0, 200) : null,
      at: input.at,
    });
    insertKey.run({ key_hash, key_json: JSON.stringify(input.key), host: input.host, at: input.at });
    const row = keyRow.get(key_hash) as KeyRow;
    if (row.state === 'dismissed') return { suggested: false };
    // A live always pass raises no asks, so an answer here was asked before it: it teaches nothing.
    if (row.state === 'accepted' && liveAlwaysFor.get(key_hash) !== undefined) return { suggested: false };
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
  }) as BrowserPassStore['recordAnswer'];

  const listSuggestions: BrowserPassStore['listSuggestions'] = (now) =>
    (suggestedKeys.all() as KeyRow[])
      .map((row) => suggestionOf(row, now))
      .filter((row): row is BrowserPassSuggestionRow => row !== undefined);

  const accept: BrowserPassStore['accept'] = db.transaction((key_hash: string, now: number) => {
    const row = keyRow.get(key_hash) as KeyRow | undefined;
    if (row === undefined) throw new BrowserPassError('not_found', `no browser pass suggestion '${key_hash}'`);
    const live = liveAlwaysFor.get(key_hash) as PassRowDb | undefined;
    if (row.state === 'accepted' && live !== undefined) {
      // A retry of an accept that landed: the pass it minted, not a twin.
      const key = parseKey(row.key_json)!;
      return {
        pass: toPass(live)!,
        suggestion: { key_hash, key, host: row.host, approvals: 0, occasions: 0, elements: [], suggested_at: row.suggested_at ?? now },
      };
    }
    if (row.state === 'dismissed') {
      throw new BrowserPassError('bad_request', `the browser pass suggestion '${key_hash}' was dismissed for good`);
    }
    const suggestion = row.state === 'suggested' ? suggestionOf(row, now) : undefined;
    if (suggestion === undefined) throw new BrowserPassError('bad_request', `no open browser pass suggestion '${key_hash}'`);
    const pass = mint({ key: suggestion.key, host: row.host, kind: 'always', now });
    return { pass, suggestion };
  }) as BrowserPassStore['accept'];

  const dismiss: BrowserPassStore['dismiss'] = (key_hash, now) => {
    const row = keyRow.get(key_hash) as KeyRow | undefined;
    if (row === undefined) throw new BrowserPassError('not_found', `no browser pass suggestion '${key_hash}'`);
    if (row.state === 'dismissed') return;
    if (row.state === 'accepted' && liveAlwaysFor.get(key_hash) !== undefined) {
      throw new BrowserPassError('bad_request', `the suggestion '${key_hash}' is a pass now: end the pass instead`);
    }
    setState.run({ key_hash, state: 'dismissed', at: now });
  };

  const listPasses: BrowserPassStore['listPasses'] = (now) =>
    (livePasses.all(now) as PassRowDb[])
      .map(toPass)
      .filter((pass): pass is BrowserPassRow => pass !== undefined);

  const revoke: BrowserPassStore['revoke'] = db.transaction((pass_id: string, now: number) => {
    const before = passRow.get(pass_id) as PassRowDb | undefined;
    if (before === undefined) throw new BrowserPassError('not_found', `no browser pass '${pass_id}'`);
    revokePass.run({ pass_id, at: now });
    if (before.kind === 'always') setState.run({ key_hash: before.key_hash, state: 'dismissed', at: now });
    return toPass(passRow.get(pass_id) as PassRowDb)!;
  }) as BrowserPassStore['revoke'];

  // D-341 slice A — the requests approved ahead, one a conversation.
  const requestRow = db.prepare(`SELECT channel_session_id, started_at, expires_at, uses FROM browser_request_passes
    WHERE channel_session_id = @channel_session_id AND ended_at IS NULL AND expires_at > @now`);
  const startRequest = db.prepare(`INSERT INTO browser_request_passes (channel_session_id, generation_id, started_at, expires_at, ended_at, uses)
    VALUES (@channel_session_id, @generation_id, @now, @expires_at, NULL, 0)
    ON CONFLICT(channel_session_id) DO UPDATE SET started_at = excluded.started_at, expires_at = excluded.expires_at,
      generation_id = excluded.generation_id, ended_at = NULL, uses = 0`);
  const endRequest = db.prepare(`UPDATE browser_request_passes SET ended_at = @now
    WHERE channel_session_id = @channel_session_id AND ended_at IS NULL AND expires_at > @now`);
  const countRequest = db.prepare(`UPDATE browser_request_passes SET uses = uses + 1
    WHERE channel_session_id = @channel_session_id AND ended_at IS NULL AND expires_at > @now`);
  const requestPass = (channel_session_id: string, now: number): BrowserRequestPass | undefined =>
    requestRow.get({ channel_session_id, now }) as BrowserRequestPass | undefined;
  const startRequestPass = db.transaction((channel_session_id: string, now: number): BrowserRequestPass => {
    const live = requestPass(channel_session_id, now);
    if (live !== undefined) return live;
    startRequest.run({ channel_session_id, generation_id: randomUUID(), now, expires_at: now + BROWSER_REQUEST_PASS_TTL_MS });
    return requestPass(channel_session_id, now)!;
  }) as BrowserPassStore['startRequestPass'];
  const endRequestPass = (channel_session_id: string, now: number): boolean =>
    endRequest.run({ channel_session_id, now }).changes > 0;
  const useRequestPass = db.transaction((channel_session_id: string, now: number): BrowserRequestPass | undefined =>
    countRequest.run({ channel_session_id, now }).changes > 0 ? requestPass(channel_session_id, now) : undefined,
  ) as BrowserPassStore['useRequestPass'];

  const grantForDecision = db.transaction((input: BrowserPassApprovalInput): void => {
    const offer = readBrowserPassOffer(input.offer);
    if (typeof input.approval_ref !== 'string' || !input.approval_ref || offer === undefined
      || !['session', 'always', 'request'].includes(input.kind)
      || (input.kind === 'request' && !browserPassOffersRequest(offer))) {
      throw new BrowserPassError('bad_request', 'invalid browser pass approval');
    }
    const offer_sha256 = createHash('sha256').update(JSON.stringify([
      browserPassKeyHash(offer.key), offer.host, offer.channel_session_id, input.kind,
    ])).digest('hex');
    const prior = db.prepare('SELECT offer_sha256 FROM browser_pass_decisions WHERE approval_ref = ?')
      .get(input.approval_ref) as { offer_sha256: string } | undefined;
    if (prior !== undefined) {
      if (prior.offer_sha256 !== offer_sha256) {
        throw new BrowserPassError('bad_request', 'browser pass approval identity was reused with a different offer or choice');
      }
      // The original selection can be revoked, expired, or missing. A newer request
      // generation can have replaced it too. None of these is a fresh approval.
      return;
    }
    let selection_ref: string;
    if (input.kind === 'request') {
      startRequestPass(offer.channel_session_id, input.now);
      selection_ref = (db.prepare('SELECT generation_id FROM browser_request_passes WHERE channel_session_id = ?')
        .get(offer.channel_session_id) as { generation_id: string }).generation_id;
    } else {
      selection_ref = mint({ ...offer, kind: input.kind, now: input.now }).pass_id;
    }
    db.prepare('INSERT INTO browser_pass_decisions (approval_ref, offer_sha256, kind, selection_ref) VALUES (?, ?, ?, ?)')
      .run(input.approval_ref, offer_sha256, input.kind, selection_ref);
  });

  return { use, mint, grantForDecision: input => grantForDecision.immediate(input),
    recordAnswer, listSuggestions, accept, dismiss, listPasses, revoke,
    requestPass, startRequestPass, endRequestPass, useRequestPass };
};
