/** D-250 § D7 — `metric.read`.
 *
 *  🔑 THE TWO STORES ANSWER DIFFERENT QUESTIONS AND THIS METHOD MUST NOT FLATTEN THEM.
 *  A snapshot metric is recomputed and replaced (it can go down, and it knows nothing
 *  older than the audit window); an artifact ADVANCES (a record survives a quiet week).
 *  Most cases here are about that line staying visible on the wire.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { METRIC_REGISTRY, MILESTONE_REGISTRY, metricValue, METRIC_ABSENT } from '@recued/contracts';

import {
  handleMetricPublish,
  handleMetricRead,
  handleMetricUnpublish,
  handleMetricSubmit,
  makeMetricHandlers,
} from '../metrics-handler.js';
import { createBoardPublicationStore } from '../metrics/publication-store.js';
import { createMetricArtifactStore } from '../metrics/artifact-store.js';
import { createMetricSnapshotStore } from '../metrics/snapshot-store.js';
import { ed25519Sign, generateEd25519Keypair } from '../keys/index.js';

const NOW = 1_700_000_000_000;
let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-250-rpc-'));
  db = new Database(join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seedSnapshot = (metrics = [
  { metric_id: 'autopilot', metric_version: 1, reading: metricValue(0.5) },
]) =>
  createMetricSnapshotStore(db).write({
    computed_at: NOW,
    window: { from: NOW - 86_400_000, to: NOW },
    metrics,
    diagnostics: { unclassified_runs: 2 },
  });

describe('D-250 § D7 — nothing computed yet', () => {
  it('⛔⛔ SNAPSHOT IS NULL, NOT AN EMPTY LIST OF ZEROS', async () => {
    // "Nothing has run" and "everything measured zero" are different facts, and a
    // dashboard that cannot tell them apart will report a healthy server as idle.
    const out = await handleMetricRead({ db });
    expect(out.snapshot).toBeNull();
    expect(out.artifacts).toEqual([]);
  });

  it('⛔ MILESTONES STILL LIST — unearned is a state, not an absence', async () => {
    const out = await handleMetricRead({ db });
    expect(out.milestones).toHaveLength(Object.keys(MILESTONE_REGISTRY).length);
    expect(out.milestones.every((m) => m.earned_at === null)).toBe(true);
  });
});

describe('D-250 § D7 — display metadata travels with the value', () => {
  it('⛔⛔ LABEL AND DIRECTION ARE SENT, NOT LOOKED UP CLIENT-SIDE', async () => {
    // app.recued.com and a self-hosted server version INDEPENDENTLY. A client rendering
    // its own registry's direction against the server's number silently inverts what
    // "better" means.
    seedSnapshot();
    const m = (await handleMetricRead({ db })).snapshot!.metrics[0]!;
    expect(m.label).toBe(METRIC_REGISTRY.autopilot!.label);
    expect(m.direction).toBe(METRIC_REGISTRY.autopilot!.direction);
    expect(m.publishable).toBe(true);
  });

  it("⛔ THE SNAPSHOT'S VERSION IS SENT, NOT THE REGISTRY'S", async () => {
    // They differ exactly when a release changed a definition and no cycle has
    // recomputed — the number on screen came from the OLD one (§ D3.1a).
    seedSnapshot([{ metric_id: 'autopilot', metric_version: 99, reading: metricValue(1) }]);
    expect((await handleMetricRead({ db })).snapshot!.metrics[0]!.metric_version).toBe(99);
  });

  it('⛔ A METRIC THE REGISTRY NO LONGER KNOWS IS DROPPED, not rendered blank', async () => {
    // A stored snapshot outlives a release that retires a metric, and a row with no
    // label or direction cannot be shown honestly — "higher is better" is not a safe
    // default. Written past the store's guard, which is what a stale row looks like.
    createMetricSnapshotStore(db).write({
      computed_at: NOW, window: { from: 0, to: NOW },
      metrics: [{ metric_id: 'autopilot', metric_version: 1, reading: metricValue(0.5) }],
    });
    db.prepare('UPDATE metric_snapshot SET data = ?').run(JSON.stringify({
      computed_at: NOW, window: { from: 0, to: NOW },
      metrics: [
        { metric_id: 'autopilot', metric_version: 1, reading: metricValue(0.5) },
        { metric_id: 'retired_metric', metric_version: 1, reading: metricValue(9) },
      ],
    }));
    const out = await handleMetricRead({ db });
    expect(out.snapshot!.metrics.map((m) => m.metric_id)).toEqual(['autopilot']);
  });

  it('an absent reading survives as absent', async () => {
    seedSnapshot([{ metric_id: 'economy', metric_version: 1, reading: METRIC_ABSENT }]);
    expect((await handleMetricRead({ db })).snapshot!.metrics[0]!.reading.kind).toBe('absent');
  });

  it('diagnostics ride along for the coverage boundaries', async () => {
    seedSnapshot();
    expect((await handleMetricRead({ db })).snapshot!.diagnostics?.unclassified_runs).toBe(2);
  });
});

describe('D-250 amendment 17 — the two stores stay distinguishable', () => {
  it('⛔⛔ A RECORD COMES BACK AS AN ARTIFACT, NOT A SNAPSHOT METRIC', async () => {
    // If Burst appeared in `metrics`, a UI would render it beside values that go down
    // and eventually explain a surviving record as a bug.
    seedSnapshot();
    createMetricArtifactStore(db).advanceRecord('burst', 47, NOW);
    const out = await handleMetricRead({ db });
    expect(out.snapshot!.metrics.map((m) => m.metric_id)).not.toContain('burst');
    expect(out.artifacts).toContainEqual({ key: 'burst', kind: 'record', value: 47, updated_at: NOW });
    expect(METRIC_REGISTRY.burst!.store).toBe('artifact');
  });

  it('⛔ MILESTONES ARE NOT IN `artifacts` — they are projected separately', async () => {
    // Otherwise only EARNED ones would appear, and an unearned milestone would vanish
    // rather than showing as not-yet.
    createMetricArtifactStore(db).earnMilestone('first_zero_approval_day', NOW);
    const out = await handleMetricRead({ db });
    expect(out.artifacts.some((a) => a.kind === 'once')).toBe(false);
    expect(out.milestones.find((m) => m.milestone_id === 'first_zero_approval_day')?.earned_at)
      .toBe(NOW);
  });

  it('a counter and its record come back as separate keys', async () => {
    const a = createMetricArtifactStore(db);
    a.setCounter('hands_off.current', 0, NOW);
    a.advanceRecord('hands_off.longest', 31, NOW);
    const out = await handleMetricRead({ db });
    expect(out.artifacts.find((x) => x.key === 'hands_off.current')?.value).toBe(0);
    expect(out.artifacts.find((x) => x.key === 'hands_off.longest')?.value).toBe(31);
  });
});

describe('D-250 § D5.3 — an undetectable milestone says so', () => {
  it('⛔⛔ `detectable` SEPARATES "not yet" FROM "we are not looking"', async () => {
    // Without it the two render identically, and the owner reads "you have not done
    // this" when the truth is that no hook exists to award it.
    // ⚠ AMENDED 2026-08-25 — this used to pin two specific milestones as undetectable,
    // and BOTH claims became false: one was reclassified once its real audit signal was
    // found, the other was removed because no server-side call site can exist. The
    // property that survives is the one the field is FOR — the wire must carry which is
    // which, so a future unhooked milestone cannot render as merely unearned.
    const out = await handleMetricRead({ db });
    for (const m of out.milestones) {
      expect(m.detectable).toBe(MILESTONE_REGISTRY[m.milestone_id]!.source === 'audit_window');
      expect(typeof m.detectable).toBe('boolean');
    }
    expect(out.milestones.length).toBeGreaterThan(0);
  });
});

describe('D-250 § D7 — the slice', () => {
  it('⛔ NO DEPS => NO SLICE, so a db-less boot degrades instead of failing', () => {
    expect(makeMetricHandlers(undefined)).toBeUndefined();
  });

  it('⛔ PUBLISHING IS ITS OWN METHOD, never a side effect of reading (§ D4)', async () => {
    // ⚠ AMENDED when the grant landed. This used to assert "read is the ONLY method",
    // which was right while publish did not exist — but the property that MATTERS is
    // narrower and survives: `metric.read` must not publish. § D4 splits the acts so a
    // publish cannot ride the read path's authorization.
    const slice = makeMetricHandlers({ db })!;
    const before = createBoardPublicationStore(db).list().length;
    expect(await slice.handlers['metric.read']()).toBeDefined();
    expect(createBoardPublicationStore(db).list()).toHaveLength(before);
  });
});

// ────────────────────────────────────────────────────────────────
// THE FORWARD SEAM — caught here before it shipped
// ────────────────────────────────────────────────────────────────

describe('D-250 § D7 — metricDeps survives BOTH hops to the ws-server', () => {
  // ⛔⛔ THERE ARE TWO PLACES TO DROP IT AND ONLY ONE IS OBVIOUS.
  // `compose-listeners.ts` builds the dep; `server.ts` then forwards each `config.X`
  // EXPLICITLY into the ws-server. A missing forward leaves the method answering
  // `not_configured` on the live wire while every handler test above still passes —
  // the seam `archive-rpc-wiring.test.ts` exists for, after `archiveDeps`, `updateDeps`
  // and `contactEngagementsRpcDeps` were each dropped this way.
  // ⚠ I DID DROP IT. This test is what a grep found before the deploy, not after.
  const read = (f: string) =>
    readFileSync(pathJoin(dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8');

  /** ⚠ ASSERT THE BINDING, NOT THE KEY ORDER. This read `/metricDeps:\s*\{\s*db:/` and went red
   *  the day a second key was added ahead of `db` — a correct change failing a test that had
   *  pinned incidental formatting. The bounded lazy scan below cannot run away across the file,
   *  still refuses a bare forward (`metricDeps: config.metricDeps` has no `{`), and now names
   *  WHERE the handle comes from, which the ordering never did. */
  it('⛔ compose-listeners BUILDS the dep', () => {
    expect(read('serve/compose-listeners.ts'))
      .toMatch(/metricDeps:\s*\{[\s\S]{0,2000}?\bdb:\s*rpc\.housekeepingRpcDeps\.db/);
  });

  it('⛔⛔ server.ts FORWARDS it — the hop that is easy to forget', () => {
    expect(read('server.ts')).toMatch(/metricDeps:\s*config\.metricDeps/);
  });

  it('ws-server REGISTERS the slice from that dep', () => {
    const ws = read('ws-server.ts');
    expect(ws).toContain('makeMetricHandlers(metricDeps)');
  });
});

