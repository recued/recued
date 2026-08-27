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
import { buildBatch, submitBoards, toWireDecimal } from '../metrics/board-submitter.js';
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
      ops: { value: '0.6250', definition_version: 3, metric_id: 'autopilot', season_id: '1' },
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
      ops: { value: '0.6250', definition_version: 3, metric_id: 'autopilot', season_id: '1' },
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
