/** The server-scoped rolling-brief enable — the path that makes the feature
 *  shippable at all.
 *
 *  ⛔⛔ WHAT THIS REPLACED, AND WHY IT WAS A BLOCKER RATHER THAN A GAP. The
 *  brief was gated by `process.env['BENCH_ROLLING_BRIEF'] === '1'` read INLINE
 *  at five separate sites inside `runChatTurn`. An env read inside the engine
 *  is reachable by no owner-facing surface, so there was no way to turn the
 *  brief on in production — the gate, not the behaviour, was what kept a
 *  measured-useful feature bench-only.
 *
 *  🔑 SERVER-SCOPED, NOT PER-PAIR, AND THAT IS FORCED. `runChatTurn` is keyed
 *  on `session_id` and holds NO peer identity: turns arrive over MCP and the
 *  D-148 P9 inbound channels with no paired client at all. A `prefs`-style
 *  per-pair knob would have no defined value to read on exactly those turns.
 *
 *  ⚠ The fail-closed read is the property worth pinning. A malformed or legacy
 *  stored value must read FALSE — reading it as enabled would start carrying
 *  conversation context across turns on a server whose owner never asked for
 *  it, which is the wrong direction to fail in. */

import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';
import { deriveSubDEK } from '@recued/crypto';

import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';
import {
  handleGetSessionBrief,
  handleClearSessionBrief,
} from '../chat-handler.js';
import {
  appendUnfoldedUserMessage,
  clearIngestedUserMessages,
  clearUnfoldedUserMessages,
  oldestPendingStatementAge,
  peekUnfoldedUserMessages,
  __clearUnfoldedUserMessages,
} from '../chat-rolling-brief.js';

let db: Database.Database;
let store: ChatStore;

const fixedMaster = (b: number) => Buffer.alloc(32, b);
// ⚠ The domain is a plain string, not an object. The object form typechecked
//   nowhere and only survived here because this file never DECRYPTS anything —
//   a wrong key is unobservable when no ciphertext is read back, so vitest was
//   green and `typecheck:tests` was the gate that caught it.
const chatKey = (master: Buffer): Uint8Array => deriveSubDEK(master, 'chat');

beforeEach(() => {
  db = new Database(':memory:');
  ensureChatSchema(db);
  const key = chatKey(fixedMaster(1));
  store = createChatStore(db, () => key, () => undefined);
});

describe('rolling-brief enable — server-scoped chat_config', () => {
  it('defaults ON on a fresh server', () => {
    // ⛔ THE DEFAULT MOVED, AND THE ARGUMENT IS ARITHMETIC, NOT STATISTICAL.
    // `CHAT_TAIL_LIMIT` is a fixed 3 ROWS, so by turn 5 anything the user said
    // that no tool can re-derive is simply absent from the packet. The brief is
    // the only thing that carries it, and it is ~token-neutral (folds cost
    // 11-14% of input and recover about as much by shrinking main turns).
    expect(store.getRollingBriefEnabled()).toBe(true);
  });

  it('round-trips on and off', () => {
    expect(store.setRollingBriefEnabled(true)).toBe(true);
    expect(store.getRollingBriefEnabled()).toBe(true);
    store.setRollingBriefEnabled(false);
    expect(store.getRollingBriefEnabled()).toBe(false);
  });

  it('survives a reopen of the same database', () => {
    store.setRollingBriefEnabled(true);
    const reopened = createChatStore(
      db,
      () => chatKey(fixedMaster(1)),
      () => undefined,
    );
    expect(reopened.getRollingBriefEnabled()).toBe(true);
  });

  /** ⛔ ONLY THE LITERAL '0' DISABLES — the same convention as
   *  `RECUED_CHAT_CATALOG_SMART_DEFAULTS`. Driven by writing the row directly
   *  rather than through the setter, because the setter can only ever produce
   *  '1' or '0'; the values that matter here are the ones a LEGACY row or a
   *  corrupt blob would hold, and only a raw write can produce them.
   *
   *  🔑 THE SAFE DIRECTION INVERTED WITH THE DEFAULT. A corrupt row that
   *  silently DISABLED the brief would restore the exact information loss it
   *  exists to prevent, while every surface still reported it as on. */
  it.each([
    ['true', 'the JSON-ish spelling a future writer might use'],
    ['yes', 'a human-entered value'],
    ['', 'an empty string'],
    ['2', 'an out-of-range number'],
    ['{"enabled":true}', 'a JSON blob from a different schema'],
  ])('reads a malformed value %s as ON (%s)', (value) => {
    db.prepare(
      `INSERT OR REPLACE INTO chat_config (key, value) VALUES (?, ?)`,
    ).run('rolling_brief_enabled', value);
    expect(store.getRollingBriefEnabled()).toBe(true);
  });

  it('the literal \'0\' is the ONLY thing that disables it', () => {
    db.prepare(
      `INSERT OR REPLACE INTO chat_config (key, value) VALUES (?, ?)`,
    ).run('rolling_brief_enabled', '0');
    expect(store.getRollingBriefEnabled()).toBe(false);
  });

  it('is independent of the chat-model default in the same table', () => {
    // Both live in `chat_config`; a write to one must not disturb the other.
    store.setRollingBriefEnabled(true);
    store.setDefaultModelSourceId('free_pool');
    expect(store.getRollingBriefEnabled()).toBe(true);
    expect(store.getDefaultModelSourceId().source_id).toBe('free_pool');
  });
});