// ────────────────────────────────────────────────────────────────
// § D4 — the publish grant
// ────────────────────────────────────────────────────────────────

describe('D-250 § D4 — publishing is an explicit owner act', () => {
  const deps = () => ({ db, now: () => NOW });

  it('nothing is published by default', async () => {
    // ⛔ COMPUTING IS AUTOMATIC; PUBLISHING NEVER IS. An empty list is the normal state,
    // not an unconfigured one.
    expect((await handleMetricRead({ db })).publications).toEqual([]);
  });

  it('a grant appears on the read and carries its state', async () => {
    await handleMetricPublish(deps(), { tag: 'ops', metric_id: 'autopilot', season_id: '1' });
    const pubs = (await handleMetricRead({ db })).publications;
    expect(pubs).toEqual([
      { tag: 'ops', metric_id: 'autopilot', season_id: '1', state: 'active', granted_at: NOW },
    ]);
  });

  it('⛔⛔ A NON-PUBLISHABLE METRIC IS REFUSED AT THE RPC, not hidden in the UI', async () => {
    // § D2: a count publishes VOLUME (how much server you own), a ratio publishes SKILL.
    // Creator is a count. A UI that merely omits it from a dropdown is not an enforcement
    // point — the rpc is.
    expect(METRIC_REGISTRY.creator!.publishable).toBe(false);
    await expect(handleMetricPublish(deps(), {
      tag: 'ops', metric_id: 'creator', season_id: '1',
    })).rejects.toThrow(/not publishable/);
  });

  it('an unknown metric is refused', async () => {
    await expect(handleMetricPublish(deps(), {
      tag: 'ops', metric_id: 'invented', season_id: '1',
    })).rejects.toThrow(/unknown metric/);
  });

  it('an empty tag or season is refused', async () => {
    await expect(handleMetricPublish(deps(), { tag: '', metric_id: 'autopilot', season_id: '1' }))
      .rejects.toThrow(/required/);
    await expect(handleMetricPublish(deps(), { tag: 'ops', metric_id: 'autopilot', season_id: '' }))
      .rejects.toThrow(/required/);
  });
});

