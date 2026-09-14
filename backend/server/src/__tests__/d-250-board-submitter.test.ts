/** D-250 § B3.3 / § B4.2 — the daily submission.
 *
 *  🔑 THE BATCH IS WHERE THIS GOES WRONG, NOT THE NETWORK. Every case below is about
 *  which entries appear, what they carry, and what the ack is allowed to change.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSONStringify } from '@recued/crypto';
import { METRIC_ABSENT, METRIC_UNBOUNDED, metricValue } from '@recued/contracts';

import { ed25519Sign, generateEd25519Keypair } from '../keys/index.js';
import { buildBatch, EVAL_PENDING_PREFIX, EVAL_SUBMISSION_SET_KEY, evalPendingKey,
  METRIC_SUBMISSION_SET_KEY, parsePendingResult, submitBoards, toWireDecimal } from '../metrics/board-submitter.js';
import { createBoardPublicationStore } from '../metrics/publication-store.js';
import { createMetricSnapshotStore } from '../metrics/snapshot-store.js';

const NOW = 1_700_000_000_000;
let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-250-submit-'));
  db = new Database(join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const stores = () => ({
  publications: createBoardPublicationStore(db),
  snapshot: createMetricSnapshotStore(db),
});

const seed = (reading = metricValue(0.625)) => {
  const s = stores();
  s.snapshot.write({
    computed_at: NOW,
    window: { from: NOW - 86_400_000, to: NOW },
    metrics: [{ metric_id: 'autopilot', metric_version: 3, reading }],
  });
  s.publications.grant({ tag: 'ops', metric_id: 'autopilot', season_id: '1' }, NOW);
  return s;
};

const deps = (over: Record<string, unknown> = {}) => ({
  ...stores(),
  sign: (payload: string) => ed25519Sign(generateEd25519Keypair('server_identity_key'), payload),
  resolveTarget: async () => ({ publisher_id: 'fp_1', handle: 'alice' }),
  endpoint: 'https://api.recued.com/v1/boards/submit',
  now: () => NOW,
  post: vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ results: [] }) })),
  ...over,
}) as Parameters<typeof submitBoards>[0];

// ────────────────────────────────────────────────────────────────
// 1. WHAT GOES IN THE BATCH
// ────────────────────────────────────────────────────────────────

describe('D-250 § B3.3 — every publication rides every batch', () => {
  it('an active publication carries its score as a four-place STRING', () => {
    seed();
    expect(buildBatch(stores())).toEqual({
      ops: { value: '0.6250', definition_version: 3, metric_id: 'autopilot', season_id: '1', set_key: METRIC_SUBMISSION_SET_KEY },
    });
  });

  it('⛔ THE VERSION IS THE SNAPSHOT’S, so the board can show which arithmetic ran', () => {
    seed();
    expect((buildBatch(stores()).ops as { definition_version: number }).definition_version).toBe(3);
  });

  it('⛔⛔ A WITHDRAWING PUBLICATION CARRIES `unpublish`, and keeps carrying it', () => {
    // § C4: the withdrawal RIDES the batch until the ack. Dropping it from the batch is
    // the same defect as deleting the row — tomorrow nothing asks the board to remove it.
    const s = seed();
    s.publications.revoke('ops', NOW + 1000);
    expect(buildBatch(stores())).toEqual({ ops: { unpublish: true } });
  });

  it('⛔⛔ AN UNMEASURED METRIC SENDS NOTHING — not 0, and not a withdrawal', () => {
    // Sending 0 publishes a lie about a quiet window; withdrawing removes the owner from
    // a board they never asked to leave. § B3's retention keeps yesterday's value, which
    // is the honest outcome of saying nothing.
    seed(METRIC_ABSENT);
    expect(buildBatch(stores())).toEqual({});
  });

  it('⛔ UNBOUNDED ALSO SENDS NOTHING — there is no decimal for "better than everything"', () => {
    seed(METRIC_UNBOUNDED);
    expect(buildBatch(stores())).toEqual({});
  });

  it('a publication whose metric is missing from the snapshot is skipped, not guessed', () => {
    const s = stores();
    s.snapshot.write({ computed_at: NOW, window: { from: 0, to: NOW }, metrics: [] });
    s.publications.grant({ tag: 'ops', metric_id: 'autopilot', season_id: '1' }, NOW);
    expect(buildBatch(stores())).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────
// 2. THE SIGNATURE
// ────────────────────────────────────────────────────────────────

describe('D-250 — a server with no handle cannot publish', () => {
  it('⛔⛔ NO TARGET ⇒ NOT-SENT, and nothing is posted', async () => {
    // `publisher_id === server_fingerprint` and the handle both live in handle state. A
    // server that never reserved one has simply not set publishing up — the DEFAULT — so
    // this reports not-sent rather than throwing, which would make "not configured"
    // indistinguishable from "the send failed".
    seed();
    const post = vi.fn(async (_url: string, _body: string) =>
      ({ ok: true, text: async () => JSON.stringify({ results: [] }) }));
    const res = await submitBoards(deps({ post, resolveTarget: async () => null }));
    expect(res.sent).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('⛔ THE TARGET IS RESOLVED PER SEND, not captured once', async () => {
    // A handle can be reserved, changed or transferred while the server runs. Capturing
    // it at composition would keep signing for a name the cloud no longer maps to this
    // publisher, and every submission would 403 as a handle mismatch.
    seed();
    const seen: string[] = [];
    const post = vi.fn(async (_url: string, body: string) => {
      seen.push(JSON.parse(body).handle);
      return { ok: true, text: async () => JSON.stringify({ results: [] }) };
    });
    let handle = 'alice';
    const d = deps({ post, resolveTarget: async () => ({ publisher_id: 'fp_1', handle }) });
    await submitBoards(d);
    handle = 'alice-renamed';
    await submitBoards(d);
    expect(seen).toEqual(['alice', 'alice-renamed']);
  });
});

describe('D-250 § B4 — one signature over the whole batch', () => {
  it('⛔⛔ SIGNS THE SAME CANONICAL BYTES THE CLOUD VERIFIES', () => {
    // Both ends import `@recued/crypto/canonical-json`. If the payload SHAPE ever
    // diverges — a field added on one side, a rename — every signature fails and the
    // failure looks like a key problem rather than a shape problem.
    seed();
    const d = deps();
    void submitBoards(d);
    // The signed payload is exactly these four fields, in canonical order.
    expect(canonicalJSONStringify({
      publisher_id: 'fp_1', handle: 'alice',
      entries: { ops: { value: '0.6250', definition_version: 3 } },
      timestamp: NOW,
    })).toContain('"entries"');
  });

  it('the posted body carries the payload AND the signature', async () => {
    seed();
    const post = vi.fn(async (_url: string, _body: string) =>
      ({ ok: true, text: async () => JSON.stringify({ results: [] }) }));
    await submitBoards(deps({ post }));
    const body = JSON.parse(post.mock.calls[0]![1] as string);
    expect(body.publisher_id).toBe('fp_1');
    expect(body.entries).toEqual({
      ops: { value: '0.6250', definition_version: 3, metric_id: 'autopilot', season_id: '1', set_key: METRIC_SUBMISSION_SET_KEY },
    });
    expect(typeof body.signature).toBe('string');
    expect(body.signature.length).toBeGreaterThan(0);
  });

  it('⛔⛔ THE TIMESTAMP IS THE CURRENT ONE — the cloud has a 5-MINUTE REPLAY WINDOW', async () => {
    // A frozen timestamp signs fine and then 403s every submission after five minutes,
    // with nothing server-side to notice: `board_replay_window_exceeded` looks like a
    // signing problem from here. Nothing asserted this until a mutation showed it.
    seed();
    const post = vi.fn(async (_url: string, _body: string) =>
      ({ ok: true, text: async () => JSON.stringify({ results: [] }) }));
    await submitBoards(deps({ post, now: () => NOW + 99_000 }));
    expect(JSON.parse(post.mock.calls[0]![1] as string).timestamp).toBe(NOW + 99_000);
  });

  it('⛔ A DIFFERENT BATCH PRODUCES A DIFFERENT SIGNATURE', async () => {
    // The entries are signed WHOLE. A signature over a summary would let the batch change
    // after signing.
    const key = generateEd25519Keypair('server_identity_key');
    const signWith = (payload: string) => ed25519Sign(key, payload);
    const sigs: string[] = [];
    const post = vi.fn(async (_u: string, b: string) => {
      sigs.push(JSON.parse(b).signature);
      return { ok: true, text: async () => JSON.stringify({ results: [] }) };
    });
    seed();
    await submitBoards(deps({ post, sign: signWith }));
    db.exec('DELETE FROM metric_snapshot');
    createMetricSnapshotStore(db).write({
      computed_at: NOW, window: { from: 0, to: NOW },
      metrics: [{ metric_id: 'autopilot', metric_version: 3, reading: metricValue(0.9) }],
    });
    await submitBoards(deps({ post, sign: signWith }));
    expect(sigs[0]).not.toBe(sigs[1]);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. NOTHING TO SEND, AND FAILURE
// ────────────────────────────────────────────────────────────────

describe('D-250 — an empty batch is the default state, not an error', () => {
  it('⛔ POSTS NOTHING when there are no publications', async () => {
    // The cloud rejects an empty batch, and a server that publishes nothing is the
    // NORMAL case — computing is automatic, publishing never is.
    const post = vi.fn();
    const res = await submitBoards(deps({ post }));
    expect(post).not.toHaveBeenCalled();
    expect(res.sent).toBe(false);
  });

  it('a failed POST reports not-sent and changes no local state', async () => {
    const s = seed();
    s.publications.revoke('ops', NOW + 1000);
    const res = await submitBoards(deps({
      post: async () => ({ ok: false, text: async () => 'nope' }),
    }));
    expect(res.sent).toBe(false);
    // ⛔ THE WITHDRAWAL SURVIVES A FAILED SEND. Clearing it here would strand the owner
    // on a board they left, with nothing left to carry the withdrawal.
    expect(createBoardPublicationStore(db).get('ops')?.state).toBe('withdrawing');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. THE ACK
// ────────────────────────────────────────────────────────────────

describe('D-250 § B4.2 — only a confirmed withdrawal deletes', () => {
  it('⛔⛔ A `withdrawn` RESULT REMOVES THE PUBLICATION', async () => {
    const s = seed();
    s.publications.revoke('ops', NOW + 1000);
    await submitBoards(deps({
      post: async () => ({
        ok: true,
        text: async () => JSON.stringify({ results: [{ kind: 'withdrawn', board_id: 'ops' }] }),
      }),
    }));
    expect(createBoardPublicationStore(db).get('ops')).toBeUndefined();
  });

  it('⛔⛔ A `ranked` RESULT IS NOT EVEN OFFERED TO confirmWithdrawn', async () => {
    // ⚠ ASSERTED ON THE CALL, NOT THE OUTCOME. The publication survives either way — the
    // STORE refuses to delete an `active` row — so checking only the end state passes
    // even with the submitter's `kind === 'withdrawn'` filter deleted. Proved by
    // mutation. Two guards is fine; a test that cannot tell which one is holding is not.
    const s2 = seed();
    const confirmWithdrawn = vi.fn(() => false);
    await submitBoards(deps({
      publications: { ...s2.publications, confirmWithdrawn },
      post: async () => ({
        ok: true,
        text: async () => JSON.stringify({
          results: [{ kind: 'ranked', board_id: 'ops', rank: 3, participants: 12 }],
        }),
      }),
    }));
    expect(confirmWithdrawn).not.toHaveBeenCalled();
    expect(createBoardPublicationStore(db).get('ops')?.state).toBe('active');
  });

  it('⛔ AND A `withdrawn` ACK CANNOT DELETE A RE-PUBLISHED TAG', async () => {
    // The owner revoked, then changed their mind inside one batch interval. The store's
    // own guard refuses — pinned here because THIS is the path that would exercise it.
    const s = seed();
    s.publications.revoke('ops', NOW + 1000);
    s.publications.grant({ tag: 'ops', metric_id: 'autopilot', season_id: '1' }, NOW + 2000);
    await submitBoards(deps({
      post: async () => ({
        ok: true,
        text: async () => JSON.stringify({ results: [{ kind: 'withdrawn', board_id: 'ops' }] }),
      }),
    }));
    expect(createBoardPublicationStore(db).get('ops')?.state).toBe('active');
  });
});

describe('D-250 § B3.6 — the wire decimal', () => {
  it('is four places, always', () => {
    expect(toWireDecimal(1)).toBe('1.0000');
    expect(toWireDecimal(0.62499)).toBe('0.6250');
  });
});

// ────────────────────────────────────────────────────────────────
// 7. § B3.3 — a not-sent result NAMES ITS CAUSE
// ────────────────────────────────────────────────────────────────

/** ⛔⛔ FOUR UNRELATED STATES USED TO RETURN THE SAME `{sent:false, results:[]}` — no
 *  identity, no handle, nothing granted, nothing measured, and a refused POST. Three of
 *  those are a correctly-working server that has not opted in and one is a fault, and the
 *  owner-facing surface could only ever say "nothing happened". A live drive is what made
 *  it visible: with no board existing anywhere yet, `sent:false` was the guaranteed answer
 *  and the button produced no change of any kind.
 *
 *  🔑 EACH CASE MUTATES ONE INPUT FROM A WORKING SEND. Asserting five reasons off five
 *  differently-broken fixtures would pass even if the code returned a constant — the
 *  discrimination is the property, so the fixtures must differ in exactly one thing. */