/** ⛔⛔ THE BACKLOG'S PER-SERVER BOUND. `SESSION_BRIEFS` caps itself at 32
 *  sessions with the reason written out — "so a long-lived server cannot
 *  accumulate briefs for every session it has ever seen" — and the unfolded-
 *  statement pen beside it had no such cap: it bounded a session's CONTENT
 *  (12 messages / 4 KB) and never the NUMBER of sessions. Since the pen clears
 *  only on a SUCCESSFUL fold, every session that ended without one left up to
 *  4 KB resident until the process bounced. Surfaced by the owner asking the
 *  right question: does this ever get cleared, or does it accumulate? */
describe('unfolded-statement backlog — bounded per server', () => {
  beforeEach(() => { __clearUnfoldedUserMessages(); });

  it('keeps a session\'s statements until a fold clears them', () => {
    appendUnfoldedUserMessage('s1', 'the levy is 318 units');
    expect(peekUnfoldedUserMessages('s1')).toEqual(['the levy is 318 units']);
    clearUnfoldedUserMessages('s1');
    expect(peekUnfoldedUserMessages('s1')).toEqual([]);
  });

  it('does not accumulate one entry per session for ever', () => {
    // 200 sessions that each state something and never fold.
    for (let i = 0; i < 200; i += 1) {
      appendUnfoldedUserMessage(`s${String(i)}`, `statement ${String(i)}`);
    }
    // The newest session is still held…
    expect(peekUnfoldedUserMessages('s199')).toEqual(['statement 199']);
    // …and the oldest have been evicted rather than kept for the process's life.
    expect(peekUnfoldedUserMessages('s0')).toEqual([]);
  });

  it('clearing a session drops its age counter too, not just its messages', () => {
    // The seq counter was never cleared in production — only by the test
    // helper — so it grew one entry per session seen, for ever.
    appendUnfoldedUserMessage('s2', 'first');
    appendUnfoldedUserMessage('s2', 'second');
    expect(oldestPendingStatementAge('s2')).toBe(1);
    clearUnfoldedUserMessages('s2');
    appendUnfoldedUserMessage('s2', 'fresh');
    // A restarted counter beside an empty list must read as age 0, not as the
    // stale distance from the pre-clear sequence.
    expect(oldestPendingStatementAge('s2')).toBe(0);
  });
});

/** ⛔⛔ THE BRIEF MUST SURVIVE A PROCESS BOUNCE. It lived in a module-level
 *  `Map` whose own note called it "experiment scaffolding … not durable … does
 *  not survive a restart. A shipped version belongs in the chat store beside
 *  the turn it describes — the constraint a brief protects is exactly the kind
 *  of thing that must not evaporate on a process bounce."
 *
 *  🔑 REMOVING THE FLAG MADE THAT PRECONDITION BINDING. The feature now ships
 *  ON by default, so a supervisor respawn or an applied update would have
 *  dropped every `constraints` entry — the one class nothing can re-derive
 *  ("a tool can re-derive a ring cost; nothing can re-derive what the user
 *  said"). The restart is simulated the only way that proves anything: a NEW
 *  store over the SAME database file, which is what a respawn actually is. */