describe('D-250 § C4 — revoke persists as STATE, never as an absence', () => {
  const deps = () => ({ db, now: () => NOW });

  it('⛔⛔ UNPUBLISH LEAVES A `withdrawing` ROW, IT DOES NOT DELETE', async () => {
    // THE defect § C4 names: § B3.3 rules "always send; let the board discard", so the
    // submitting server keeps posting daily and has no idea a row was withdrawn. A plain
    // delete is re-created by tomorrow's batch and the owner silently reappears on a
    // board they left.
    await handleMetricPublish(deps(), { tag: 'ops', metric_id: 'autopilot', season_id: '1' });
    const res = await handleMetricUnpublish(deps(), { tag: 'ops' });
    expect(res.publication?.state).toBe('withdrawing');

    const pubs = (await handleMetricRead({ db })).publications;
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.state).toBe('withdrawing');
  });

  it('⛔ A WITHDRAWING ROW STILL RIDES THE BATCH — that is what terminates on the ack', async () => {
    await handleMetricPublish(deps(), { tag: 'ops', metric_id: 'autopilot', season_id: '1' });
    await handleMetricUnpublish(deps(), { tag: 'ops' });
    expect(createBoardPublicationStore(db).pending().map((p) => p.tag)).toEqual(['ops']);
  });

  it('revoking a tag that was never published returns null, not an invented withdrawal', async () => {
    // A withdrawal for a board this server never joined would tell the cloud to delete
    // someone else's row — or at best carry noise in every future batch.
    const res = await handleMetricUnpublish(deps(), { tag: 'never-joined' });
    expect(res.publication).toBeNull();
    expect(createBoardPublicationStore(db).list()).toEqual([]);
  });
});

