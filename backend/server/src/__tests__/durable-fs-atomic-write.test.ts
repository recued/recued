/** `writeFileAtomicSync` — the one publisher behind the keyfile and the vault
 *  bundle sidecar.
 *
 *  The behaviour under test is the one a real filesystem almost never
 *  exercises: `writeSync` may write FEWER bytes than asked and report it, and
 *  the keyfile writer used to ignore that number entirely. So `writeSync` is
 *  wrapped here to short-write deterministically — without it a passing test
 *  proves only that a small file round-trips, which it did before the fix too.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/** Bytes the next `writeSync` call is allowed to consume, or null to pass
 *  through. Consumed one call at a time so a body can be dribbled out. */
let writeChunkLimit: number | null = null;
/** Force `writeSync` to report zero progress — the refusal case. */
let writeStalls = false;
/** Throw on the Nth `writeSync`, simulating the disk giving out mid-body. */
let failWriteAfterCalls: number | null = null;
let writeCalls = 0;
/** Every temp path the publisher created, in order. Recorded rather than
 *  reconstructed: a sweep test that builds the name itself would pass while the
 *  writer drifted to a different one, which is the failure that matters. */
let createdTemps: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    openSync: ((...args: unknown[]) => {
      const [path, flags] = args;
      if (flags === 'wx' && typeof path === 'string') createdTemps.push(path);
      return (actual.openSync as (...a: unknown[]) => number)(...args);
    }) as unknown as typeof actual.openSync,
    // `writeSync` is overloaded (string form and buffer form) so its
    // `Parameters<>` collapses to one of them; the code under test only uses
    // the buffer form, which is what the cap below narrows to.
    writeSync: ((...args: unknown[]) => {
      writeCalls += 1;
      if (failWriteAfterCalls !== null && writeCalls > failWriteAfterCalls) {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      if (writeStalls) return 0;
      const passThrough = (): number =>
        (actual.writeSync as (...a: unknown[]) => number)(...args);
      if (writeChunkLimit === null) return passThrough();
      const [fd, buffer, offset, length, position] = args;
      if (!Buffer.isBuffer(buffer) || typeof length !== 'number') return passThrough();
      return actual.writeSync(
        fd as number,
        buffer,
        offset as number,
        Math.min(length, writeChunkLimit),
        position as number | null,
      );
    }) as unknown as typeof actual.writeSync,
  };
});

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sweepAtomicWriteTemps, writeFileAtomicSync } from '../durable-fs.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'durable-fs-atomic-'));
  writeChunkLimit = null;
  writeStalls = false;
  failWriteAfterCalls = null;
  writeCalls = 0;
  createdTemps = [];
});

