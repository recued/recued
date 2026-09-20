/** R13 T4-6.1 — dropped-audit-writes sidecar marker tests. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  consumeDroppedWritesMarker,
  droppedWritesMarkerPath,
  writeDroppedWritesMarker,
} from '../audit/dropped-writes-marker.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const makeDir = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'recued-drop-marker-'));
  return dir;
};

describe('dropped-writes marker (R13 T4-6.1)', () => {
  it('derives a sidecar path only for on-disk databases', () => {
    expect(droppedWritesMarkerPath(':memory:')).toBeNull();
    expect(droppedWritesMarkerPath('')).toBeNull();
    expect(droppedWritesMarkerPath('file::memory:?cache=shared')).toBeNull();
    expect(droppedWritesMarkerPath('/data/recued/server.db')).toBe(
      '/data/recued/server.db.dropped-audit-writes.json',
    );
  });

  it('round-trips a marker and consumes it exactly once', () => {
    const path = join(makeDir(), 'server.db.dropped-audit-writes.json');
    expect(consumeDroppedWritesMarker(path)).toBeNull();
    writeDroppedWritesMarker(path, { dropped: 3, at: 1_700_000_000_000 });
    expect(consumeDroppedWritesMarker(path)).toEqual({ dropped: 3, at: 1_700_000_000_000 });
    // Consumed = deleted — the count surfaces once, never on every boot.
    expect(existsSync(path)).toBe(false);
    expect(consumeDroppedWritesMarker(path)).toBeNull();
  });

  it('overwrite-writes: the marker always holds the latest running total', () => {
    const path = join(makeDir(), 'server.db.dropped-audit-writes.json');
    writeDroppedWritesMarker(path, { dropped: 1, at: 10 });
    writeDroppedWritesMarker(path, { dropped: 2, at: 20 });
    expect(consumeDroppedWritesMarker(path)).toEqual({ dropped: 2, at: 20 });
  });

  it('consumes (deletes) a malformed marker instead of resurfacing it forever', () => {
    const base = makeDir();
    const notJson = join(base, 'a.json');
    writeFileSync(notJson, 'not json');
    expect(consumeDroppedWritesMarker(notJson)).toBeNull();
    expect(existsSync(notJson)).toBe(false);

    const wrongShape = join(base, 'b.json');
    writeFileSync(wrongShape, JSON.stringify({ dropped: 'three' }));
    expect(consumeDroppedWritesMarker(wrongShape)).toBeNull();
    expect(existsSync(wrongShape)).toBe(false);
  });
});

/** R13 T4-6.1 — the marker is the ONLY record that audit rows went missing.
 *
 *  ⛔⛔ SIGNATURES CANNOT COVER THIS. `audit/signing.ts` says so in its own
 *  header: a signature proves ALTERATION of a row that still exists and can
 *  never prove one was REMOVED. Writes refused after drain leave no row at all,
 *  so this sidecar is the entire evidence that the trail has a hole — and it
 *  rides a file, not the store, because the store is the thing that can no
 *  longer record.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18): 14 mutations, 7 survived on 8 tests. */