describe('D-250 § B4.2 — only the ack deletes', () => {
  it('⛔⛔ confirmWithdrawn REFUSES AN `active` ROW', async () => {
    // The owner can re-publish inside one batch interval. An ack that deleted on the tag
    // alone would silently undo that, and "always send" would not notice because the row
    // is simply gone.
    const store = createBoardPublicationStore(db);
    store.grant({ tag: 'ops', metric_id: 'autopilot', season_id: '1' }, NOW);
    expect(store.confirmWithdrawn('ops')).toBe(false);
    expect(store.get('ops')?.state).toBe('active');
  });

  it('a withdrawing row IS removed by the ack', () => {
    const store = createBoardPublicationStore(db);
    store.grant({ tag: 'ops', metric_id: 'autopilot', season_id: '1' }, NOW);
    store.revoke('ops', NOW + 1000);
    expect(store.confirmWithdrawn('ops')).toBe(true);
    expect(store.get('ops')).toBeUndefined();
  });

  /** ⛔⛔ THIS CASE USED TO CHANGE THE KEY, AND THAT IS WHAT MADE IT WRONG. It granted
   *  `(ops, autopilot, 1)`, revoked, then granted `(ops, ECONOMY, 2)` and called the
   *  cleared withdrawal "the owner changed their mind". The reasoning holds for a
   *  re-grant of the SAME board key and collapses for a different one: the withdrawal
   *  would have erased the old key's row up in the cloud, and dropping it left the owner
   *  publicly listed on a board they had explicitly left. A live drive caught it; this
   *  test had asserted the defect as the expectation and stayed green over it.
   *
   *  🔑 The two halves are now separate cases, because they are separate claims. */
  it('⛔ RE-PUBLISHING THE SAME KEY CLEARS THE WITHDRAWAL — the owner changed their mind', () => {
    const store = createBoardPublicationStore(db);
    store.grant({ tag: 'ops', metric_id: 'autopilot', season_id: '1' }, NOW);
    store.revoke('ops', NOW + 1000);
    store.grant({ tag: 'ops', metric_id: 'autopilot', season_id: '1' }, NOW + 2000);
    const p = store.get('ops')!;
    expect(p.state).toBe('active');
    expect(p.withdrawn_at).toBeNull();
    // Nothing is orphaned: the value that ships next overwrites the very row the
    // withdrawal would have deleted.
    expect(p.metric_id).toBe('autopilot');
    expect(p.season_id).toBe('1');
    // ⚠ granted_at keeps its ORIGINAL value — it answers "since when has this been
    // published", and re-stamping it on every edit would erase that.
    expect(p.granted_at).toBe(NOW);
  });

  it('⛔⛔ A RE-GRANT THAT CHANGES THE KEY LEAVES THE OLD BOARD ROW BEHIND', () => {
    // The local store is `tag PRIMARY KEY`, so this is lossy BY CONSTRUCTION — after the
    // second grant nothing here remembers season 1 ever shipped. That is not fixable in
    // this store without making it disagree with the wire, which carries one entry per
    // tag; the erase is enforced in `board-apply.ts`, which is the only side that can see
    // both board rows. This case PINS the local half of that contract so the next reader
    // does not mistake the missing withdrawal for an oversight.
    const store = createBoardPublicationStore(db);
    store.grant({ tag: 'ops', metric_id: 'autopilot', season_id: '1' }, NOW);
    store.revoke('ops', NOW + 1000);
    store.grant({ tag: 'ops', metric_id: 'economy', season_id: '2' }, NOW + 2000);

    expect(store.list()).toHaveLength(1);
    const p = store.get('ops')!;
    expect(p.metric_id).toBe('economy');
    expect(p.season_id).toBe('2');
    // ⛔ THE WITHDRAWAL IS GONE, and `pending()` is exactly what the next batch carries —
    // so no `{unpublish:true}` will ever ship for the season-1 row. The cloud's
    // sibling-prune is what removes it, on the next value submission for this tag.
    expect(store.pending().some((x) => x.state === 'withdrawing')).toBe(false);
  });
});

