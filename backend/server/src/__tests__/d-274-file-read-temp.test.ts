/** D-274 — `file-read-temp`: a run reads back bytes it just produced, so a view
 *  can draw a file the owner keeps on disk WITHOUT Recued copying it.
 *
 *  The two properties worth pinning are both refusals, because the op returns
 *  file bytes to a recipe and its safety is entirely in what it declines.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  handleFileReadTemp,
  FILE_READ_TEMP_MAX_BYTES,
} from '../collections/file/file-read-temp-handler.js';
import { runScratchRoot } from '../execution/run-scratch.js';

const RUN = 'run-d274-read-temp';
const made: string[] = [];
const seed = (name: string, bytes: Buffer): string => {
  const root = runScratchRoot(RUN);
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  writeFileSync(path, bytes);
  made.push(root);
  return path;
};
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ref = (path: string, over: Record<string, unknown> = {}) => ({
  backing: 'temp', path, mime_type: 'image/jpeg', filename: 'preview.jpg', ...over,
}) as never;

describe('file-read-temp', () => {
  it('returns the bytes of a file THIS run produced', () => {
    const path = seed('preview.jpg', Buffer.from('hello', 'utf8'));
    const out = handleFileReadTemp({ ref: ref(path), run_id: RUN });
    expect(Buffer.from(out.bytes_b64, 'base64').toString('utf8')).toBe('hello');
    expect(out).toMatchObject({ mime_type: 'image/jpeg', filename: 'preview.jpg', size_bytes: 5 });
  });

  it('⛔ refuses a path outside the run scratch root', () => {
    // The whole authorization on a temp backing. A hand-crafted ref naming any
    // file on the host is the failure this op would be if it had no confinement,
    // and it is why the op can be admitted at all: it names nothing this run did
    // not just create.
    expect(() => handleFileReadTemp({ ref: ref('/etc/passwd'), run_id: RUN }))
      .toThrow();
  });

  it("⛔ refuses ANOTHER run's scratch, not just paths outside scratch entirely", () => {
    // ⚠ The sharper case: `/etc/passwd` is refused by almost any check. A sibling
    // run's file is under the SHARED scratch parent, so only a per-run check
    // catches it — and that is the one that matters on a server running many.
    //
    // ⚠ The sibling's file must actually EXIST, or this passes on ENOENT and the
    // confinement check is never consulted. Mutation caught exactly that: with
    // `assertPathUnderRunScratch` neutered, the first version of this test still
    // went green while the other two went red.
    seed('preview.jpg', Buffer.from('mine', 'utf8'));
    const theirRoot = runScratchRoot('run-somebody-else');
    mkdirSync(theirRoot, { recursive: true });
    const theirs = join(theirRoot, 'preview.jpg');
    writeFileSync(theirs, Buffer.from('theirs', 'utf8'));
    made.push(theirRoot);
    expect(readFileSync(theirs, 'utf8')).toBe('theirs');   // it is really there
    expect(() => handleFileReadTemp({ ref: ref(theirs), run_id: RUN })).toThrow();
  });

  it('⛔ refuses an empty run scope rather than resolving to the shared parent', () => {
    const path = seed('preview.jpg', Buffer.from('x', 'utf8'));
    expect(() => handleFileReadTemp({ ref: ref(path), run_id: '' })).toThrow();
  });

  it('⛔ refuses a file past the ceiling — this path puts bytes in step state', () => {
    const path = seed('big.jpg', Buffer.alloc(FILE_READ_TEMP_MAX_BYTES + 1, 7));
    expect(() => handleFileReadTemp({ ref: ref(path, { filename: 'big.jpg' }), run_id: RUN }))
      .toThrow(/ceiling/i);
  });

  it('allows a file exactly AT the ceiling', () => {
    // An off-by-one here would refuse a legitimate file with a confusing error.
    const path = seed('edge.jpg', Buffer.alloc(FILE_READ_TEMP_MAX_BYTES, 7));
    expect(handleFileReadTemp({ ref: ref(path, { filename: 'edge.jpg' }), run_id: RUN }).size_bytes)
      .toBe(FILE_READ_TEMP_MAX_BYTES);
  });
});