describe('rolling brief durability — survives a restart', () => {
  const BRIEF = JSON.stringify({
    intent: 'price the Meridian job',
    constraints: ['Bonded-warehouse levy is 318 units — verbal, in no block'],
    findings: [], pending: [], completed: [],
  });

  it('round-trips through a NEW store over the same database', async () => {
    const key = chatKey(fixedMaster(1));
    const first = createChatStore(db, () => key, () => undefined);
    first.createSession({ id: 's1', now: 1000 });
    await first.writeSessionBrief('s1', BRIEF);
    // The bounce: a fresh store, same file, same key — no in-process state.
    const afterRestart = createChatStore(db, () => chatKey(fixedMaster(1)), () => undefined);
    expect(await afterRestart.readSessionBrief('s1')).toBe(BRIEF);
  });

  it('is stored ENCRYPTED, not as readable text', async () => {
    const key = chatKey(fixedMaster(1));
    const store = createChatStore(db, () => key, () => undefined);
    store.createSession({ id: 's2', now: 1000 });
    await store.writeSessionBrief('s2', BRIEF);
    const row = db.prepare('SELECT brief_encrypted FROM chat_briefs WHERE session_id = ?')
      .get('s2') as { brief_encrypted: string };
    // A brief holds the owner's own words; the ciphertext must not carry them.
    expect(row.brief_encrypted).not.toContain('318');
    expect(row.brief_encrypted).not.toContain('Meridian');
  });

  /** ⛔ A blob is bound to its session by AAD. Lifting one into another session
   *  must FAIL TO DECODE rather than decrypt under the wrong conversation. */
  it('refuses a blob moved to another session, reading as absent', async () => {
    const key = chatKey(fixedMaster(1));
    const store = createChatStore(db, () => key, () => undefined);
    store.createSession({ id: 's3', now: 1000 });
    store.createSession({ id: 's4', now: 1000 });
    await store.writeSessionBrief('s3', BRIEF);
    const row = db.prepare('SELECT brief_encrypted FROM chat_briefs WHERE session_id = ?')
      .get('s3') as { brief_encrypted: string };
    db.prepare('INSERT OR REPLACE INTO chat_briefs (session_id, brief_encrypted, updated_at) VALUES (?,?,?)')
      .run('s4', row.brief_encrypted, 1);
    // ⛔ null, NOT a throw: an unreadable carry degrades to "run unbriefed",
    //   which is the documented fallback — failing the turn would be worse.
    expect(await store.readSessionBrief('s4')).toBeNull();
  });

  it('a corrupt row reads as absent rather than throwing', async () => {
    const store = createChatStore(db, () => chatKey(fixedMaster(1)), () => undefined);
    store.createSession({ id: 's5', now: 1000 });
    db.prepare('INSERT OR REPLACE INTO chat_briefs (session_id, brief_encrypted, updated_at) VALUES (?,?,?)')
      .run('s5', 'not-ciphertext-at-all', 1);
    expect(await store.readSessionBrief('s5')).toBeNull();
  });

  it('deleting the session takes its brief with it', async () => {
    const store = createChatStore(db, () => chatKey(fixedMaster(1)), () => undefined);
    store.createSession({ id: 's6', now: 1000 });
    await store.writeSessionBrief('s6', BRIEF);
    store.deleteSession('s6');
    expect(await store.readSessionBrief('s6')).toBeNull();
  });
});

/** ⛔⛔ THE PROMOTION GUARANTEE. The backlog used to be cleared wholesale on ANY
 *  successful fold, which conflates "a brief was produced" with "this statement
 *  is in it". Measured failure — bench 377, 40 turns: the fourth user-stated
 *  charge was captured verbatim by the pen, never promoted into `constraints`,
 *  and cleared anyway. The turn answered correctly only because recall happened
 *  to find the value in an earlier assistant message.
 *
 *  🔑 THE PEN IS THE ONLY UNMEDIATED COPY of what the owner said —
 *  `appendUnfoldedUserMessage` takes the raw `user_message` with no model in
 *  the loop — while `constraints` is the model's INTERPRETATION (measured: 10%
 *  of entries are exact substrings of a user message, 66% near-copies, 25%
 *  reworded). Discarding the verbatim copy on the model's say-so is the wrong
 *  direction for the one class nothing can re-derive. */