describe('D-250 § D4 — the slice exposes publish as its own method', () => {
  it('⛔ EVERY OUTWARD ACT IS ITS OWN METHOD — none folded into read', () => {
    // ⚠ AMENDED when `metric.submit` landed. Pinning a COUNT ("three methods") re-breaks
    // on every addition and says nothing; the property § D4 actually rules is that
    // reading cannot publish and cannot send.
    const methods = [...makeMetricHandlers({ db })!.methods];
    expect(methods).toContain('metric.read');
    for (const outward of ['metric.publish', 'metric.unpublish', 'metric.submit']) {
      expect(methods, `${outward} must be its own method`).toContain(outward);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// § B3.3 — metric.submit
// ────────────────────────────────────────────────────────────────

describe('D-250 § B3.3 / § D4 — the daily submission is an EXPLICIT act', () => {
  it('⛔⛔ IT IS AN RPC, NOT A HOUSEKEEPING TASK', () => {
    // § D4 gives housekeeping the `admin` ceiling for "the server's own maintenance", and
    // publishing an owner's activity to a public board is not that. Registered in
    // STANDALONE_TASKS it would silently inherit an exemption written for something else.
    expect([...makeMetricHandlers({ db })!.methods]).toContain('metric.submit');
    const reg = readFileSync(
      pathJoin(dirname(fileURLToPath(import.meta.url)), '..', 'housekeeping/registration.ts'),
      'utf8',
    );
    expect(reg).not.toContain('boardSubmit');
    expect(reg).not.toContain('metric.submit');
  });

  it('⛔ A SERVER THAT CANNOT PUBLISH REPORTS not-sent, it does not throw', async () => {
    // No bound account, no identity key — not publishing is the DEFAULT state. Throwing
    // would make "I have not set this up" indistinguishable from "the send failed".
    //
    // ⛔⛔ AND THE BARE BOOLEAN MADE THEM INDISTINGUISHABLE ANYWAY. This comment named the
    // exact confusion while the assertion pinned a shape that could not express the
    // difference — the surface could only ever say "nothing happened". `skip_reason` is
    // what makes the sentence above true rather than aspirational.
    const res = await handleMetricSubmit({ db });
    expect(res).toEqual({
      ok: true, sent: false, results: [], skip_reason: 'no_identity',
    });
  });

  it('⛔⛔ THE SUBMITTER DEP IS BUILT AT THE COMPOSITION ROOT — the last hop', () => {
    // Three hops now: compose-listeners BUILDS metricDeps, server.ts FORWARDS it, and
    // ws-server REGISTERS the slice. The `submitter` field is a FOURTH thing to forget —
    // and forgetting it used to be invisible: `metric.submit` answered `sent: false`,
    // which is also the correct answer for a server that simply has not set publishing
    // up. That was the worst kind of gap, because the failure mode was the default state.
    // ⚠ `skip_reason` NARROWS IT BUT DOES NOT CLOSE IT: a dropped `submitter` now answers
    // `no_identity` while a set-up-but-handle-less server answers `no_handle`, so the two
    // are distinguishable — but a server that genuinely has no identity gives the same
    // answer as the wiring gap, which is why this source-level check stays.
    const compose = readFileSync(
      pathJoin(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-listeners.ts'),
      'utf8',
    );
    expect(compose).toMatch(/submitter:\s*\(\)\s*=>/);
    expect(compose).toContain('signWithServerIdentity');
    expect(compose).toContain('/v1/boards/submit');
    // ⛔ RESOLVED PER SEND, not captured: a handle can change while the server runs.
    expect(compose).toMatch(/resolveTarget:\s*async\s*\(\)\s*=>/);
  });

  it('sends when the wiring is present, and returns what the board said', async () => {
    createMetricSnapshotStore(db).write({
      computed_at: NOW, window: { from: 0, to: NOW },
      metrics: [{ metric_id: 'autopilot', metric_version: 1, reading: metricValue(0.5) }],
    });
    createBoardPublicationStore(db).grant(
      { tag: 'ops', metric_id: 'autopilot', season_id: '1' }, NOW,
    );
    const res = await handleMetricSubmit({
      db,
      now: () => NOW,
      submitter: () => ({
        sign: (payload: string) =>
          ed25519Sign(generateEd25519Keypair('server_identity_key'), payload),
        resolveTarget: async () => ({ publisher_id: 'fp', handle: 'alice' }),
        endpoint: 'https://api.recued.com/v1/boards/submit',
        post: async () => ({
          ok: true,
          text: async () => JSON.stringify({
            results: [{ kind: 'ranked', board_id: 'ops', rank: 2, participants: 9 }],
          }),
        }),
      }),
    });
    expect(res.sent).toBe(true);
    expect(res.results[0]).toMatchObject({ kind: 'ranked', rank: 2, participants: 9 });
  });
});