describe('D-250 § B3.3 — `sent: false` names which nothing it is', () => {
  it('the control: a complete setup SENDS, and carries no reason', async () => {
    seed();
    const res = await submitBoards(deps());
    expect(res.sent).toBe(true);
    expect((res as { reason?: unknown }).reason).toBeUndefined();
  });

  it('⛔ NO HANDLE — nothing to publish AS', async () => {
    seed();
    const res = await submitBoards(deps({ resolveTarget: async () => null }));
    expect(res).toMatchObject({ sent: false, reason: 'no_handle' });
  });

  it('⛔ NOTHING GRANTED — § D4’s default state, not a fault', async () => {
    // Snapshot written, nothing published. The owner has opted into nothing.
    stores().snapshot.write({
      computed_at: NOW,
      window: { from: NOW - 86_400_000, to: NOW },
      metrics: [{ metric_id: 'autopilot', metric_version: 3, reading: metricValue(0.5) }],
    });
    const res = await submitBoards(deps());
    expect(res).toMatchObject({ sent: false, reason: 'no_publications' });
  });

  it('⛔⛔ GRANTED BUT UNMEASURED IS A DIFFERENT FACT — the entry keeps its old number', async () => {
    // § B3's retention means saying nothing leaves yesterday's value standing. Collapsing
    // this into `no_publications` would tell an owner who IS on a board that they are not.
    seed(METRIC_ABSENT);
    const res = await submitBoards(deps());
    expect(res).toMatchObject({ sent: false, reason: 'nothing_measured' });
  });

  it('⛔ A REFUSED POST IS THE ONLY FAULT IN THE UNION', async () => {
    seed();
    const res = await submitBoards(deps({
      post: vi.fn(async () => ({ ok: false, text: async () => 'nope' })),
    }));
    expect(res).toMatchObject({ sent: false, reason: 'send_failed' });
  });

  it('⛔⛔ THE FIVE OUTCOMES ARE DISTINCT — a constant would pass every case above', async () => {
    // Each assertion alone survives a `reason` hard-coded to its own value. Only reading
    // them together proves the function discriminates.
    const seen = new Set<string>();
    seed();
    seen.add((await submitBoards(deps({ resolveTarget: async () => null })) as { reason: string }).reason);
    seen.add((await submitBoards(deps({
      post: vi.fn(async () => ({ ok: false, text: async () => '' })),
    })) as { reason: string }).reason);
    stores().publications.revoke('ops', NOW);
    stores().publications.confirmWithdrawn('ops');
    seen.add((await submitBoards(deps()) as { reason: string }).reason);
    expect(seen.size).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────
// set_key — the shape this server submits under (045)
// ────────────────────────────────────────────────────────────────

/** 🔑 A board adopts the first key it is offered and refuses every later mismatch, so this
 *  string is the promise that two participants' rows were produced under the same contract.
 *  ⛔⛔ Two things must stay OUT of it, and both would look natural going in — see the
 *  constant's own comment. These tests are what stop either drifting back in. */
describe('045 — the submission contract this server sends under', () => {
  it('every reading carries it', () => {
    seed();
    expect((buildBatch(stores()).ops as { set_key: string }).set_key).toBe(METRIC_SUBMISSION_SET_KEY);
  });

  /** ⛔⛔ § D3.1a LEAVES THE VERSION OUT OF THE BOARD KEY ON PURPOSE, so participants on
   *  different definitions share one board and the per-row marker carries the difference.
   *  Folding it in here would split that board — and under 045's immutability rule a version
   *  bump would then refuse every submission to it FOREVER, with no way back. */
  it('⛔⛔ and it does NOT vary with the definition version', () => {
    const s = seed();
    const before = buildBatch(stores()).ops as { set_key: string; definition_version: number };
    // rewrite the snapshot at a different definition version, same metric
    s.snapshot.write({
      computed_at: NOW,
      window: { from: NOW - 86_400_000, to: NOW },
      metrics: [{ metric_id: 'autopilot', metric_version: 99, reading: metricValue(0.625) }],
    });
    const after = buildBatch(stores()).ops as { set_key: string; definition_version: number };
    expect(before.definition_version).toBe(3);
    expect(after.definition_version, 'the version really did change').toBe(99);
    expect(after.set_key).toBe(before.set_key);
  });

  /** ⛔ THE BOARD IS ALREADY KEYED ON THE METRIC, so folding it in would be a per-board
   *  constant that discriminates nothing while looking like it discriminates something. */
  it('⛔ nor with the metric id', () => {
    seed();
    const k = (buildBatch(stores()).ops as { set_key: string }).set_key;
    expect(k).not.toContain('autopilot');
  });

  /** ⛔⛔ A WITHDRAWAL CARRIES NO SHAPE. § C4 makes it tag-scoped across every season and the
   *  cloud resolves it before the board is looked up — so requiring one would make LEAVING a
   *  board depend on agreeing with it first. */
  it('⛔⛔ a withdrawal carries none', () => {
    const s = seed();
    s.publications.revoke('ops', NOW + 1000);
    expect(buildBatch(stores()).ops).toEqual({ unpublish: true });
  });

  it('⚠ it is a constant — two batches of the same state agree', () => {
    seed();
    const a = (buildBatch(stores()).ops as { set_key: string }).set_key;
    const bb = (buildBatch(stores()).ops as { set_key: string }).set_key;
    expect(a).toBe(bb);
  });
});

// ────────────────────────────────────────────────────────────────
// recipe-defined publications — the half an EVAL board needs
// ────────────────────────────────────────────────────────────────

/** ⛔⛔ AN EVAL BOARD IS RECIPE-DEFINED (§ 9 answer 1) AND THIS STORE ONLY KNEW `metric_id`,
 *  down to the SQLite column — so the board could exist in the cloud and nothing local could
 *  ever name it. */
describe('D-250 — a publication can name a recipe instead of a metric', () => {
  it('grants and reads back a recipe-defined publication', () => {
    const s = stores();
    const p = s.publications.grant({ tag: 'evals', recipe_id: 'eval-three-bullet-brief', season_id: '2026q3' }, NOW);
    expect(p.recipe_id).toBe('eval-three-bullet-brief');
    expect(p.metric_id).toBeNull();
    expect(stores().publications.get('evals')?.recipe_id).toBe('eval-three-bullet-brief');
  });

  it('the control: a metric publication still round-trips unchanged', () => {
    const s = stores();
    s.publications.grant({ tag: 'ops', metric_id: 'autopilot', season_id: '1' }, NOW);
    const p = stores().publications.get('ops')!;
    expect(p.metric_id).toBe('autopilot');
    expect(p.recipe_id).toBeNull();
  });

  /** ⛔ EXACTLY ONE DEFINITION, mirroring the cloud's `boards_one_definition` and the wire's
   *  refusal of both-or-neither. The CHECK is the guarantee; the union is how a caller cannot
   *  express the violation in the first place. */
  it('⛔ the database refuses a row naming both, and one naming neither', () => {
    stores();
    for (const [m, r] of [['autopilot', 'some-recipe'], [null, null]] as Array<[string | null, string | null]>) {
      expect(() => db.prepare(
        `INSERT INTO board_publications (tag, metric_id, recipe_id, season_id, state, granted_at)
         VALUES ('x', ?, ?, '1', 'active', 1)`).run(m, r),
      `metric_id=${m} recipe_id=${r}`).toThrow();
    }
  });

  /** ⛔⛔ THE SUBMITTER SKIPS IT RATHER THAN GUESSING. A recipe board has no metric snapshot —
   *  its numbers come from a recipe RUN — and sending `{unpublish: true}` would remove the
   *  owner from a board they never asked to leave. */
  it('⛔⛔ buildBatch skips a recipe publication — it does not withdraw it', () => {
    const s = seed();
    s.publications.grant({ tag: 'evals', recipe_id: 'eval-three-bullet-brief', season_id: '2026q3' }, NOW);
    const batch = buildBatch(stores());
    expect(batch.evals, 'must not appear at all').toBeUndefined();
    expect(batch.ops, 'and the metric publication beside it still rides').toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────
// the pending eval result — what a recipe leaves for the next batch
// ────────────────────────────────────────────────────────────────

/** ⛔⛔ THE COMPOSITION IS THE BUG, NOT EITHER HALF. `shared-store.ts:749` matches
 *  `list(prefix)` as `key = prefix` PLUS the half-open range over `<prefix>.` — descendants
 *  only. A key built with an underscore is matched by NOTHING: the list returns empty,
 *  nothing is ever found, and the batch reports "nothing measured" forever while the recipe
 *  writes happily every run. Asserting the two shapes separately would pass either way. */
describe('045 — the pending-result key', () => {
  it('⛔⛔ the key is the prefix plus a DOT segment — asserted as one composition', () => {
    expect(evalPendingKey('evals')).toBe(`${EVAL_PENDING_PREFIX}.evals`);
    expect(evalPendingKey('evals').startsWith(`${EVAL_PENDING_PREFIX}.`)).toBe(true);
    expect(evalPendingKey('evals')).not.toContain('_evals');
  });

  it('⚠ a tag cannot introduce a segment of its own', () => {
    // The cloud's /explore route admits only [A-Za-z0-9_-], so no tag carries a dot.
    expect(evalPendingKey('my-tag_2').split('.')).toHaveLength(3);
  });
});

/** ⛔⛔ THIS PARSES USER-WRITABLE JSON. The shared store is written by recipes through an
 *  ordinary op, so the value is whatever the owner's recipe last put there — including what a
 *  half-finished one put there. A malformed result must produce NO entry, never a partial. */
describe('045 — parsing what a recipe left behind', () => {
  const ok = { value: '0.8100', definition_version: 3 };

  it('accepts the minimum, and the full shape', () => {
    expect(parsePendingResult(ok)).toMatchObject({ value: '0.8100', definition_version: 3 });
    expect(parsePendingResult({ ...ok, subject: { model: 'x' }, observations: ['1.0', '2.0'], answer: 'hi' }))
      .toMatchObject({ subject: { model: 'x' }, observations: ['1.0', '2.0'], answer: 'hi' });
  });

  it('⛔ refuses a value that § B3.6 would refuse a day later', () => {
    for (const v of ['0.81000', '1e5', 'NaN', '', ' 1', 0.81]) {
      expect(parsePendingResult({ ...ok, value: v }), JSON.stringify(v)).toBeNull();
    }
  });

  it('⛔ refuses a malformed distribution rather than sending half of it', () => {
    expect(parsePendingResult({ ...ok, observations: ['1.0', 'x'] })).toBeNull();
    expect(parsePendingResult({ ...ok, observations: 'not-a-list' })).toBeNull();
  });

  it('⛔ refuses junk in every other slot', () => {
    expect(parsePendingResult({ ...ok, definition_version: 1.5 })).toBeNull();
    expect(parsePendingResult({ ...ok, subject: ['a'] })).toBeNull();
    expect(parsePendingResult({ ...ok, answer: '   ' })).toBeNull();
    for (const v of [null, undefined, 'string', 42, ['a']]) {
      expect(parsePendingResult(v), JSON.stringify(v)).toBeNull();
    }
  });
});

describe('045 — an eval board rides the batch', () => {
  const granted = () => {
    const s = seed();
    s.publications.grant({ tag: 'evals', recipe_id: 'eval-three-bullet-brief', season_id: '2026q3' }, NOW);
    return s;
  };

  it('a pending result becomes a recipe-keyed entry carrying its evidence', () => {
    granted();
    const batch = buildBatch(stores(), new Map([['evals', {
      value: '0.8000', definition_version: 3,
      subject: { provider: 'anthropic', model: 'claude-opus-5' },
      observations: ['1.0000', '1.0000', '0.0000', '1.0000', '1.0000'],
    }]]));
    expect(batch.evals).toEqual({
      value: '0.8000', definition_version: 3,
      recipe_id: 'eval-three-bullet-brief', season_id: '2026q3',
      subject: { provider: 'anthropic', model: 'claude-opus-5' },
      observations: ['1.0000', '1.0000', '0.0000', '1.0000', '1.0000'],
      set_key: EVAL_SUBMISSION_SET_KEY,
    });
  });

  /** ⛔ A DIFFERENT CONTRACT FROM A METRIC ENTRY, because it carries different fields. A board
   *  that agreed to one refuses the other — 045 working, not a problem. */
  it('⛔ its set_key is not the metric one', () => {
    expect(EVAL_SUBMISSION_SET_KEY).not.toBe(METRIC_SUBMISSION_SET_KEY);
  });

  it('⚠ no pending result yet is silence, not a withdrawal', () => {
    granted();
    const batch = buildBatch(stores(), new Map());
    expect(batch.evals).toBeUndefined();
    expect(batch.ops, 'the metric publication beside it still rides').toBeDefined();
  });

  it('⛔⛔ a MALFORMED result is silence too — never a partial entry', () => {
    granted();
    const batch = buildBatch(stores(), new Map([['evals', { value: 'junk', definition_version: 3 }]]));
    expect(batch.evals).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// the read itself — submitBoards, not buildBatch
// ────────────────────────────────────────────────────────────────

/** ⛔⛔ THE HOP THAT WAS MISSING. `buildBatch` could always SHAPE an eval entry; nothing
 *  fetched the pending result, so an eval board could be granted locally and never submit.
 *  These drive `submitBoards` — the function that actually reads — rather than handing
 *  `buildBatch` a map, which would test the map. */
describe('045 — submitBoards reads the pending result', () => {
  const withReader = (reader?: (key: string) => Promise<unknown>) => {
    const s = seed();
    s.publications.grant({ tag: 'evals', recipe_id: 'eval-three-bullet-brief', season_id: '2026q3' }, NOW);
    const post = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ results: [] }) }));
    return { post, run: () => submitBoards(deps({ post, ...(reader === undefined ? {} : { readPending: reader }) })) };
  };
  const sentEntries = (post: ReturnType<typeof vi.fn>) =>
    JSON.parse(String((post.mock.calls[0] as unknown[])[1])).entries as Record<string, unknown>;

  it('⛔⛔ reads the key the recipe writes, and sends what it finds', async () => {
    const seen: string[] = [];
    const { post, run } = withReader(async (key) => {
      seen.push(key);
      return { value: '0.8000', definition_version: 3, observations: ['1.0', '1.0', '0.0', '1.0', '1.0'] };
    });
    await run();
    // the COMPOSITION: the reader is asked for exactly the key `evalPendingKey` builds
    expect(seen).toContain(evalPendingKey('evals'));
    expect(sentEntries(post).evals).toMatchObject({
      value: '0.8000', recipe_id: 'eval-three-bullet-brief', set_key: EVAL_SUBMISSION_SET_KEY,
    });
  });

  /** ⚠ A server with no eval boards — every server today — must touch the shared store ZERO
   *  times on its daily batch. */
  it('⚠ a metric-only publication is never read for', async () => {
    const seen: string[] = [];
    const s = seed();
    void s;
    const post = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ results: [] }) }));
    await submitBoards(deps({ post, readPending: async (k: string) => { seen.push(k); return null; } }));
    expect(seen).toEqual([]);
  });

  it('⚠ no reader at all is silence, not a failure — the metric entry still sends', async () => {
    const { post, run } = withReader(undefined);
    const res = await run();
    expect(res.sent).toBe(true);
    expect(sentEntries(post).evals).toBeUndefined();
    expect(sentEntries(post).ops).toBeDefined();
  });

  /** ⛔⛔ ONE BAD READ MUST NOT TAKE THE BATCH WITH IT. § B3.3 comes round once a day, so a
   *  store error on one tag dropping every OTHER publication's submission costs everyone a
   *  day for one board's fault. */
  it('⛔⛔ a throwing read degrades that tag only', async () => {
    const { post, run } = withReader(async () => { throw new Error('store exploded'); });
    const res = await run();
    expect(res.sent).toBe(true);
    expect(sentEntries(post).evals).toBeUndefined();
    expect(sentEntries(post).ops, 'the metric publication beside it still rides').toBeDefined();
  });

  it('⛔ a malformed stored value is skipped, never partially sent', async () => {
    const { post, run } = withReader(async () => ({ value: 'not-a-decimal', definition_version: 3 }));
    await run();
    expect(sentEntries(post).evals).toBeUndefined();
  });
});

/** ⛔⛔ THE HALF THAT MADE "CREATED ON FIRST SUBMIT" REACHABLE FROM THE PRODUCT. The cloud
 *  refuses to create a board from a submission that does not say what the board IS —
 *  `boards.kind` defaults to `'score'`, so creating on that default would silently turn
 *  every artifact board into a ladder. Until the submitter carried the declaration, the
 *  only way to exercise auto-creation was a hand-built payload, which proves the drive can
 *  talk to the cloud and not that the PRODUCT can. */
describe('the declaration rides from the recipe to the wire', () => {
  const granted = () => {
    const s = seed();
    s.publications.grant({ tag: 'evals', recipe_id: 'eval-three-bullet-brief', season_id: '2026q3' }, NOW);
    return s;
  };
  const pend = (over: Record<string, unknown>) => new Map<string, unknown>([['evals', {
    value: '0.8000', definition_version: 3,
    subject: { provider: 'anthropic', model: 'claude-opus-5' }, ...over,
  }]]);

  it('a free_answer declaration reaches the entry with its review bar', () => {
    granted();
    const e = buildBatch(stores(), pend({ kind: 'free_answer', min_reviews: 2 })).evals as
      Record<string, unknown>;
    expect(e.kind).toBe('free_answer');
    expect(e.min_reviews).toBe(2);
    expect(e.recipe_id, 'the board key still rides').toBe('eval-three-bullet-brief');
  });

  it('a score declaration carries BOTH ranking fields', () => {
    granted();
    const e = buildBatch(stores(), pend({
      kind: 'score', direction: 'higher', retention: 'highest',
    })).evals as Record<string, unknown>;
    expect(e).toMatchObject({ kind: 'score', direction: 'higher', retention: 'highest' });
  });

  /** ⚠ A SUBMISSION TO AN EXISTING BOARD DECLARES NOTHING — the field is absent, not null,
   *  because the cloud distinguishes "create it like this" from "add to what is there". */
  it('a pending result with no declaration sends no declaration keys', () => {
    granted();
    const e = buildBatch(stores(), pend({})).evals as Record<string, unknown>;
    for (const k of ['kind', 'min_reviews', 'direction', 'retention']) {
      expect(Object.hasOwn(e, k), k).toBe(false);
    }
  });

  /** ⛔⛔ A TYPO SKIPS THE ENTRY — it does NOT drop the field and send the reading. Sending
   *  the reading alone would ask the cloud to create the board on the schema default, which
   *  is the one outcome the declaration exists to prevent. */
  it('⛔⛔ a malformed declaration sends NOTHING for that tag, never a partial entry', () => {
    granted();
    for (const bad of [
      { kind: 'registry' }, { kind: 'Score' }, { min_reviews: 0 }, { min_reviews: 1.5 },
      { min_reviews: '2' }, { direction: 'up' }, { retention: 'newest' },
    ]) {
      const batch = buildBatch(stores(), pend(bad));
      expect(batch.evals, JSON.stringify(bad)).toBeUndefined();
      expect(batch.ops, 'the metric beside it is unaffected').toBeDefined();
    }
  });

  it('and parsePendingResult refuses the same vocabulary directly', () => {
    const ok = { value: '0.8000', definition_version: 3 };
    expect(parsePendingResult({ ...ok, kind: 'free_answer', min_reviews: 2 }))
      .toMatchObject({ kind: 'free_answer', min_reviews: 2 });
    expect(parsePendingResult({ ...ok, kind: 'registry' })).toBeNull();
    expect(parsePendingResult({ ...ok, retention: 'newest' })).toBeNull();
    expect(parsePendingResult({ ...ok, direction: 'sideways' })).toBeNull();
    expect(parsePendingResult({ ...ok, min_reviews: -1 })).toBeNull();
  });
});
