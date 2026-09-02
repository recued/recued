/** D-178 I-10 — the install-wide anti-replay floor, at the module boundary.
 *
 *  The orchestrator test proves the CONSEQUENCE (realm A binds realm B). These
 *  are the branches that consequence cannot see: that the floor only ever rises,
 *  that the bytes match the format install.sh parses, and that a contended or
 *  unwritable file degrades instead of throwing. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  advanceHostSequenceFloor,
  hostSequenceFloorPathFor,
  readHostSequenceFloor,
} from '../host-sequence-floor.js';

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-floor-unit-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('the install-wide floor only ever rises', () => {
  it('advances an absent floor and writes install.sh\'s exact format', () => {
    withDir((dir) => {
      const p = hostSequenceFloorPathFor(dir);
      expect(advanceHostSequenceFloor(p, 300)).toBe('advanced');
      // ⛔ BYTE-EXACT, NOT "parses as 300". install.sh reads this with
      // `tr -cd '0-9'`, which concatenates the digits of every line — so a
      // second line would not read as a newer value, it would read as one
      // enormous floor that refuses every future release forever.
      expect(readFileSync(p, 'utf-8')).toBe('300\n');
    });
  });

  it('REFUSES to lower a floor that is already higher', () => {
    withDir((dir) => {
      const p = hostSequenceFloorPathFor(dir);
      advanceHostSequenceFloor(p, 300);
      expect(advanceHostSequenceFloor(p, 250)).toBe('unchanged');
      expect(readHostSequenceFloor(p), 'a replay must never be able to lower the floor').toBe(300);
    });
  });

  it('treats an equal sequence as nothing to do', () => {
    withDir((dir) => {
      const p = hostSequenceFloorPathFor(dir);
      advanceHostSequenceFloor(p, 300);
      expect(advanceHostSequenceFloor(p, 300)).toBe('unchanged');
    });
  });

  it('reads a malformed or absent file as 0 rather than throwing', () => {
    withDir((dir) => {
      const p = hostSequenceFloorPathFor(dir);
      expect(readHostSequenceFloor(p), 'absent').toBe(0);
      writeFileSync(p, 'not-a-number\n');
      expect(readHostSequenceFloor(p), 'malformed').toBe(0);
      // ...and a malformed file is not a reason to refuse the advance that fixes it.
      expect(advanceHostSequenceFloor(p, 12)).toBe('advanced');
    });
  });

  it('releases its lock, so a later advance is not wedged by an earlier one', () => {
    withDir((dir) => {
      const p = hostSequenceFloorPathFor(dir);
      expect(advanceHostSequenceFloor(p, 10)).toBe('advanced');
      expect(advanceHostSequenceFloor(p, 20), 'a leaked lock would report contended').toBe('advanced');
      expect(readHostSequenceFloor(p)).toBe(20);
    });
  });
});

describe('it degrades rather than throwing', () => {
  it('reports contended, and writes nothing, while another LIVE process holds the lock', () => {
    withDir((dir) => {
      const p = hostSequenceFloorPathFor(dir);
      advanceHostSequenceFloor(p, 100);
      // A live pid that is not ours — same-pid would be re-entrant and claim.
      writeFileSync(
        `${p}.lock`,
        JSON.stringify({ pid: process.ppid, operation: 'another realm', at: Date.now(), token: 't' }),
      );
      expect(advanceHostSequenceFloor(p, 500)).toBe('contended');
      expect(readHostSequenceFloor(p), 'the holder owns the write; we must not race it').toBe(100);
    });
  });

  it('reports unwritable for a directory that cannot be created', () => {
    // The documented per-realm fallback: a read-only or root-owned prefix.
    const p = join('/proc', 'recued-nonexistent-dir', '.release-sequence');
    expect(advanceHostSequenceFloor(p, 300)).toBe('unwritable');
  });

  it('ignores a sequence that is not a floor candidate', () => {
    withDir((dir) => {
      const p = hostSequenceFloorPathFor(dir);
      expect(advanceHostSequenceFloor(p, 1.5)).toBe('unchanged');
      expect(advanceHostSequenceFloor(p, -1)).toBe('unchanged');
      expect(readHostSequenceFloor(p)).toBe(0);
    });
  });
});