describe('backlog promotion guarantee', () => {
  beforeEach(() => { __clearUnfoldedUserMessages(); });
  const brief = (constraints: string[]): never =>
    ({ intent: 'price the job', constraints, findings: [], pending: [], completed: [] }) as never;

  it('clears a statement the fold DID carry', () => {
    appendUnfoldedUserMessage('p1', 'the bonded-warehouse levy is 318 units');
    const out = clearIngestedUserMessages('p1', brief(['Bonded-warehouse levy is 318 units.']));
    expect(out.retained).toEqual([]);
    expect(peekUnfoldedUserMessages('p1')).toEqual([]);
  });

  /** The 40-turn failure, reduced: stated, not promoted, previously discarded. */
  it('RETAINS a statement whose figure the brief does not carry', () => {
    appendUnfoldedUserMessage('p2', 'the quarterly rig surcharge is 226 units');
    const out = clearIngestedUserMessages('p2', brief(['Levy is 318 units.']));
    expect(out.retained).toHaveLength(1);
    // Re-offered to the next fold, which is the recovery: another chance to
    // promote rather than one attempt.
    expect(peekUnfoldedUserMessages('p2')).toEqual(['the quarterly rig surcharge is 226 units']);
  });

  it('counts a figure carried in findings as promoted, not just constraints', () => {
    // A value the fold recorded anywhere in the brief is carried; retaining it
    // would keep a statement the brief already holds.
    appendUnfoldedUserMessage('p3', 'ring 04 came to 689 units');
    const b = { intent: 'x', constraints: [], findings: ['Ring 04 checkpoint cost: 689 units'],
      pending: [], completed: [] } as never;
    expect(clearIngestedUserMessages('p3', b).retained).toEqual([]);
  });

  it('does not jam the pen open on ordinals — the reason the threshold is 3 digits', () => {
    // `blocks 05 and 06` appears in almost every turn and is never durable. A
    // rule that retained it would carry conversational chatter for ever.
    appendUnfoldedUserMessage('p4', 'read blocks 05 and 06, same question');
    expect(clearIngestedUserMessages('p4', brief([])).retained).toEqual([]);
  });

  it('keeps only the unpromoted ones out of a mixed backlog', () => {
    appendUnfoldedUserMessage('p5', 'the levy is 318 units');
    appendUnfoldedUserMessage('p5', 'now read blocks 03 and 04');
    appendUnfoldedUserMessage('p5', 'the retainer is 274 units');
    const out = clearIngestedUserMessages('p5', brief(['Levy is 318 units.']));
    expect(out.retained).toEqual(['the retainer is 274 units']);
    expect(out.cleared).toBe(2);
  });

  it('an empty pen is a no-op', () => {
    expect(clearIngestedUserMessages('p6', brief([]))).toEqual({ cleared: 0, retained: [] });
  });
});

/** ⛔ THE OWNER-FACING READ OF THE CARRY. The brief steered every turn and only
 *  its fold TRAIL ever reached the owner. These drive the real handlers against
 *  a real store, because the property is what the OWNER can see and undo. */
describe('chat.session.brief.get / .clear', () => {
  const BRIEF = JSON.stringify({
    intent: 'price the Meridian job',
    constraints: ['Bonded-warehouse levy is 318 units'],
    findings: [], pending: [], completed: [],
  });

  const deps = (store: ChatStore) => ({ store, auditLog: undefined }) as never;

  it('returns null when nothing is carried', async () => {
    const store = createChatStore(db, () => chatKey(fixedMaster(1)), () => undefined);
    store.createSession({ id: 'g1', now: 1000 });
    expect(await handleGetSessionBrief(deps(store), { session_id: 'g1' }))
      .toEqual({ brief: null });
  });

  it('returns the carry the fold stored', async () => {
    const store = createChatStore(db, () => chatKey(fixedMaster(1)), () => undefined);
    store.createSession({ id: 'g2', now: 1000 });
    await store.writeSessionBrief('g2', BRIEF);
    const out = await handleGetSessionBrief(deps(store), { session_id: 'g2' });
    expect((out.brief as { constraints: string[] }).constraints)
      .toEqual(['Bonded-warehouse levy is 318 units']);
  });

  /** ⛔ VALIDATED BEFORE IT LEAVES THE SERVER — a row that no longer parses
   *  reads as ABSENT rather than shipping an unknown shape to a client that
   *  would have to guess at it. */
  it('a stored row that is not a brief reads as absent', async () => {
    const store = createChatStore(db, () => chatKey(fixedMaster(1)), () => undefined);
    store.createSession({ id: 'g3', now: 1000 });
    await store.writeSessionBrief('g3', '{"not":"a brief"}');
    expect(await handleGetSessionBrief(deps(store), { session_id: 'g3' }))
      .toEqual({ brief: null });
  });

  it('clear drops the carry — the reversible half', async () => {
    const store = createChatStore(db, () => chatKey(fixedMaster(1)), () => undefined);
    store.createSession({ id: 'g4', now: 1000 });
    await store.writeSessionBrief('g4', BRIEF);
    handleClearSessionBrief(deps(store), { session_id: 'g4' });
    expect(await handleGetSessionBrief(deps(store), { session_id: 'g4' }))
      .toEqual({ brief: null });
  });

  it('rejects a missing session_id rather than reading someone else\'s', async () => {
    const store = createChatStore(db, () => chatKey(fixedMaster(1)), () => undefined);
    await expect(handleGetSessionBrief(deps(store), {} as never)).rejects.toThrow(/session_id/);
    expect(() => handleClearSessionBrief(deps(store), {} as never)).toThrow(/session_id/);
  });
});