describe('R13 T4-6.1 — the marker survives the ways it can go wrong', () => {
  it('⛔ a marker write that FAILS does not throw — this runs during shutdown', async () => {
    // ⛔ THE COST OF A THROW HERE IS NOT OBSERVABILITY, IT IS THE SHUTDOWN.
    // The module says the write is "best-effort by construction" because it
    // happens on the close path; an exception escaping it turns a lost count
    // into a failed teardown, and the drop it was recording is then joined by
    // whatever the rest of shutdown had left to do.
    const base = makeDir();
    // A path whose PARENT does not exist — writeFileSync throws ENOENT.
    const unwritable = join(base, 'no-such-dir', 'marker.json');
    expect(() => {
      writeDroppedWritesMarker(unwritable, { dropped: 3, at: 1 });
    }).not.toThrow();
    expect(existsSync(unwritable)).toBe(false);
  });

  it('⛔⛔ an UNREADABLE marker is still consumed, so it cannot resurface every boot', async () => {
    // ⛔ THE CATCH'S OWN `unlinkSync` IS WHAT MAKES THIS TRUE, and it was
    // untested. Without it the boot path finds the same marker on every start
    // and surfaces a stale `audit_writes_dropped` row forever — an alarm that
    // never clears is one nobody reads.
    //
    // ⚠ A MODE-000 FILE IS THE REACHABLE CASE: `readFileSync` throws EACCES
    // while `unlinkSync` still succeeds, because unlink needs write permission
    // on the DIRECTORY, not on the file. Skipped as root, where the read would
    // succeed and the test would prove nothing.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const base = makeDir();
    const markerPath = join(base, 'db.sqlite.dropped-audit-writes.json');
    writeFileSync(markerPath, '{"dropped":3,"at":1}');
    chmodSync(markerPath, 0o000);
    expect(consumeDroppedWritesMarker(markerPath)).toBeNull();
    expect(
      existsSync(markerPath),
      'an unreadable marker survived consumption and will resurface next boot',
    ).toBe(false);
  });

  it('⚠ a DIRECTORY at the marker path is the one shape that cannot be consumed', async () => {
    // ⚠ FOUND BY A FAILING TEST OF MY OWN (2026-09-18). The module says a
    // marker it cannot read "is still consumed (deleted) so it cannot resurface
    // on every boot forever". That holds for every file — but `unlinkSync`
    // cannot remove a DIRECTORY, so a directory at this path defeats both the
    // inline delete and the catch's, and the boot path will meet it again every
    // time.
    //
    // ⇒ Pinned as the CURRENT behaviour, not as desirable: the read still
    // fails closed (`null`, no phantom count), and nothing creates a directory
    // there, so this is a documented edge rather than a defect to fix blind.
    // If it ever needs fixing the change is `rmSync(path, { recursive: true })`
    // in the catch — recorded here so the next reader does not have to
    // rediscover why the claim above has an exception.
    const base = makeDir();
    const markerPath = join(base, 'db.sqlite.dropped-audit-writes.json');
    mkdirSync(markerPath);
    expect(consumeDroppedWritesMarker(markerPath)).toBeNull();
    expect(existsSync(markerPath)).toBe(true);
  });

  it('⛔ each field is checked on its own — a half-shaped marker is not a count', async () => {
    // ⚠ ONE FIELD WRONG AT A TIME, from an otherwise-valid marker, so each
    // check is the only thing that can decide. A single both-fields-wrong
    // fixture passes with either check deleted.
    const base = makeDir();
    for (const [label, body] of [
      ['dropped is a string', '{"dropped":"3","at":1}'],
      ['dropped is absent', '{"at":1}'],
      ['dropped is null', '{"dropped":null,"at":1}'],
      ['at is a string', '{"dropped":3,"at":"1"}'],
      ['at is absent', '{"dropped":3}'],
      ['at is null', '{"dropped":3,"at":null}'],
    ] as const) {
      const markerPath = join(base, `m-${label.replace(/\W+/g, '-')}.json`);
      writeFileSync(markerPath, body);
      expect(consumeDroppedWritesMarker(markerPath), label).toBeNull();
      // ⚠ AND STILL CONSUMED. A marker that parses but does not validate is as
      // permanent as a malformed one if nobody deletes it.
      expect(existsSync(markerPath), `${label}: not consumed`).toBe(false);
    }
  });

  it('⚠ a valid marker returns exactly the two fields, not whatever the file held', async () => {
    // The sidecar is read at boot and turned into an activity row. Passing the
    // parsed object through would let anything on disk ride into that row.
    const base = makeDir();
    const markerPath = join(base, 'extra.json');
    writeFileSync(
      markerPath,
      '{"dropped":7,"at":1736,"injected":"not-a-real-field","action":"spoofed"}',
    );
    const got = consumeDroppedWritesMarker(markerPath);
    expect(got).toStrictEqual({ dropped: 7, at: 1736 });
  });
});

/* ─── Mutation sweep of `audit/dropped-writes-marker.ts`, 2026-09-18 ────────
 *  14 mutations; 12 caught. The two survivors are EQUIVALENT, and both for the
 *  same reason — `consumeDroppedWritesMarker`'s catch does its OWN unlink, so
 *  two guards inside the try are belt to its braces:
 *
 *  1. `unlinkSync` before `JSON.parse` rather than after. Malformed JSON throws
 *     either way, and the catch deletes the file either way. Measured, not
 *     argued: both orderings leave the file gone.
 *  2. The `existsSync` early return. Without it `readFileSync` throws ENOENT
 *     into the same catch, whose unlink then no-ops on a file that was never
 *     there. Same `null`, same empty disk.
 *
 *  ⇒ Both stay: each says what it means, and the catch is a backstop rather
 *  than the intended path. But no test can distinguish them, and the reason is
 *  worth having written down — a future edit that removes the catch's unlink
 *  turns BOTH of these from equivalent into load-bearing at once.
 * ────────────────────────────────────────────────────────────────────────── */

