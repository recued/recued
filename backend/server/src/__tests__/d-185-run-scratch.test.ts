/** D-185 Slice 2 — run-scoped temp lifecycle for `storage: 'temp'` cli output.
 *
 *  A `temp` cli op writes under a deterministic per-run scratch root; the file
 *  survives the producing call (the next step consumes it by `TempFileRef`) and
 *  the whole root is reclaimed at run end. The `temp` backing carries no Gateway
 *  `file.read` gate, so the ONE read into a value channel (the ai-* doc-part) is
 *  CONFINED to the producing run's root — these tests prove that confinement,
 *  the allocate/cleanup lifecycle, and the determinism the producer + janitor
 *  rely on to agree without a threaded handle. */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  allocateRunScratchDir,
  assertPathUnderRunScratch,
  cleanupRunScratch,
  readConfinedTempFile,
  reclaimRunScratchUnlessResumable,
  runScratchRoot,
} from '../execution/run-scratch.js';

// Each test uses a unique run id so concurrent files never collide; everything
// produced lands under `runScratchRoot(run_id)`, reclaimed here.
const runIds: string[] = [];
const freshRun = (label: string): string => {
  const id = `d185-${label}-${runIds.length}`;
  runIds.push(id);
  return id;
};
afterEach(() => {
  for (const id of runIds.splice(0)) cleanupRunScratch(id);
});

describe('D-185 Slice 2 — run-scratch lifecycle', () => {
  it('derives a deterministic per-run root under the OS temp dir', () => {
    const id = freshRun('det');
    const root = runScratchRoot(id);
    expect(root).toBe(runScratchRoot(id)); // deterministic
    expect(root.startsWith(join(tmpdir(), 'recued-run-scratch'))).toBe(true);
    expect(root.endsWith(id)).toBe(true);
  });

  it('flattens a run id carrying separators / traversal tokens to one safe segment', () => {
    // A pathological run id can never escape the scratch parent.
    const root = runScratchRoot('../../etc/passwd');
    expect(root).toBe(join(tmpdir(), 'recued-run-scratch', '______etc_passwd'));
  });

  it('allocateRunScratchDir creates a fresh dir under the run root, distinct per call', () => {
    const id = freshRun('alloc');
    const a = allocateRunScratchDir(id);
    const b = allocateRunScratchDir(id);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.startsWith(runScratchRoot(id))).toBe(true);
  });

  it('allocateRunScratchDir throws without a run scope (no run_id)', () => {
    expect(() => allocateRunScratchDir('')).toThrow(/requires a run scope/);
  });

  it('assertPathUnderRunScratch passes for a file inside the run root', () => {
    const id = freshRun('confine-ok');
    const dir = allocateRunScratchDir(id);
    const f = join(dir, 'out.mp3');
    writeFileSync(f, 'AUDIO');
    expect(() => assertPathUnderRunScratch(f, id)).not.toThrow();
  });

  it('assertPathUnderRunScratch REFUSES a path outside the run root (arbitrary-read guard)', () => {
    const id = freshRun('confine-escape');
    allocateRunScratchDir(id); // ensure the root exists
    const outside = join(mkdtempSync(join(tmpdir(), 'd185-outside-')), 'secret');
    writeFileSync(outside, 'SECRET');
    expect(() => assertPathUnderRunScratch(outside, id)).toThrow(/escapes the run-scratch root/);
  });

  it('assertPathUnderRunScratch + readConfinedTempFile FAIL CLOSED without a run scope (empty run_id)', () => {
    // runScratchRoot('') would resolve to the shared parent under which EVERY
    // run's files live — an empty run_id must never confine to it.
    const id = freshRun('empty-runid');
    const dir = allocateRunScratchDir(id);
    const f = join(dir, 'out.mp3');
    writeFileSync(f, 'X');
    expect(() => assertPathUnderRunScratch(f, '')).toThrow(/requires a run scope/);
    expect(() =>
      readConfinedTempFile({ backing: 'temp', path: f, mime_type: 'audio/mpeg', filename: 'out.mp3' }, ''),
    ).toThrow(/requires a run scope/);
  });

  it('assertPathUnderRunScratch REFUSES when the run produced no scratch root', () => {
    // A temp ref that outlived its run (root already swept) — fail closed.
    const id = freshRun('confine-gone');
    const f = join(mkdtempSync(join(tmpdir(), 'd185-noroot-')), 'x');
    writeFileSync(f, 'x');
    expect(() => assertPathUnderRunScratch(f, id)).toThrow(/no run-scratch root/);
  });

  it('readConfinedTempFile returns base64 bytes + the ref-carried mime/filename', () => {
    const id = freshRun('read');
    const dir = allocateRunScratchDir(id);
    const f = join(dir, 'clip.mp3');
    writeFileSync(f, 'MEDIA');
    const out = readConfinedTempFile(
      { backing: 'temp', path: f, mime_type: 'audio/mpeg', filename: 'clip.mp3' },
      id,
    );
    expect(out).toEqual({
      bytes_b64: Buffer.from('MEDIA').toString('base64'),
      mime_type: 'audio/mpeg',
      filename: 'clip.mp3',
    });
  });

  it('readConfinedTempFile refuses a ref whose path escapes the run root', () => {
    const id = freshRun('read-escape');
    allocateRunScratchDir(id);
    const outside = join(mkdtempSync(join(tmpdir(), 'd185-read-escape-')), 'passwd');
    writeFileSync(outside, 'SECRET');
    expect(() =>
      readConfinedTempFile(
        { backing: 'temp', path: outside, mime_type: 'text/plain', filename: 'passwd' },
        id,
      ),
    ).toThrow(/escapes the run-scratch root/);
  });

  it('cleanupRunScratch removes the whole run root + is idempotent', () => {
    const id = freshRun('cleanup');
    const dir = allocateRunScratchDir(id);
    writeFileSync(join(dir, 'a.mp3'), 'A');
    expect(existsSync(runScratchRoot(id))).toBe(true);
    cleanupRunScratch(id);
    expect(existsSync(runScratchRoot(id))).toBe(false);
    expect(() => cleanupRunScratch(id)).not.toThrow(); // idempotent, root gone
    cleanupRunScratch(''); // no-op on an absent run scope
  });
});