afterEach(() => {
  writeChunkLimit = null;
  writeStalls = false;
  failWriteAfterCalls = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Temp files this publisher leaves behind, if any. */
const strays = (): string[] => readdirSync(dir).filter((f) => f.includes('.tmp.'));

describe('writeFileAtomicSync', () => {
  it('resumes a short write instead of truncating the file', () => {
    const path = join(dir, 'keys.json');
    // 8 KB of distinguishable content, handed out 100 bytes per call.
    const body = JSON.stringify({ server_vault_key_b64: 'k'.repeat(8_000) });
    writeChunkLimit = 100;

    writeFileAtomicSync(path, body);

    expect(readFileSync(path, 'utf8')).toBe(body);
    // Proof the short-write path was actually taken, not bypassed.
    expect(writeCalls).toBeGreaterThan(1);
  });

  it('raises rather than spinning when a write makes no progress', () => {
    const path = join(dir, 'keys.json');
    writeStalls = true;

    expect(() => writeFileAtomicSync(path, 'anything')).toThrow(/short write while publishing/);
    // Nothing published, and no half-written temp holding key material left.
    expect(existsSync(path)).toBe(false);
    expect(strays()).toEqual([]);
  });

  it('leaves no stranded partial temp when the disk fails mid-write', () => {
    const path = join(dir, 'keys.json');
    // Several chunks land, then the filesystem gives out — the shape of an
    // ENOSPC. The old writer's cleanup only wrapped the rename, so a temp
    // holding partial key material survived exactly this case.
    writeChunkLimit = 100;
    failWriteAfterCalls = 3;

    expect(() => writeFileAtomicSync(path, 'x'.repeat(4_000))).toThrow(/ENOSPC/);
    expect(existsSync(path)).toBe(false);
    expect(strays()).toEqual([]);
  });

  it('publishes owner-only, from creation', () => {
    const path = join(dir, 'keys.json');
    writeFileAtomicSync(path, 'secret');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('replaces an existing file in place', () => {
    const path = join(dir, 'keys.json');
    writeFileAtomicSync(path, 'first');
    writeFileAtomicSync(path, 'second');
    expect(readFileSync(path, 'utf8')).toBe('second');
    expect(strays()).toEqual([]);
  });

  it('accepts a Buffer body as well as a string', () => {
    const path = join(dir, 'blob.bin');
    const body = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f]);
    writeFileAtomicSync(path, body);
    expect(readFileSync(path).equals(body)).toBe(true);
  });
});

/** The publisher unlinks its own temp on any failure it lives to see. SIGKILL,
 *  an OOM kill and power loss are the ones it does not, and what they strand is
 *  a 0600 file holding the whole document — for the keyfile in its default mode
 *  the server vault key and both private identity keys, in the clear. */
describe('sweepAtomicWriteTemps', () => {
  /** Strand a temp the way a kill does: the publisher's own name, its content,
   *  and no `catch` ever reached. Recorded from the real writer so the sweep is
   *  matched against the names it actually produces. */
  const strandTempFrom = (path: string): string => {
    writeFileAtomicSync(path, 'the published document');
    const tmp = createdTemps.at(-1)!;
    writeFileSync(tmp, 'a complete keyfile document', { mode: 0o600 });
    return tmp;
  };

  it('reclaims a temp under the exact name the publisher chose', () => {
    const path = join(dir, 'keys.json');
    const stranded = strandTempFrom(path);
    expect(existsSync(stranded)).toBe(true);

    expect(sweepAtomicWriteTemps(dir)).toBe(1);
    expect(existsSync(stranded)).toBe(false);
    // The published file is the point of all this — it must survive the sweep.
    expect(readFileSync(path, 'utf8')).toBe('the published document');
  });

  it('reclaims what several crashes left, across different targets', () => {
    const stranded = [
      strandTempFrom(join(dir, 'keys.json')),
      strandTempFrom(join(dir, 'keys.json')),
      strandTempFrom(join(dir, 'recued.db.server-vault-bundle.json')),
    ];
    // Distinct names, or one crash would have hidden another.
    expect(new Set(stranded).size).toBe(3);

    expect(sweepAtomicWriteTemps(dir)).toBe(3);
    for (const tmp of stranded) expect(existsSync(tmp)).toBe(false);
  });

  it('leaves every other file in the data dir alone', () => {
    const keep = [
      'recued.db',
      'recued.db-wal',
      'keys.json',
      'recued.db.server-vault-bundle.json',
      'recued.db.staging-0123456789abcdef',
      'recued-server.lock',
      // Ends in `.tmp`, but it is the archive's, not a publish of ours.
      'recued-2024-01-01.recued.archive.db.tmp',
      // The CAS publish temp — `sweepOrphans` reaps these inside the shard dirs.
      '.tmp-abcdef0123456789',
      // Close enough to the shape to be worth pinning: no pid, and a nonce of
      // the wrong length.
      'keys.json.tmp.abcdef0123456789',
      'keys.json.tmp.4242.abc',
    ];
    for (const name of keep) writeFileSync(join(dir, name), 'keep me');
    const stranded = strandTempFrom(join(dir, 'keys.json'));

    expect(sweepAtomicWriteTemps(dir)).toBe(1);
    expect(existsSync(stranded)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([...keep].sort());
  });

  it('reports nothing swept for a directory that is not there', () => {
    expect(sweepAtomicWriteTemps(join(dir, 'absent'))).toBe(0);
  });

  it('finds nothing to do after an ordinary publish', () => {
    writeFileAtomicSync(join(dir, 'keys.json'), 'secret');
    expect(sweepAtomicWriteTemps(dir)).toBe(0);
    expect(readdirSync(dir)).toEqual(['keys.json']);
  });
});