/** ⛔⛔ THE RUN-END RECLAIM HAS ONE EXCEPTION, AND UNTIL NOW NOTHING TESTED IT.
 *
 *  The execute-handler's `finally` reclaims every run's scratch root — EXCEPT a
 *  resumable pause, which continues under the same `run_id` and sweeps later. A
 *  sweep for `resumablePause` found it in three places (two assignments and the
 *  one condition) and in zero tests, so deleting the negation or dropping the
 *  guard as a tidy-up would keep the whole suite green while destroying the temp
 *  output of every run that stops to ask.
 *
 *  🔑 THAT PATH IS NOT AN EDGE CASE FOR ITS CONSUMERS. A records `import` taking
 *  a `csv_ref` is `approval: 'ask'` in all three shipped packs: produce the file
 *  with a cli step, ask the owner, read the bytes on resume. */
describe('D-185 §3.4 — a resumable pause keeps the scratch alive', () => {
  it('KEEPS the run root when the run is resumably paused', () => {
    const id = freshRun('paused');
    const dir = allocateRunScratchDir(id);
    writeFileSync(join(dir, 'converted.csv'), 'Date,Amt\n01-Jan,1\n');
    reclaimRunScratchUnlessResumable(id, true);
    expect(existsSync(runScratchRoot(id))).toBe(true);
    // Not merely "the directory survives" — the ref is still READABLE, which is
    // what the run does when it resumes.
    expect(readConfinedTempFile(
      { backing: 'temp', path: join(dir, 'converted.csv'), mime_type: 'text/csv', filename: 'converted.csv' },
      id,
    ).mime_type).toBe('text/csv');
  });

  it('⚠ and RECLAIMS it on a terminal end — the guard is not just always-keep', () => {
    // Without this arm the assertion above passes on a function that never
    // reclaims anything, which is the vacuous-green shape: a temp ref would then
    // outlive its run, which is the invariant D-185 §3.4 exists to prevent.
    const id = freshRun('terminal');
    const dir = allocateRunScratchDir(id);
    writeFileSync(join(dir, 'converted.csv'), 'Date,Amt\n01-Jan,1\n');
    reclaimRunScratchUnlessResumable(id, false);
    expect(existsSync(runScratchRoot(id))).toBe(false);
    expect(() => readConfinedTempFile(
      { backing: 'temp', path: join(dir, 'converted.csv'), mime_type: 'text/csv', filename: 'converted.csv' },
      id,
    )).toThrow(/must not outlive its run/);
  });
});
